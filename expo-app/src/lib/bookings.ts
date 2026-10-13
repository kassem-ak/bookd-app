// Bookings data-access for the signed-in client.
//
// `bookings` holds both sides of every session and RLS (`book_party_read`) lets
// either party read the row, so an unfiltered select would mix the sessions you
// booked with the ones you coach. The explicit client_id filter is what makes
// this "My bookings".
import { decidePartnerSession, fetchPartnerSessions, PartnerSession } from './partners';
import {
  fulfilmentSchemaReady, isMissingColumn, isMissingTable, markFulfilmentSchemaMissing,
  markRatingsSchemaMissing, ratingsSchemaReady,
} from './schema';
import { currentAppUserId, ensureAppSession } from './session';
import { supabase } from './supabase';

// The client ships ahead of its migration here. The first read tries the new
// shape, falls back to the old one and remembers -- see ./schema. Until the
// migration lands the app behaves exactly as it did before: nobody is asked to
// confirm anything, and a package cancellation always goes to the negotiation.
const BOOKING_COLUMNS_BASE =
  'id, coach_id, scheduled_for, slot_label, status, total_cents, coach:users!bookings_coach_id_fkey(name)';
const BOOKING_COLUMNS_WITH_STAMPS =
  'id, coach_id, scheduled_for, slot_label, status, total_cents, '
  + 'coach_confirmed_at, client_confirmed_at, coach:users!bookings_coach_id_fkey(name)';

// Exactly the live `booking_status` enum — never widen or invent members here.
export type BookingStatus = 'pending' | 'confirmed' | 'cancelled' | 'completed' | 'no_show';

/** What kind of session this is. Two tables, one list -- a coach booking is
 *  paid and cancelled through `bookings`, a partner session is free and
 *  answered through `decide_partner_session`, and the card has to know which
 *  one it is holding. */
export type SessionKind = 'coach' | 'partner';

export type MyBooking = {
  id: string;
  kind: SessionKind;
  /** The other person, whichever side of it this account is on. */
  withId: string;
  withName: string;
  scheduledFor: string;
  slotLabel: string | null;
  /** Partner statuses are mapped onto this for display -- see `toPartnerStatus`.
   *  The enum itself is never widened: it mirrors the live `booking_status`. */
  status: BookingStatus;
  totalCents: number;
  /** True only for a partner invitation waiting on this account. */
  needsAnswer: boolean;
  /** Did the coach say this happened? */
  coachConfirmed: boolean;
  /** Did the client? A session is only `completed` once both have, because the
   *  coach is the one party who gains by saying it happened. */
  clientConfirmed: boolean;
};

/** How a past session ended, which is the only thing worth filtering an
 *  archive by. Everything else -- who, when, what it cost -- is on the card. */
export { ratingsSchemaReady };

export type PastOutcome = 'completed' | 'cancelled' | 'unconfirmed';

export function pastOutcome(booking: MyBooking): PastOutcome {
  if (booking.status === 'cancelled') return 'cancelled';
  if (booking.status === 'completed') return 'completed';
  // Its time went by and nobody said whether it happened. Neither finished nor
  // called off, and the one group a person actually has to act on.
  return 'unconfirmed';
}

/** A session whose time has passed and which is still waiting on somebody to
 *  say it took place. Partner sessions are free and settle nothing, so they
 *  are never asked about. */
export function awaitsConfirmation(booking: MyBooking, now = Date.now()): boolean {
  // Nothing is asked for until the database can record the answer.
  if (!fulfilmentSchemaReady()) return false;
  if (booking.kind !== 'coach') return false;
  if (booking.status !== 'pending' && booking.status !== 'confirmed') return false;
  const startsAt = Date.parse(booking.scheduledFor);
  return !Number.isNaN(startsAt) && startsAt <= now;
}

export type PackageBalance = {
  id: string;
  coachName: string;
  label: string;
  used: number;
  total: number;
  expiresOn: string | null;
};

export type MyBookings = { upcoming: MyBooking[]; past: MyBooking[] };

// PostgREST returns an embedded to-one relation as an object, but the generated
// types model it as either shape depending on the join, so normalise once.
type Related<T> = T | T[] | null | undefined;

function firstRelated<T>(value: Related<T>): T | undefined {
  return Array.isArray(value) ? value[0] : (value ?? undefined);
}

type CoachName = { name?: string | null };

