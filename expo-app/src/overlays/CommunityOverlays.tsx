import React, { useEffect, useState } from 'react';
import { Image, Text, View } from 'react-native';
import { CheckoutPanel } from '../components/CheckoutPanel';
import { CommunityFields } from '../components/CommunityFields';
import { MissingSubject, OverlayHeader, OverlayScaffold } from '../components/Overlay';
import {
  Avatar, Button, Card, Chip, ConfirmSheet, Field, Icon, IconButton, MicroBadge, Row,
  SectionHeading, Segmented, StripedPlaceholder, VoltButton,
} from '../components/ui';
import { usePaymentConfig } from '../components/usePaymentConfig';
import {
  EventDetail, EventPhoto, feeLabel, fetchEvent, fetchEventPhotos, rsvpToEvent,
} from '../lib/events';
import { paymentsOn } from '../lib/payments';
import { CommunityRole, EventSuggestion, isMeetup } from '../state/models';
import * as D from '../state/sampleData';
import { eventDayOptions, isExplicit, useStore } from '../state/store';
import { alpha, useTheme } from '../theme';

const roleLabel: Record<CommunityRole, string> = { ADMIN: 'Admin', MODERATOR: 'Moderator', MEMBER: 'Member' };

export function CommunityDetailOverlay() {
  const { c, t } = useTheme();
  const s = useStore();
  const cm = s.communityById(s.communityId);
  if (!cm) return <MissingSubject title="Community" message="This community is no longer listed." onBack={s.closeOverlay} />;
  const evs = s.allEvents().filter((e) => e.communityId === cm.id);
  const role = s.currentCommunityRole(cm.id);
  const canModerate = s.canModerateCommunity(cm.id);
  const suggestions = s.eventSuggestions.filter((item) => item.communityId === cm.id);

  return (
    <OverlayScaffold header={<OverlayHeader title="Community" onBack={s.closeOverlay} />}>
      <View style={{ paddingHorizontal: 18 }}>
        <Card style={{ padding: 15 }}>
          <Row gap={14} style={{ alignItems: 'flex-start' }}>
            <Avatar initials={cm.code} size={64} radius={17} bg={cm.tint} />
            <View style={{ flex: 1 }}>
              <Row gap={8} style={{ flexWrap: 'wrap' }}>
                <Text style={[t.overlayTitle, { color: c.txt }]}>{cm.sport}</Text>
                {cm.official && <MicroBadge label="Official" bg={alpha(c.volt, 0.14)} fg={c.accent} />}
                <RoleBadge role={role} />
              </Row>
              <Text style={[t.caption, { color: c.txt3, marginTop: 3 }]}>{cm.members} members</Text>
            </View>
          </Row>
          <Text style={[t.bodySm, { color: c.txt2, marginTop: 12 }]}>{s.communityAbout(cm.id)}</Text>
          {canModerate && (
            <Button label="Edit details" icon="edit-2" onPress={s.openEditCommunity}
              style={{ marginTop: 12 }} />
          )}
        </Card>

        <Row style={{ marginTop: 22, marginBottom: 11, justifyContent: 'space-between' }}>
          <SectionHeading>Events</SectionHeading>
          <Button label={canModerate ? 'Create' : 'Suggest event'} icon="plus"
            onPress={canModerate ? s.openCreateEvent : s.openSuggestEvent} />
        </Row>
        <View style={{ gap: 10 }}>
          {evs.map((ev) => (
            <Card key={ev.id} onPress={() => s.openEvent(ev.id, 'community')} style={{ padding: 14 }}>
              <Row style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <View style={{ flex: 1, paddingRight: 10 }}>
                  <MicroBadge label={ev.type} bg={isMeetup(ev) ? alpha(c.volt, 0.12) : alpha(c.amber, 0.2)} fg={isMeetup(ev) ? c.accent : c.amberText} />
                  <Text style={[t.name, { color: c.txt, marginTop: 6 }]}>{ev.title}</Text>
                  <Text style={[t.bodySm, { color: c.txt2, marginTop: 1 }]}>{ev.whenLabel} - {ev.loc}</Text>
                </View>
                <Text style={[t.caption, { color: c.txt3 }]}>{ev.attendees} going</Text>
              </Row>
            </Card>
          ))}
        </View>

        {suggestions.length > 0 && (
          <>
            <SectionHeading style={{ marginTop: 22, marginBottom: 11 }}>Event suggestions</SectionHeading>
            <View style={{ gap: 10 }}>
              {suggestions.map((item) => (
                <SuggestionCard key={item.id} suggestion={item} canApprove={canModerate && item.status === 'PENDING'} onApprove={() => s.approveEventSuggestion(item.id)} />
              ))}
            </View>
          </>
        )}

        {/* The Roles roster and the "Local groups" list were dropped for release:
            both rendered a hard-coded set of invented members and sub-groups.
            Restore each once a real members / sub-groups table exists. */}
      </View>
    </OverlayScaffold>
  );
}

