// An event as a place of its own, not a line on a community's wall.
//
// Its own description, picture, gallery, price, and its own answer to "who can
// see this" and "who can bring someone". A closed community can run an open
// event; an open community can run one that is invitation only.
//
// Event ids are real uuids -- unlike communities, which the store keys by slug
// (see refColumn in ./communities) -- so nothing here has to resolve anything.

import { PickedAvatar } from './avatars';
import { cleanNote } from './availability';
import { currentAppUserId } from './bookings';
import {
  eventSchemaReady, isMissingColumn, isMissingFunction, isMissingTable,
  markEventSchemaMissing,
} from './schema';
import { supabase } from './supabase';

export type EventPrivacy = 'public' | 'members' | 'invite';
export type InvitePolicy = 'managers' | 'members';
export type AttendancePayment = 'not_required' | 'pending' | 'paid' | 'refunded';

export type EventDetail = {
  id: string;
  communityId: string;
  type: 'meetup' | 'event';
  title: string;
  whenLabel: string;
  location: string;
  description: string;
  coverUrl: string | null;
  privacy: EventPrivacy;
  invitePolicy: InvitePolicy;
  feeCents: number;
  attendeesCount: number;
  /** When it starts, if set; leaving is refused once it has. */
  startsAt: string | null;
};

export type EventPhoto = {
  id: string;
  url: string;
  path: string | null;
  caption: string | null;
  position: number;
};

export type Invitation = {
  id: string;
  eventId: string;
  userId: string;
  name: string;
  avatarUrl: string | null;
  note: string | null;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
};

/** What the reader is told about each choice. The words live here so the
 *  editor and the event page cannot describe the same setting differently. */
export const PRIVACY_CHOICES: { key: EventPrivacy; label: string; blurb: string }[] = [
  { key: 'public', label: 'Anyone', blurb: 'Anyone on BOOK’D can find this event and come.' },
  { key: 'members', label: 'Members', blurb: 'Only people in this community can see it.' },
  { key: 'invite', label: 'Invited only', blurb: 'Hidden unless you have been invited. Admins and moderators always see it.' },
];

export const INVITE_CHOICES: { key: InvitePolicy; label: string; blurb: string }[] = [
  { key: 'managers', label: 'Admins & moderators', blurb: 'Only the people who run this community can invite.' },
  { key: 'members', label: 'Any member', blurb: 'Anyone in the community can invite anyone on the app.' },
];

const FULL = 'id, community_id, type, title, starts_at, when_label, location, attendees_count, '
  + 'description, cover_url, privacy, invite_policy, fee_cents';
const BASE = 'id, community_id, type, title, starts_at, when_label, location, attendees_count';

function detailFrom(row: Record<string, unknown>): EventDetail {
  return {
    id: row.id as string,
    communityId: row.community_id as string,
    type: (row.type as 'meetup' | 'event') ?? 'meetup',
    title: (row.title as string) ?? '',
    whenLabel: (row.when_label as string) ?? '',
    location: (row.location as string) ?? '',
    description: (row.description as string) ?? '',
    coverUrl: (row.cover_url as string) ?? null,
    // Every event that predates the column is public, which is what it was:
    // event_read used to be `using (true)`.
    privacy: (row.privacy as EventPrivacy) ?? 'public',
    invitePolicy: (row.invite_policy as InvitePolicy) ?? 'managers',
    feeCents: (row.fee_cents as number) ?? 0,
    attendeesCount: (row.attendees_count as number) ?? 0,
    startsAt: (row.starts_at as string) ?? null,
  };
}

export async function fetchEvent(eventId: string): Promise<EventDetail | null> {
  const read = async (full: boolean) => (full
    ? supabase.from('events').select(FULL).eq('id', eventId).maybeSingle()
    : supabase.from('events').select(BASE).eq('id', eventId).maybeSingle());

  let { data, error } = await read(eventSchemaReady());
  if (error && isMissingColumn(error)) {
    markEventSchemaMissing();
    ({ data, error } = await read(false));
  }
  if (error) throw error;
  return data ? detailFrom(data as Record<string, unknown>) : null;
}

/** Change an event. Admins and moderators both run events, so this is gated on
 *  can_manage_community rather than on is_community_admin.
 *
 *  Only what changed is sent. A PATCH naming a column the caller never edited
 *  is still a write to that column as far as the per-column grants are
 *  concerned, and one ungranted column refuses the whole statement. */
