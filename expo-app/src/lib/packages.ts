import { currentAppUserId } from './session';
import { fulfilmentSchemaReady, markFulfilmentSchemaMissing } from './schema';
import { supabase } from './supabase';

// What is left of a package, and booking several of its sessions at once.
//
// A ten-session pack used to book exactly one session; the other nine were a
// number in a counter and the way to use them was to come back nine times.
//
// The counts come from `package_progress`, which derives them from the bookings
// rather than reading a counter. A counter only ever went up -- cancelling a
// session left it incremented, so a cancelled session was gone from the pack
// forever and a client who paid for ten could book nine.

/** One client's use of one package.
 *
 *  `taken + booked + pending + remaining` is the size of the pack. A cancelled
 *  or no-show session is in none of them, which is how it returns to
 *  `remaining`. */
export type PackageProgress = {
  packageId: string;
  clientId: string;
  coachId: string;
  /** The other party: the coach for a client's view, the client for a coach's. */
  withName: string;
  total: number;
  /** Asked for, the coach has not answered. */
  pending: number;
  /** Confirmed and still ahead. */
  booked: number;
  /** Confirmed by both of you. Nothing else counts as had.  */
  taken: number;
  /** Its time has passed and neither of you has said it happened yet. */
  awaitingConfirmation: number;
  remaining: number;
};

/** One session of a package: when, and which slot of the coach's day it is. */
export type SessionSlot = {
  /** ISO instant. */
  at: string;
  /** The coach's own slot label, which is what the server checks their schedule
   *  against. Display text would stop enforcing the day its format changed. */
  label: string;
};

// Same story as the confirmation stamps in bookings.ts: the view gains a
// column with the migration, and selecting it before that refuses the whole
// query rather than degrading. Until then the packs read exactly as they did.
const PROGRESS_COLUMNS_BASE =
  'package_id, client_id, coach_id, total, pending, booked, taken, remaining';
const PROGRESS_COLUMNS_WITH_AWAITING =
  'package_id, client_id, coach_id, total, pending, booked, taken, awaiting_confirmation, remaining';

type ProgressRow = {
  package_id: string;
  client_id: string;
  coach_id: string;
  total: number;
  pending: number;
  booked: number;
  taken: number;
  awaiting_confirmation: number | null;
  remaining: number;
};

const toProgress = (row: ProgressRow, withName: string): PackageProgress => ({
  packageId: row.package_id,
  clientId: row.client_id,
  coachId: row.coach_id,
  withName,
  total: row.total,
  pending: row.pending,
  booked: row.booked,
  taken: row.taken,
  awaitingConfirmation: row.awaiting_confirmation ?? 0,
  remaining: row.remaining,
});

/** Names for the other party, in one round trip rather than one each. */
async function namesFor(ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  const { data, error } = await supabase.from('users').select('id, name').in('id', unique);
  if (error) throw error;
  return new Map(((data ?? []) as { id: string; name: string | null }[])
    .map((row) => [row.id, row.name ?? 'Member']));
}

/** The packages this account has bought, and what is left of each. */
async function readProgress(column: 'client_id' | 'coach_id', me: string) {
  const read = (columns: string) =>
    supabase.from('package_progress').select(columns).eq(column, me);
  let { data, error } = await read(
    fulfilmentSchemaReady() ? PROGRESS_COLUMNS_WITH_AWAITING : PROGRESS_COLUMNS_BASE,
  );
  // 42703 is "column does not exist" -- the migration has not run here yet.
  if (error && error.code === '42703') {
    markFulfilmentSchemaMissing();
    ({ data, error } = await read(PROGRESS_COLUMNS_BASE));
  }
  if (error) throw error;
  return (data ?? []) as unknown as ProgressRow[];
}

export async function fetchMyPackages(): Promise<PackageProgress[]> {
  const me = await currentAppUserId();
  const rows = await readProgress('client_id', me);
  const names = await namesFor(rows.map((row) => row.coach_id));
  return rows.map((row) => toProgress(row, names.get(row.coach_id) ?? 'Coach'));
}