export function EventDetailOverlay() {
  const { c, t } = useTheme();
  const s = useStore();
  const ev = s.allEvents().find((item) => item.id === s.eventId);
  const going = ev ? s.goingEvents.includes(ev.id) : false;

  // The parts of an event that live on the row rather than in the store's
  // list: what it is about, what it costs, who can see it, and its pictures.
  // Read here so a failure costs this section and not the whole page.
  const [detail, setDetail] = useState<EventDetail | null>(null);
  const [photos, setPhotos] = useState<EventPhoto[]>([]);
  const [withdrawing, setWithdrawing] = useState(false);
  const paymentConfig = usePaymentConfig();
  const eventTakesPayment = paymentsOn(paymentConfig, 'event') && (detail?.feeCents ?? 0) > 0;
  const [paying, setPaying] = useState(false);
  const [rsvpError, setRsvpError] = useState<string | null>(null);
  const evId = ev?.id ?? null;
  useEffect(() => {
    if (!evId) { setDetail(null); setPhotos([]); return; }
    let active = true;
    void (async () => {
      const found = await fetchEvent(evId).catch(() => null);
      if (!active) return;
      setDetail(found);
      if (!found) { setPhotos([]); return; }
      const gallery = await fetchEventPhotos(found.id).catch(() => [] as EventPhoto[]);
      if (active) setPhotos(gallery);
    })();
    return () => { active = false; };
  }, [evId]);

  const manages = s.canModerateCommunity(s.communityId);
  if (!ev) return <MissingSubject title="Event" message="This event is no longer listed." onBack={() => s.set('overlay', s.returnTo)} />;
  return (
    <OverlayScaffold
      header={<OverlayHeader title={ev.type} onBack={() => s.set('overlay', s.returnTo)}
        trailing={manages ? (
          <IconButton icon="edit-2" accessibilityLabel="Edit this event"
            onPress={() => s.set('overlay', 'manageEvent')} />
        ) : undefined} />}
      bottomBar={
        <View style={{ backgroundColor: c.bg, borderTopColor: c.line, borderTopWidth: 1, padding: 16 }}>
          {/* A byte-for-byte copy of VoltButton with no accessibilityRole --
              the most important control in the overlay was invisible to
              assistive tech. */}
          {/* A fee is said out loud next to the button that commits to it.
              BOOK'D cannot take the money, so the button must not imply it
              has been taken. */}
          {(detail?.feeCents ?? 0) > 0 && (
            <Text style={[t.bodySm, { color: c.amberText, marginBottom: 10 }]}>
              {eventTakesPayment
                ? `${feeLabel(detail!.feeCents)} per person, paid now and held by BOOK'D until the event.`
                : `${feeLabel(detail!.feeCents)} per person, settled with the organiser directly.`}
            </Text>
          )}
          {paying && (
            <View style={{ marginBottom: 12 }}>
              <CheckoutPanel onPaid={() => { setPaying(false); void s.toggleGoing(ev.id); }} />
            </View>
          )}
          {rsvpError && <Text accessibilityRole="alert" style={[t.bodySm, { color: c.danger, marginBottom: 10 }]}>{rsvpError}</Text>}
          <Button
            label={going ? "You're going" : (detail?.feeCents ?? 0) > 0 ? `I'm going · ${feeLabel(detail!.feeCents)}` : "I'm going"}
            icon={going ? 'check' : 'user-plus'}
            tone={going ? 'secondary' : 'primary'}
            full
            height={52}
            accessibilityLabel={going
              ? `You are going to ${ev.title}. Press to change your mind.`
              : `Say you are going to ${ev.title}`}
            onPress={() => {
              if (going) { setWithdrawing(true); return; }
              if (!eventTakesPayment) { void s.toggleGoing(ev.id); return; }
              setRsvpError(null);
              void rsvpToEvent(ev.id, true)
                .then((outcome) => { if (outcome.payment === 'pending') setPaying(true); })
                .catch((e) => setRsvpError(e instanceof Error ? e.message : 'Could not save your RSVP.'));
            }}
          />
          {/* Only withdrawing asks. Saying yes to an event is yours alone to
              undo, but taking the place back reaches the organiser's headcount
              and cannot be put right by pressing again if it filled. */}
          <ConfirmSheet
            visible={withdrawing}
            title="Not going any more?"
            body="Your place is given up and the organiser sees you are not coming."
            confirmLabel="I'm not going"
            confirmIcon="user-minus"
            onConfirm={() => { setWithdrawing(false); s.toggleGoing(ev.id); }}
            onCancel={() => setWithdrawing(false)}
          />
        </View>
      }
    >
      <View style={{ paddingHorizontal: 18 }}>
        {detail?.coverUrl ? (
          <Image source={{ uri: detail.coverUrl }} accessibilityIgnoresInvertColors
            accessibilityLabel={`${ev.title} cover`}
            style={{ width: '100%', height: 180, borderRadius: 18, backgroundColor: c.surface }}
            resizeMode="cover" />
        ) : (
          <StripedPlaceholder caption="" height={180} radius={18} />
        )}
        <Row gap={8} style={{ marginTop: 14, flexWrap: 'wrap', alignItems: 'center' }}>
          <MicroBadge label={ev.type} bg={isMeetup(ev) ? alpha(c.volt, 0.12) : alpha(c.amber, 0.2)} fg={isMeetup(ev) ? c.accent : c.amberText} />
          {/* Only worth saying when it is not the default. "Anyone" on every
              event is noise; "Invited only" is the whole point of the row. */}
          {detail && detail.privacy !== 'public' && (
            <MicroBadge
              label={detail.privacy === 'members' ? 'Members only' : 'Invited only'}
              bg={c.surface2} fg={c.txt2}
            />
          )}
          {(detail?.feeCents ?? 0) > 0 && (
            <MicroBadge label={feeLabel(detail!.feeCents)} bg={alpha(c.amber, 0.2)} fg={c.amberText} />
          )}
        </Row>
        <Text style={[t.pageTitle, { fontSize: 22, color: c.txt, marginTop: 10 }]}>{ev.title}</Text>
        <View style={{ gap: 12, marginTop: 16 }}>
          <Row gap={12}><Icon name="calendar" size={18} color={c.accent} /><Text style={[t.body, { color: c.soft }]}>{ev.whenLabel}</Text></Row>
          <Row gap={12}><Icon name="map-pin" size={18} color={c.accent} /><Text style={[t.body, { color: c.soft }]}>{ev.loc}</Text></Row>
          <Row gap={12}><Icon name="user" size={18} color={c.accent} /><Text style={[t.body, { color: c.soft }]}>Hosted by {ev.host}</Text></Row>
          <Row gap={12}><Icon name="users" size={18} color={c.accent} /><Text style={[t.body, { color: c.soft }]}>{ev.attendees} going</Text></Row>
        </View>

        {!!detail?.description && (
          <Text style={[t.bodyLg, { color: c.soft, lineHeight: 22, marginTop: 16 }]}>
            {detail.description}
          </Text>
        )}

        {photos.length > 0 && (
          <Row style={{ flexWrap: 'wrap', gap: 10, marginTop: 16 }}>
            {photos.map((photo) => (
              <View key={photo.id} style={{
                flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 96, maxWidth: '32%',
                aspectRatio: 1, borderRadius: 12, overflow: 'hidden', backgroundColor: c.surface,
              }}>
                <Image source={{ uri: photo.url }} accessibilityIgnoresInvertColors
                  accessibilityLabel={photo.caption ?? `${ev.title} picture`}
                  style={{ width: '100%', height: '100%' }} resizeMode="cover" />
              </View>
            ))}
          </Row>
        )}
      </View>
    </OverlayScaffold>
  );
}