export async function updateEvent(
  eventId: string,
  changes: Partial<Pick<EventDetail,
    'title' | 'whenLabel' | 'location' | 'description' | 'coverUrl'
    | 'privacy' | 'invitePolicy' | 'feeCents'>>,
): Promise<void> {
  const fields: Record<string, unknown> = {};
  if (changes.title !== undefined) {
    const title = changes.title.trim();
    if (!title) throw new Error('An event needs a title.');
    fields.title = title;
  }
  if (changes.whenLabel !== undefined) fields.when_label = changes.whenLabel.trim() || null;
  if (changes.location !== undefined) fields.location = changes.location.trim() || 'TBD';
  if (eventSchemaReady()) {
    if (changes.description !== undefined) fields.description = cleanNote(changes.description) ?? null;
    if (changes.coverUrl !== undefined) fields.cover_url = changes.coverUrl;
    if (changes.privacy !== undefined) fields.privacy = changes.privacy;
    if (changes.invitePolicy !== undefined) fields.invite_policy = changes.invitePolicy;
    if (changes.feeCents !== undefined) {
      if (!Number.isFinite(changes.feeCents) || changes.feeCents < 0) {
        throw new Error('A fee cannot be negative.');
      }
      fields.fee_cents = Math.round(changes.feeCents);
    }
  }
  if (!Object.keys(fields).length) return;

  const { data, error } = await supabase
    .from('events').update(fields).eq('id', eventId).select('id');
  if (error) {
    if (isMissingColumn(error)) {
      markEventSchemaMissing();
      throw new Error('That setting is not available yet. The database is still being updated.');
    }
    if ((error as { code?: string }).code === '42501') {
      throw new Error('This database does not allow that field to be changed yet.');
    }
    throw error;
  }
  // A policy-gated UPDATE that matches no row is not an error -- it changes
  // nothing and reports success, which is what a member editing somebody
  // else's event would see.
  if (!data?.length) {
    throw new Error('Only an admin or moderator of this community can change this event.');
  }
}

// --- The gallery -------------------------------------------------------------

export const MAX_EVENT_PHOTOS = 12;

export async function fetchEventPhotos(eventId: string): Promise<EventPhoto[]> {
  if (!eventSchemaReady()) return [];
  const { data, error } = await supabase
    .from('event_photos').select('id, url, path, caption, position')
    .eq('event_id', eventId).order('position', { ascending: true });
  if (error) {
    if (isMissingTable(error)) { markEventSchemaMissing(); return []; }
    throw error;
  }
  return (data ?? []) as EventPhoto[];
}

export async function addEventPhoto(
  eventId: string, picked: PickedAvatar, caption?: string,
): Promise<EventPhoto> {
  const existing = await fetchEventPhotos(eventId);
  if (existing.length >= MAX_EVENT_PHOTOS) {
    throw new Error(`This gallery holds ${MAX_EVENT_PHOTOS} pictures. Remove one first.`);
  }
  // Keyed <event_id>/<timestamp>: the storage policy reads the first path
  // segment to decide whether the uploader runs that event's community.
  const path = `${eventId}/${Date.now()}`;
  const bucket = supabase.storage.from('events');
  const uploaded = await bucket.upload(path, picked.bytes, {
    contentType: picked.mimeType, upsert: false,
  });
  if (uploaded.error) throw uploaded.error;

  const url = bucket.getPublicUrl(path).data.publicUrl;
  const { data, error } = await supabase
    .from('event_photos')
    .insert({ event_id: eventId, url, path, caption: cleanNote(caption) ?? null, position: existing.length })
    .select('id, url, path, caption, position')
    .single();
  // The row is what makes the file a picture in this gallery. Without it the
  // upload is litter.
  if (error) {
    await bucket.remove([path]).catch(() => {});
    throw error;
  }
  return data as EventPhoto;
}

export async function removeEventPhoto(photo: EventPhoto): Promise<void> {
  const { error } = await supabase.from('event_photos').delete().eq('id', photo.id);
  if (error) throw error;
  if (photo.path) await supabase.storage.from('events').remove([photo.path]).catch(() => {});
}

export async function setEventCover(eventId: string, picked: PickedAvatar): Promise<string> {
  const path = `${eventId}/cover-${Date.now()}`;
  const bucket = supabase.storage.from('events');
  const uploaded = await bucket.upload(path, picked.bytes, {
    contentType: picked.mimeType, upsert: true,
  });
  if (uploaded.error) throw uploaded.error;
  const url = bucket.getPublicUrl(path).data.publicUrl;
  await updateEvent(eventId, { coverUrl: url });
  return url;
}

// --- Invitations -------------------------------------------------------------

/** Whether I may invite somebody to this event. Mirrors can_invite_to_event:
 *  the event's policy decides, and either way the inviter must be IN the
 *  community -- a stranger cannot populate somebody else's event. */
export function canInvite(
  invitePolicy: InvitePolicy, myRole: 'owner' | 'admin' | 'moderator' | 'member' | null,
): boolean {
  if (!myRole) return false;
  if (invitePolicy === 'members') return true;
  return myRole === 'owner' || myRole === 'admin' || myRole === 'moderator';
}

export async function fetchInvitations(eventId: string): Promise<Invitation[]> {
  if (!eventSchemaReady()) return [];
  const { data, error } = await supabase
    .from('event_invitations')
    .select('id, event_id, user_id, note, status, created_at, user:users!event_invitations_user_id_fkey(name, avatar_url)')
    .eq('event_id', eventId)
    .order('created_at', { ascending: false });
  if (error) {
    if (isMissingTable(error)) { markEventSchemaMissing(); return []; }
    throw error;
  }
  return ((data ?? []) as unknown as {
    id: string; event_id: string; user_id: string; note: string | null;
    status: Invitation['status']; created_at: string;
    user: { name: string; avatar_url: string | null } | null;
  }[]).map((row) => ({
    id: row.id,
    eventId: row.event_id,
    userId: row.user_id,
    name: row.user?.name ?? 'Someone',
    avatarUrl: row.user?.avatar_url ?? null,
    note: row.note,
    status: row.status,
    createdAt: row.created_at,
  }));
}