/** The packages this coach's clients are working through.
 *
 *  Same view, read from the other side. `book_party_read` on bookings already
 *  says a booking is visible to its coach, and the view runs with the reader's
 *  own permissions -- so this is the coach's half of exactly the same rows the
 *  client sees, not a second calculation that could disagree. */
export async function fetchClientPackages(): Promise<PackageProgress[]> {
  const me = await currentAppUserId();
  const rows = await readProgress('coach_id', me);
  const names = await namesFor(rows.map((row) => row.client_id));
  return rows.map((row) => toProgress(row, names.get(row.client_id) ?? 'Member'));
}

/** Book several sessions of one package, or none of them.
 *
 *  One call rather than a loop: a loop would leave somebody with four of the
 *  five they chose and no way to tell which one failed. The server takes the
 *  whole list in one transaction and checks each slot against the coach's
 *  hours, their days off and what is left of the pack.
 *
 *  Returns how many were booked.
 */
export async function bookPackageSessions(
  coachId: string,
  packageId: string,
  slots: SessionSlot[],
): Promise<number> {
  const me = await currentAppUserId();
  if (!slots.length) throw new Error('Pick at least one session.');
  // The server refuses this too; saying it here makes the message a sentence.
  if (coachId === me) throw new Error('You cannot book a session with yourself.');
  const { data, error } = await supabase.rpc('book_package_sessions', {
    p_coach: coachId,
    p_package_id: packageId,
    p_slots: slots.map((slot) => ({ at: slot.at, label: slot.label })),
  });
  if (error) throw error;
  return typeof data === 'number' ? data : slots.length;
}

/** "3 booked · 1 waiting · 2 done · 4 left", skipping whatever is zero.
 *
 *  Zeroes are noise: a pack nobody has cancelled from has no pending sessions,
 *  and printing "0 waiting" invites the reader to wonder what it means. */
export function progressSummary(progress: PackageProgress): string {
  const parts: string[] = [];
  if (progress.booked) parts.push(`${progress.booked} booked`);
  if (progress.pending) parts.push(`${progress.pending} waiting`);
  if (progress.taken) parts.push(`${progress.taken} done`);
  parts.push(`${progress.remaining} left`);
  return parts.join(' · ');
}

// ---- asking to cancel a package --------------------------------------------
//
// A pack is paid for in one go, directly to the coach -- BOOK'D never touches
// the money. So this cannot be a refund button; it is a request to a person,
// and what comes back is their answer plus the amount they agree to hand back.
//
// Every screen that shows that amount has to say the app is recording what two
// people agreed rather than moving anybody's money.

export type CancellationStatus = 'requested' | 'offered' | 'approved' | 'rejected' | 'withdrawn';

export type PackageCancellation = {
  id: string;
  packageId: string;
  clientId: string;
  coachId: string;
  /** The other party, whichever side of it this account is on. */
  withName: string;
  reason: string | null;
  status: CancellationStatus;
  /** What the coach agreed to give back. Null until they answer -- and 0 is a
   *  real answer, not a missing one. */
  refundCents: number | null;
  createdAt: string;
};

const CANCEL_COLUMNS = 'id, package_id, client_id, coach_id, reason, status, refund_cents, created_at';

type CancelRow = {
  id: string; package_id: string; client_id: string; coach_id: string;
  reason: string | null; status: string; refund_cents: number | null; created_at: string;
};

const asStatus = (value: string): CancellationStatus =>
  value === 'approved' || value === 'rejected' || value === 'withdrawn' ? value : 'requested';

const toCancellation = (row: CancelRow, withName: string): PackageCancellation => ({
  id: row.id,
  packageId: row.package_id,
  clientId: row.client_id,
  coachId: row.coach_id,
  withName,
  reason: row.reason,
  status: asStatus(row.status),
  refundCents: row.refund_cents,
  createdAt: row.created_at,
});

/** Every cancellation this account is part of, either side.
 *
 *  One read rather than two: `cancel_parties_read` already returns exactly the
 *  rows where this account is the client or the coach, so filtering again in
 *  the client would only duplicate the policy. */