export function CreateEventOverlay() {
  const { c, t } = useTheme();
  const s = useStore();
  const blocked = isExplicit(s.newTitle);
  const named = s.newTitle.trim().length > 0 && s.newLoc.trim().length > 0;
  const canCreate = named && !blocked && s.canModerateCommunity(s.newSport);
  if (!s.canModerateCommunity(s.newSport)) return <EventSuggestionOverlay />;
  if (s.evtCreated) {
    return (
      <OverlayScaffold header={<OverlayHeader title="Create event" onBack={() => s.set('overlay', 'community')} />}>
        <SuccessBody title="Event created" body="Your meetup is live in the community. Members nearby can now RSVP." />
      </OverlayScaffold>
    );
  }
  return (
    <OverlayScaffold
      header={<OverlayHeader title="Create event" onBack={() => s.set('overlay', 'community')} />}
      bottomBar={<View style={{ padding: 16, backgroundColor: c.bg }}><VoltButton label={blocked ? 'Edit blocked content to continue' : canCreate ? 'Create event' : 'Add a title and a place'} enabled={canCreate} onPress={s.submitEvent} /></View>}
    >
      <EventForm blocked={blocked} blockedCopy="Contains blocked content. Edit it to continue; nothing has been sent for review." />
    </OverlayScaffold>
  );
}