export async function inviteToEvent(
  eventId: string, userId: string, note?: string,
): Promise<void> {
  const me = await currentAppUserId();
  if (me === userId) throw new Error('You are already going to be there.');
  const { error } = await supabase.from('event_invitations').insert({
    event_id: eventId, user_id: userId, invited_by: me, note: cleanNote(note) ?? null,
  });
  if (error) {
    // The unique index: inviting the same person twice is one invitation, not
    // a way to message them repeatedly.
    if ((error as { code?: string }).code === '23505') {
      throw new Error('They have already been invited.');
    }
    if (isMissingTable(error)) {
      markEventSchemaMissing();
      throw new Error('Invitations are not available yet.');
    }
    // The insert policy checks can_invite_to_event, so a refusal here means
    // this event does not let this person invite.
    if ((error as { code?: string }).code === '42501') {
      throw new Error('This event does not let you invite people.');
    }
    throw error;
  }
}

export async function withdrawInvitation(invitationId: string): Promise<void> {
  const { error } = await supabase.from('event_invitations').delete().eq('id', invitationId);
  if (error) throw error;
}

/** The invited person's answer. Declining keeps the row, so the event still
 *  knows they were asked and does not ask again. */
export async function respondToInvitation(
  invitationId: string, accept: boolean,
): Promise<void> {
  const { data, error } = await supabase
    .from('event_invitations')
    .update({ status: accept ? 'approved' : 'rejected', responded_at: new Date().toISOString() })
    .eq('id', invitationId)
    .select('id');
  if (error) throw error;
  if (!data?.length) throw new Error('That invitation is no longer yours to answer.');
}

export async function fetchMyInvitations(): Promise<Invitation[]> {
  if (!eventSchemaReady()) return [];
  const me = await currentAppUserId().catch(() => null);
  if (!me) return [];
  const { data, error } = await supabase
    .from('event_invitations')
    .select('id, event_id, user_id, note, status, created_at')
    .eq('user_id', me).eq('status', 'pending')
    .order('created_at', { ascending: false });
  if (error) {
    if (isMissingTable(error)) { markEventSchemaMissing(); return []; }
    return [];
  }
  return ((data ?? []) as {
    id: string; event_id: string; user_id: string; note: string | null;
    status: Invitation['status']; created_at: string;
  }[]).map((row) => ({
    id: row.id,
    eventId: row.event_id,
    userId: row.user_id,
    name: '',
    avatarUrl: null,
    note: row.note,
    status: row.status,
    createdAt: row.created_at,
  }));
}

// --- Saying yes --------------------------------------------------------------

export type RsvpOutcome = {
  attendees: number;
  payment: AttendancePayment;
  owedCents: number;
};

/** RSVP, which for a paid event leaves the attendance pending until the money
 *  arrives. There is no payment processor yet, so a pending RSVP stays pending
 *  -- the caller must say so rather than showing the person as going. */
export async function rsvpToEvent(eventId: string, going: boolean): Promise<RsvpOutcome> {
  const { data, error } = await supabase.rpc('rsvp_to_event', {
    p_event: eventId, p_going: going,
  });
  if (error) {
    if (isMissingFunction(error)) {
      markEventSchemaMissing();
      // The old RPC cannot express a fee, which is correct while no event can
      // have one.
      const legacy = await supabase.rpc('set_event_attendance', {
        p_event: eventId, p_going: going,
      });
      if (legacy.error) throw legacy.error;
      return {
        attendees: (legacy.data as number) ?? 0,
        payment: 'not_required',
        owedCents: 0,
      };
    }
    throw error;
  }
  const row = (Array.isArray(data) ? data[0] : data) as
    { attendees?: number; payment?: AttendancePayment; owed_cents?: number } | null;
  return {
    attendees: row?.attendees ?? 0,
    payment: row?.payment ?? 'not_required',
    owedCents: row?.owed_cents ?? 0,
  };
}

/** "€15" from 1500. Whole units when it divides evenly, because a fee of
 *  "€15.00" reads like a form and "€15" reads like a price. */
export function feeLabel(cents: number, currency = '$'): string {
  if (cents <= 0) return 'Free';
  return cents % 100 === 0
    ? `${currency}${cents / 100}`
    : `${currency}${(cents / 100).toFixed(2)}`;
}

/** Delete an event and everything hanging off it.
 *
 *  Admins and moderators both, like every other event action -- the community
 *  runs its events, and the RPC checks that rather than trusting this call. */
export async function deleteEvent(eventId: string): Promise<void> {
  const { error } = await supabase.rpc('delete_event', { p_event: eventId });
  if (error) {
    if (isMissingFunction(error)) {
      markEventSchemaMissing();
      throw new Error('Deleting an event is not available yet.');
    }
    throw error;
  }
}