export async function fetchCancellations(): Promise<PackageCancellation[]> {
  const me = await currentAppUserId();
  const { data, error } = await supabase
    .from('package_cancellations').select(CANCEL_COLUMNS).order('created_at', { ascending: false });
  if (error) throw error;
  const rows = (data ?? []) as CancelRow[];
  const names = await namesFor(rows.map((row) => (row.client_id === me ? row.coach_id : row.client_id)));
  return rows.map((row) =>
    toCancellation(row, names.get(row.client_id === me ? row.coach_id : row.client_id) ?? 'Member'));
}

/** Ask the coach to cancel a package. */
export async function requestCancellation(
  coachId: string,
  packageId: string,
  reason?: string,
): Promise<void> {
  const me = await currentAppUserId();
  // status and refund are left to their defaults: the insert policy refuses any
  // other value, which is what stops a client writing the coach's answer.
  const { error } = await supabase.from('package_cancellations').insert({
    client_id: me,
    coach_id: coachId,
    package_id: packageId,
    reason: reason?.trim() || null,
  });
  if (error) {
    // The partial unique index means one open request per pack. 23505 here is
    // "you already asked", not the generic "that slot is taken".
    if ((error as { code?: string }).code === '23505') {
      throw new Error('You have already asked to cancel this package.');
    }
    throw error;
  }
}

/** Take the request back before it is answered. */
export async function withdrawCancellation(id: string): Promise<void> {
  await currentAppUserId();
  // Selecting the row back is the point. This is a policy-gated UPDATE, and a
  // policy that matches nothing is not an error -- it changes zero rows and
  // reports success. That is how "Take it back" came to look like it worked
  // while leaving the request exactly where it was.
  const { data, error } = await supabase
    .from('package_cancellations')
    .update({ status: 'withdrawn' })
    .eq('id', id)
    .select('id');
  if (error) throw error;
  if (!data || data.length === 0) {
    throw new Error('That request could not be taken back. It may have already been answered.');
  }
}

/** The coach's answer. An approval carries the amount they are giving back --
 *  0 included, because "nothing" is a decision and the server refuses an
 *  approval with no amount at all. */
export async function decideCancellation(
  id: string,
  status: 'approved' | 'rejected',
  refundCents?: number,
): Promise<void> {
  await currentAppUserId();
  if (status === 'approved' && (refundCents === undefined || !Number.isFinite(refundCents))) {
    throw new Error('Say how much you are giving back, even if it is nothing.');
  }
  const { error } = await supabase.rpc('decide_package_cancellation', {
    p_id: id,
    p_status: status,
    p_refund_cents: status === 'approved' ? Math.max(0, Math.round(refundCents as number)) : null,
  });
  if (error) throw error;
}

/** What a coach might reasonably give back: the unused share of what was paid.
 *
 *  A suggestion, not a rule. It is the arithmetic the coach would do anyway,
 *  and having it in front of them beats a blank box -- but it is their money
 *  and their call, so the field stays editable. */
/** What each of these packages sells for, by id.
 *
 *  The client's own screens know how many sessions are left but not what the
 *  pack cost -- `package_progress` reports the counts and the coach's price
 *  lives on `packages`, which the Discover list already reads. Without this the
 *  client's half of a refund negotiation opened at $0 while the coach's opened
 *  at the real figure. */
export async function fetchPackagePrices(ids: string[]): Promise<Map<string, number>> {
  const unique = [...new Set(ids)].filter(Boolean);
  if (unique.length === 0) return new Map();
  const { data, error } = await supabase
    .from('packages').select('id, price_cents').in('id', unique);
  if (error) throw error;
  return new Map((data ?? []).map((row) => [row.id as string, (row.price_cents as number) ?? 0]));
}

/** Is this request still being argued over?
 *
 *  'offered' counts: a figure is on the table and the unused session count is
 *  what that figure is a share of, so the pack has to stay frozen. The two
 *  screens that freeze packs disagreed about this until they both called here.
 */
export function isOpenRequest(status: CancellationStatus): boolean {
  return status === 'requested' || status === 'offered';
}

/** Has any session on this pack been confirmed by both parties?
 *
 *  The pivot for what a cancellation costs. Nothing confirmed means nothing was
 *  delivered, so the pack comes back in full and there is nothing to negotiate.
 *  One confirmed session and the two of them have to agree on a figure. */