export function EventSuggestionOverlay() {
  const { c } = useTheme();
  const s = useStore();
  const blocked = isExplicit(s.newTitle);
  const canSend = s.newTitle.trim().length > 0 && s.newLoc.trim().length > 0 && !blocked;
  if (s.eventSuggested) {
    return (
      <OverlayScaffold header={<OverlayHeader title="Suggest event" onBack={() => s.set('overlay', 'community')} />}>
        <SuccessBody title="Suggestion sent" body="Admins and moderators can approve it for the community calendar." />
      </OverlayScaffold>
    );
  }
  return (
    <OverlayScaffold
      header={<OverlayHeader title="Suggest event" onBack={() => s.set('overlay', 'community')} />}
      bottomBar={<View style={{ padding: 16, backgroundColor: c.bg }}><VoltButton label={blocked ? 'Edit blocked content to continue' : canSend ? 'Send suggestion' : 'Add a title and a place'} enabled={canSend} onPress={s.submitEventSuggestion} /></View>}
    >
      <EventForm blocked={blocked} blockedCopy="Contains blocked content. Edit it to continue; nothing has been sent for review." />
    </OverlayScaffold>
  );
}

// Starting a community.
//
// The same form the settings screen shows, not a cut-down one. It used to ask
// for a name and nothing else, so you made the community and then had to go
// and find the settings to say what sport it was about, who could join and what
// it was for -- and most never did, which is why the list filled with crews
// that were a name and a blank description.
//
// The picture and the gallery are the two things that genuinely cannot be set
// here: both upload into storage under the community's own uuid and the bucket
// policy checks you administer it, so the row has to exist first. That is why
// the success step goes on to the settings screen rather than stopping.
export function StartCommunityOverlay() {
  const { c, t } = useTheme();
  const s = useStore();
  const draft = s.commDraft;
  const blocked = isExplicit(draft.name) || isExplicit(draft.about);
  const canCreate = draft.name.trim().length > 0 && !blocked;
  const busy = s.writeBusy === 'community-create';

  if (s.commCreated) {
    return (
      <OverlayScaffold
        header={<OverlayHeader title="Start community" onBack={() => s.set('overlay', 'community')} />}
        bottomBar={(
          <View style={{ padding: 16, backgroundColor: c.bg, gap: 10 }}>
            <VoltButton
              label="Add a picture and a gallery"
              icon="image"
              onPress={() => s.set('overlay', 'editCommunity')}
            />
            <Button label="Not now" full onPress={() => s.set('overlay', 'community')} />
          </View>
        )}
      >
        <SuccessBody
          title="Community created"
          body={'You are the owner, and everything you filled in is saved. '
            + 'The one thing left is the pictures — those need the community to exist first, '
            + 'which it now does.'}
        />
      </OverlayScaffold>
    );
  }

  return (
    <OverlayScaffold
      header={<OverlayHeader title="Start community" subtitle="You will be its owner" onBack={s.closeOverlay} />}
      bottomBar={(
        <View style={{ padding: 16, backgroundColor: c.bg }}>
          <VoltButton
            icon="users"
            busy={busy}
            busyLabel="Creating…"
            label={blocked
              ? 'Edit blocked content to continue'
              : canCreate ? 'Create community' : 'Name it first'}
            enabled={canCreate && !busy}
            onPress={s.submitCommunity}
          />
        </View>
      )}
    >
      <View style={{ paddingHorizontal: 18, gap: 8, paddingBottom: 24 }}>
        <CommunityFields
          value={draft}
          busy={busy}
          onChange={(next) => s.set('commDraft', next)}
        />
        <Text style={[t.caption, { color: c.txt3, marginTop: 14 }]}>
          A picture and the five-photo gallery come next, once the community exists.
        </Text>
        {/* The official-entity form is deliberately not offered. Creating a
            community above is real -- it writes to the server -- but that form
            only appends to the in-memory store, so the application is lost on
            restart and no admin ever receives it. Better to offer one door that
            works than two where the second quietly discards the application.
            Restore this link once official requests have a table and a queue. */}
      </View>
    </OverlayScaffold>
  );
}