type BookingRow = {
  id: string;
  coach_id: string;
  scheduled_for: string;
  slot_label: string | null;
  status: BookingStatus;
  total_cents: number | null;
  coach_confirmed_at?: string | null;
  client_confirmed_at?: string | null;
  coach?: Related<CoachName>;
};

type BalanceRow = {
  id: string;
  label: string | null;
  used: number | null;
  total: number | null;
  expires_on: string | null;
  coach?: Related<CoachName>;
};

// Re-exported so the many call sites that reach for it here keep working; it
// now lives in session.ts, next to ensureAppSession, because partners.ts needs
// it too and this file now imports partners.ts.
export { currentAppUserId } from './session';

const STATUS_LABEL: Record<BookingStatus, string> = {
  pending: 'Pending',
  confirmed: 'Confirmed',
  cancelled: 'Cancelled',
  completed: 'Completed',
  no_show: 'No-show',
};

export function bookingStatusLabel(status: BookingStatus) {
  return STATUS_LABEL[status] ?? status;
}

// `guard_booking_status_transition` lets a client move only pending/confirmed
// to cancelled, so the button must not be offered anywhere else.
/** Pending or confirmed, and not yet started: the server refuses a cancel once it has. */
export function canCancel(status: BookingStatus, scheduledFor?: string | null, now = Date.now()) {
  if (scheduledFor && Date.parse(scheduledFor) <= now) return false;
  return status === 'pending' || status === 'confirmed';
}

// Money is stored in cents and was charged in cents. Print the exact amount:
// drop the decimals only when there genuinely are none.
export function formatCents(cents: number) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(cents));
  const rem = abs % 100;
  const whole = (abs - rem) / 100;
  return `${sign}$${whole}${rem === 0 ? '' : `.${String(rem).padStart(2, '0')}`}`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Hand-rolled rather than Intl: `toLocaleString` options are unreliable on
// Hermes across platforms, and the board's format is fixed ("Thu 09 · 6:30 PM").
export function formatSessionWhen(booking: Pick<MyBooking, 'scheduledFor' | 'slotLabel'>) {
  const at = new Date(booking.scheduledFor);
  if (Number.isNaN(at.getTime())) return booking.slotLabel ?? 'Time to be confirmed';
  const hours = at.getHours();
  const period = hours >= 12 ? 'PM' : 'AM';
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  const minutes = String(at.getMinutes()).padStart(2, '0');
  return `${WEEKDAYS[at.getDay()]} ${String(at.getDate()).padStart(2, '0')} · ${hour12}:${minutes} ${period}`;
}

export function formatExpiry(expiresOn: string | null) {
  if (!expiresOn) return null;
  const on = new Date(expiresOn);
  if (Number.isNaN(on.getTime())) return null;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `Valid until ${months[on.getMonth()]} ${on.getDate()}`;
}

function toBooking(row: BookingRow): MyBooking {
  return {
    id: row.id,
    kind: 'coach',
    withId: row.coach_id,
    withName: firstRelated(row.coach)?.name ?? 'Coach',
    scheduledFor: row.scheduled_for,
    slotLabel: row.slot_label,
    status: row.status,
    totalCents: row.total_cents ?? 0,
    needsAnswer: false,
    coachConfirmed: (row.coach_confirmed_at ?? null) !== null,
    clientConfirmed: (row.client_confirmed_at ?? null) !== null,
  };
}

/** Partner sessions have their own four statuses. Rather than widen
 *  `BookingStatus` -- which mirrors a live Postgres enum and must keep doing so
 *  -- they are mapped onto the nearest booking status for display only.
 *
 *  'declined' becomes 'cancelled' because that is what it means to the person
 *  reading the list: the session is not happening. The distinction between
 *  "they said no" and "someone called it off" lives in notifications, which is
 *  where it is actionable. */
function toPartnerStatus(status: PartnerSession['status']): BookingStatus {
  if (status === 'accepted') return 'confirmed';
  if (status === 'declined' || status === 'cancelled') return 'cancelled';
  return 'pending';
}

function toPartnerBooking(session: PartnerSession): MyBooking {
  return {
    id: session.id,
    kind: 'partner',
    withId: session.withId,
    withName: session.withName,
    scheduledFor: session.scheduledFor,
    slotLabel: session.slotLabel,
    status: toPartnerStatus(session.status),
    // Free by definition. The card prints "Free" rather than "$0", which reads
    // like a price someone forgot to set.
    totalCents: 0,
    needsAnswer: session.status === 'proposed' && !session.mine,
    coachConfirmed: false,
    clientConfirmed: false,
  };
}