export function hasFulfilledSession(progress: PackageProgress): boolean {
  // Before the migration there is no free-cancel RPC to call and `taken` still
  // carries its old meaning, so every cancellation keeps going to the
  // negotiation -- which is exactly what it did before this feature.
  if (!fulfilmentSchemaReady()) return true;
  return progress.taken > 0;
}

/** Give back a pack nobody has had a session out of.
 *
 *  No request and no offer: the server refuses if a single session on the pack
 *  was confirmed by both sides, so the client's screen is not the thing
 *  deciding what a refund is worth. */
export async function cancelUnusedPackage(
  coachId: string,
  packageId: string,
): Promise<{ refundCents: number; moved: boolean }> {
  const { data, error } = await supabase.rpc('cancel_unused_package', {
    p_coach: coachId,
    p_package: packageId,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  // `moved`: held money was sent back to the card. A pack bought before
  // payments was paid to the coach directly, so nothing moves through BOOK'D.
  return { refundCents: (row?.refund_cents as number) ?? 0, moved: row?.moved === true };
}

export function suggestedRefundCents(progress: PackageProgress, packPriceCents: number): number {
  if (progress.total <= 0) return 0;
  return Math.max(0, Math.round((packPriceCents * progress.remaining) / progress.total));
}

// ---- settling on the amount -------------------------------------------------
//
// A cancellation used to be answered once: the coach approved with a figure and
// the client could take it or have asked for nothing. That is a verdict, not an
// agreement -- and since the money moves directly between the two of them, an
// agreement is what it has to be.
//
// Either side puts a figure on the table; the other accepts or counters. One
// offer stands at a time, and whoever did not make it is the one who can accept
// it, so nobody approves their own refund.

export type RefundOffer = {
  id: string;
  requestId: string;
  offeredBy: string;
  amountCents: number;
  note: string | null;
  createdAt: string;
  /** True when this account made it -- so the UI knows whose move it is. */
  mine: boolean;
};

/** The exchange on one request, oldest first, so it reads like a conversation.
 *
 *  Ordered by `seq` rather than `created_at`: that column defaults to now(),
 *  which is the transaction's start time, so two offers written in one
 *  transaction tie and "the latest" becomes whichever came back first. */
export async function fetchRefundOffers(requestId: string): Promise<RefundOffer[]> {
  const me = await currentAppUserId();
  const { data, error } = await supabase
    .from('package_refund_offers')
    .select('id, request_id, offered_by, amount_cents, note, created_at, seq')
    .eq('request_id', requestId)
    .order('seq');
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
    id: String(row.id),
    requestId: String(row.request_id),
    offeredBy: String(row.offered_by),
    amountCents: Number(row.amount_cents) || 0,
    note: (row.note as string) ?? null,
    createdAt: String(row.created_at),
    mine: row.offered_by === me,
  }));
}

/** Put a figure on the table. Refused by the server if your own offer is
 *  already standing -- offering twice in a row is not negotiating. */
export async function offerRefund(requestId: string, cents: number, note?: string): Promise<void> {
  await currentAppUserId();
  if (!Number.isFinite(cents) || cents < 0) throw new Error('Offer an amount of 0 or more.');
  const { error } = await supabase.rpc('offer_package_refund', {
    p_request: requestId,
    p_cents: Math.round(cents),
    p_note: note?.trim() || null,
  });
  if (error) throw error;
}

/** Take the standing offer. Only the side that did not make it may. */
export async function acceptRefund(requestId: string): Promise<void> {
  await currentAppUserId();
  const { error } = await supabase.rpc('accept_package_refund', { p_request: requestId });
  if (error) throw error;
}

/** Whose move it is, for a request with offers on it.
 *
 *  Returns null when there is nothing to answer -- either no offer yet, or the
 *  standing one is this account's own and they are waiting. */
export function standingOffer(offers: RefundOffer[]): RefundOffer | null {
  const last = offers[offers.length - 1];
  if (!last) return null;
  return last.mine ? null : last;
}