// Asking for a sport or hobby that is not listed.
//
// A name and nothing else. Where it belongs -- sport or hobby, and which
// category -- is decided by the AI engine when the request is filed, so the
// member is never asked to sort it. If the engine cannot run, it lands under
// Other and the admin who approves it places it.
export function RequestOverlay() {
  const { c } = useTheme();
  const s = useStore();
  const blocked = isExplicit(s.reqName);
  const canSend = s.reqName.trim().length > 0 && !blocked && s.writeBusy !== 'sport-request';

  if (s.reqSent) {
    return (
      <OverlayScaffold header={<OverlayHeader title="Request a sport" onBack={s.closeOverlay} />}>
        <SuccessBody
          title="Request sent"
          body={s.reqPlaced
            ? `It is in the admin review queue, under ${s.reqPlaced}.`
            : 'It is being sorted into a category, then it goes to the admins.'}
        />
      </OverlayScaffold>
    );
  }
  return (
    <OverlayScaffold
      header={<OverlayHeader title="Request a sport" onBack={s.closeOverlay} />}
      bottomBar={<View style={{ padding: 16, backgroundColor: c.bg }}><VoltButton
        label={canSend || !s.reqName.trim() ? (s.reqName.trim() ? 'Send request to admins' : 'Name it first') : 'Edit blocked content to continue'}
        busy={s.writeBusy === 'sport-request'} busyLabel="Sending…"
        enabled={canSend} onPress={s.submitRequest} /></View>}
    >
      <View style={{ paddingHorizontal: 18, gap: 11 }}>
        <SectionHeading>Name</SectionHeading>
        <Field value={s.reqName} onChange={(v) => s.set('reqName', v)} placeholder="Padel, Salsa, Bouldering..." />
      </View>
    </OverlayScaffold>
  );
}