/**
 * Upcoming = still live (pending/confirmed) and not yet past its start time.
 * Everything else — cancelled, completed, no-show, or simply elapsed — is past,
 * so a session the coach forgot to close out still leaves the Upcoming list.
 *
 * Coach bookings and free partner sessions are merged here rather than in the
 * screen. They are two tables with two sets of rules, and a training session is
 * a training session to the person looking at the list — a partner session that
 * only appeared in notifications was a session you had agreed to and could not
 * find.
 */
export async function fetchMyBookings(): Promise<MyBookings> {
  const clientId = await currentAppUserId();
  // users exposes only the non-sensitive columns; asking for more is refused.
  const read = (columns: string) => supabase
    .from('bookings')
    .select(columns)
    .eq('client_id', clientId)
    .order('scheduled_for', { ascending: false });

  let { data, error } = await read(
    fulfilmentSchemaReady() ? BOOKING_COLUMNS_WITH_STAMPS : BOOKING_COLUMNS_BASE,
  );
  // 42703 is "column does not exist": the migration has not been applied to
  // this database yet. Every other error is a real one and still throws.
  if (error && fulfilmentSchemaReady() && error.code === '42703') {
    markFulfilmentSchemaMissing();
    ({ data, error } = await read(BOOKING_COLUMNS_BASE));
  }
  if (error) throw error;

  // A partner-session read that fails must not take the coach bookings down
  // with it: they are independent, and half a list beats an error screen.
  let partners: PartnerSession[] = [];
  try {
    partners = await fetchPartnerSessions();
  } catch {
    partners = [];
  }

  const sessions = [
    ...((data ?? []) as unknown as BookingRow[]).map(toBooking),
    ...partners.map(toPartnerBooking),
  ];

  const now = Date.now();
  const upcoming: MyBooking[] = [];
  const past: MyBooking[] = [];
  for (const booking of sessions) {
    const startsAt = new Date(booking.scheduledFor).getTime();
    const live = booking.status === 'pending' || booking.status === 'confirmed';
    if (live && (Number.isNaN(startsAt) || startsAt >= now)) upcoming.push(booking);
    else past.push(booking);
  }
  // Sorted here rather than relying on the query: two sources cannot be ordered
  // by one ORDER BY. Next session first, most recent history first.
  upcoming.sort((a, b) => Date.parse(a.scheduledFor) - Date.parse(b.scheduledFor));
  past.sort((a, b) => Date.parse(b.scheduledFor) - Date.parse(a.scheduledFor));
  return { upcoming, past };
}

/** Cancel or decline, whichever this session is.
 *
 *  One entry point so the card does not have to know that a coach booking is a
 *  column update guarded by a trigger and a partner session is an RPC that
 *  decides who may say what. */
/** What somebody thought of the other party, once the session was over.
 *
 *  `stars` is attitude and everybody leaves it. `skillStars` is the coach's
 *  second read on a trainee and nobody else gives one. `feedback` is private
 *  between the two of them -- it is not on `reviews`, which is public, but in
 *  its own table with its own rule. */
export type SessionRating = {
  sessionId: string;
  /** The account that left it. */
  authorId: string;
  subjectId: string;
  stars: number;
  skillStars: number | null;
  /** Only ever populated for the two parties. Null when there is none, and
   *  null for everybody else because the row is not readable by them. */
  feedback: string | null;
};

/** Every rating either party left on these sessions, and any private note
 *  this account is allowed to read.
 *
 *  Two reads rather than a join: the note lives in its own table precisely
 *  because it has a different rule about who may see it, and a join would
 *  quietly make one query's failure the other's. A database that has not had
 *  the migration yet returns nothing rather than taking the archive down.  */