function EventForm({ blocked, blockedCopy }: { blocked: boolean; blockedCopy: string }) {
  const { c, t } = useTheme();
  const s = useStore();
  return (
    <View style={{ paddingHorizontal: 18 }}>
      <SectionHeading style={{ marginBottom: 11 }}>Type</SectionHeading>
      <Segmented options={[{ key: 'Meetup', label: 'Meetup' }, { key: 'Event', label: 'Event' }]} selected={s.newType} onSelect={(k) => s.set('newType', k)} fontSize={13} pad={9} />

      <SectionHeading style={{ marginTop: 22, marginBottom: 11 }}>Day</SectionHeading>
      <Row style={{ flexWrap: 'wrap' }} gap={8}>
        {eventDayOptions().map((d, i) => <Chip key={d.label} label={d.label} active={s.newDay === i} onPress={() => s.set('newDay', i)} />)}
      </Row>

      <SectionHeading style={{ marginTop: 22, marginBottom: 11 }}>Time</SectionHeading>
      <Row style={{ flexWrap: 'wrap' }} gap={8}>
        {D.slotDefs.map((slot, i) => <Chip key={slot} label={slot} active={s.newTime === i} onPress={() => s.set('newTime', i)} />)}
      </Row>

      <SectionHeading style={{ marginTop: 22, marginBottom: 11 }}>Title</SectionHeading>
      <Field value={s.newTitle} onChange={(v) => s.set('newTitle', v)} placeholder="Saturday long run..." />

      <SectionHeading style={{ marginTop: 22, marginBottom: 11 }}>Where</SectionHeading>
      <Field value={s.newLoc} onChange={(v) => s.set('newLoc', v)} placeholder="Corniche, Beirut..." />
      {blocked && <Text style={[t.caption, { color: c.danger, marginTop: 8 }]}>{blockedCopy}</Text>}
    </View>
  );
}

function SuggestionCard({ suggestion, canApprove, onApprove }: { suggestion: EventSuggestion; canApprove: boolean; onApprove: () => void }) {
  const { c, t } = useTheme();
  return (
    <Card style={{ padding: 14 }}>
      <Row style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <View style={{ flex: 1, paddingRight: 10 }}>
          <Row gap={8} style={{ flexWrap: 'wrap' }}>
            <MicroBadge label={suggestion.type} bg={alpha(c.volt, 0.12)} fg={c.accent} />
            <MicroBadge label={suggestion.status === 'PENDING' ? 'Pending' : 'Approved'} bg={suggestion.status === 'PENDING' ? c.surface2 : alpha(c.volt, 0.14)} fg={suggestion.status === 'PENDING' ? c.txt2 : c.accent} />
          </Row>
          <Text style={[t.name, { color: c.txt, marginTop: 8 }]}>{suggestion.title}</Text>
          <Text style={[t.bodySm, { color: c.txt2, marginTop: 1 }]}>{suggestion.whenLabel} - {suggestion.requestedBy}</Text>
        </View>
        {canApprove && (
          <Button label="Approve" icon="check" tone="primary" height={44} onPress={onApprove} />
        )}
      </Row>
    </Card>
  );
}

function RoleBadge({ role }: { role: CommunityRole }) {
  const { c } = useTheme();
  const elevated = role !== 'MEMBER';
  return <MicroBadge label={roleLabel[role]} bg={elevated ? alpha(c.amber, 0.2) : c.surface2} fg={elevated ? c.amberText : c.txt2} />;
}

// `tone` exists because this was being used for a permission refusal: a 74pt
// volt tick above the words "Only admins can edit this", which is the shape of
// a success and reads as one.
function SuccessBody({ title, body, tone = 'done' }: {
  title: string;
  body: string;
  tone?: 'done' | 'refused';
}) {
  const { c, t } = useTheme();
  const refused = tone === 'refused';
  return (
    <View style={{ paddingHorizontal: 18, alignItems: 'center', paddingTop: 70 }}>
      <View style={{ width: 74, height: 74, borderRadius: 999,
        backgroundColor: refused ? 'transparent' : c.volt,
        borderColor: refused ? c.line : 'transparent', borderWidth: refused ? 2 : 0,
        alignItems: 'center', justifyContent: 'center' }}>
        <Icon name={refused ? 'lock' : 'check'} size={34} color={refused ? c.txt3 : c.ink} />
      </View>
      <Text style={[t.overlayTitle, { fontSize: 24, color: c.txt, marginTop: 18 }]}>{title}</Text>
      <Text style={[t.bodyLg, { color: c.txt2, marginTop: 8, textAlign: 'center' }]}>{body}</Text>
    </View>
  );
}