export async function fetchSessionRatings(sessionIds: string[]): Promise<SessionRating[]> {
  const ids = [...new Set(sessionIds)].filter(Boolean);
  if (ids.length === 0) return [];
  const me = await currentAppUserId();

  const reviews = await supabase
    .from('reviews')
    .select('booking_id, author_id, subject_id, stars, skill_stars')
    .in('booking_id', ids);
  // The migration has not run here. An archive with no ratings on it is still
  // an archive; a thrown error is not. The codes are in lib/schema.ts because
  // the obvious guess for a missing table is wrong.
  if (reviews.error) {
    if (isMissingColumn(reviews.error) || isMissingTable(reviews.error)) {
      // Nothing to read, and nothing to write either: the form that would
      // write it is hidden until this comes back true.
      markRatingsSchemaMissing();
      return [];
    }
    throw reviews.error;
  }

  const notes = new Map<string, string>();
  const feedback = await supabase
    .from('session_feedback')
    .select('session_id, author_id, body')
    .in('session_id', ids);
  if (!feedback.error) {
    for (const row of (feedback.data ?? []) as { session_id: string; author_id: string; body: string }[]) {
      notes.set(`${row.session_id}:${row.author_id}`, row.body);
    }
  } else if (!isMissingColumn(feedback.error) && !isMissingTable(feedback.error)) {
    throw feedback.error;
  }

  type ReviewRow = {
    booking_id: string; author_id: string; subject_id: string;
    stars: number; skill_stars: number | null;
  };
  return ((reviews.data ?? []) as unknown as ReviewRow[]).map((row) => ({
    sessionId: row.booking_id,
    authorId: row.author_id,
    subjectId: row.subject_id,
    stars: row.stars,
    skillStars: row.skill_stars ?? null,
    feedback: notes.get(`${row.booking_id}:${row.author_id}`) ?? null,
  })).filter((r) => r.authorId === me || r.subjectId === me);
}

/** Leave a rating on a session you were in.
 *
 *  The server decides who the subject is from who is asking, refuses a session
 *  that has not happened or was called off, and refuses a skill rating or a
 *  private note from anybody who was not the coach. */
export async function rateSession(input: {
  sessionId: string;
  kind: SessionKind;
  stars: number;
  skillStars?: number | null;
  feedback?: string | null;
}): Promise<void> {
  await ensureAppSession();
  const { error } = await supabase.rpc('rate_session', {
    p_session: input.sessionId,
    p_stars: input.stars,
    p_skill_stars: input.skillStars ?? null,
    p_feedback: input.feedback?.trim() ? input.feedback.trim() : null,
    p_kind: input.kind,
  });
  if (error) throw error;
}

/** Say this session happened.
 *
 *  One call for either side: the server works out which stamp is yours from
 *  who is asking, and moves the session to `completed` only when both stamps
 *  are on it. Nothing here can confirm on somebody else's behalf. */
export async function confirmFulfilled(bookingId: string): Promise<void> {
  await ensureAppSession();
  const { error } = await supabase.rpc('confirm_session_fulfilled', { p_booking: bookingId });
  if (error) throw error;
}

export async function cancelSession(booking: MyBooking): Promise<void> {
  if (booking.kind === 'partner') {
    await decidePartnerSession(booking.id, booking.needsAnswer ? 'declined' : 'cancelled');
    return;
  }
  await cancelBooking(booking.id);
}

/** Accept a partner's invitation from the bookings list. */
export async function acceptSession(booking: MyBooking): Promise<void> {
  await decidePartnerSession(booking.id, 'accepted');
}

export async function fetchMyPackageBalances(): Promise<PackageBalance[]> {
  const clientId = await currentAppUserId();
  const { data, error } = await supabase
    .from('client_package_balances')
    .select('id, label, used, total, expires_on, coach:users!client_package_balances_coach_id_fkey(name)')
    .eq('client_id', clientId);
  if (error) throw error;

  return ((data ?? []) as unknown as BalanceRow[]).map((row) => ({
    id: row.id,
    coachName: firstRelated(row.coach)?.name ?? 'Coach',
    label: row.label ?? 'Session pack',
    used: row.used ?? 0,
    total: row.total ?? 0,
    expiresOn: row.expires_on,
  }));
}

/**
 * Cancels one of the signed-in client's bookings. Only `status` is grantable on
 * `bookings`, and the guard trigger rejects anything but pending/confirmed →
 * cancelled. Selecting the row back is deliberate: RLS turns a forbidden update
 * into a silent zero-row success, and `.single()` turns that into an error
 * rather than a lie on screen.
 */
export async function cancelBooking(bookingId: string): Promise<BookingStatus> {
  await ensureAppSession();
  const { data, error } = await supabase
    .from('bookings')
    .update({ status: 'cancelled' })
    .eq('id', bookingId)
    .select('id, status')
    .single();
  if (error) throw error;
  return (data as { status: BookingStatus }).status;
}
