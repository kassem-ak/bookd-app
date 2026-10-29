import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { Avatar, Card, ConfirmSheet, Icon, IconButton, MicroBadge, Row, SectionHeading, Toggle } from '../components/ui';
import { usePaymentConfig } from '../components/usePaymentConfig';
import { fetchMyBookings } from '../lib/bookings';
import { stopCoaching } from '../lib/coaching';
import { signOutUser } from '../lib/session';
import { biometricAvailable, biometricEnabled, biometricLabel, setBiometric } from '../lib/biometric';
import { analyticsErrorCode, track } from '../lib/analytics';
import { initials } from '../state/models';
import { errorMessage, useStore } from '../state/store';
import { alpha, radii, useTheme } from '../theme';

export function ProfileScreen() {
  const { c, t } = useTheme();
  const s = useStore();
  // Payment rows only once BOOK'D takes payment for something.
  const paymentsLive = usePaymentConfig().enabledKinds.length > 0;
  const role = s.role;
  // Coaching UI asks `isCoach`, never `role`: an admin who coaches is 'ADMIN'.
  const isCoach = s.isCoach;
  const joinedCount = s.joinedCommunities.length;
  // Identity is whatever the signed-in account says it is, never a sample
  // person's. An account that has not set a name yet renders neutrally.
  const name = s.authName;
  // The app-side users.id, not the auth uid: profiles are keyed on the former.
  const myId = s.authUserId;
  const area = s.authLoc.trim();
  // `null` means "not loaded / could not load" and renders no badge at all —
  // the same contract as joinedCount. A count is never invented.
  const [upcomingCount, setUpcomingCount] = useState<number | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [stopBusy, setStopBusy] = useState(false);

  // Unlock with Face ID / a fingerprint. Only offered where the device can do
  // it right now -- hardware AND something enrolled -- so on the web, or on a
  // phone with no finger set up, the row is simply not there.
  const [canLock, setCanLock] = useState(false);
  const [lockOn, setLockOn] = useState(false);
  const [lockLabel, setLockLabel] = useState('biometrics');
  useEffect(() => {
    let active = true;
    if (!s.authUid) return;
    const uid = s.authUid;
    void (async () => {
      const [available, on, label] = await Promise.all([
        biometricAvailable(), biometricEnabled(uid), biometricLabel(),
      ]);
      if (!active) return;
      setCanLock(available);
      setLockOn(on);
      setLockLabel(label);
    })();
    return () => { active = false; };
  }, [s.authUid]);

  useEffect(() => {
    let active = true;
    setUpcomingCount(null);
    fetchMyBookings()
      .then((mine) => {
        if (active) setUpcomingCount(mine.upcoming.length);
      })
      .catch(() => {
        if (active) setUpcomingCount(null);
      });
    return () => {
      active = false;
    };
    // Signing in or out changes whose bookings these are.
  }, [s.authUid]);

  return (
    <ScrollView contentContainerStyle={{ paddingHorizontal: 18, paddingTop: 8, paddingBottom: 26 }}>
      <Row style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <View style={{ flex: 1 }}>
          <Text style={[t.pageTitle, { color: c.txt }]}>Profile</Text>
          {/* The board's "<name> - <city>". The city half stayed empty while
              nothing could set it; Edit profile now can, and an account that
              has not set one still renders the name alone rather than a
              placeholder. */}
          <Text style={[t.bodySm, { color: c.txt2, marginTop: 2 }]}>
            {name ?? 'Your account'}{area ? ` · ${area}` : ''}
          </Text>
        </View>
        <Row gap={10}>
          <IconButton icon="bell" accessibilityLabel="Notifications" onPress={s.openNotifs} />
          {/* Not a button: it marks which tab you are on. Left hand-rolled
              because IconButton would put a pressable in the reader's path
              for something nothing happens on. */}
          <View style={{ width: 44, height: 44, borderRadius: radii.button, backgroundColor: c.surface, borderColor: c.line, borderWidth: 1, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="user" size={18} color={c.accent} />
          </View>
        </Row>
      </Row>

      {/* The card is the way into your own profile -- the same page everyone
          else sees when they open you, rather than a second rendering of the
          same person that would drift from it. Until the account resolves
          there is no id to open, so it stays a plain card rather than a
          button that does nothing. */}
      <Card style={{ marginTop: 18 }}>
        <Pressable
          onPress={myId ? () => s.openPerson(myId) : undefined}
          disabled={!myId}
          accessibilityRole={myId ? 'button' : undefined}
          accessibilityLabel={myId ? `View your profile${name ? `, ${name}` : ''}` : undefined}
        >
        <Row style={{ padding: 15 }} gap={14}>
          {/* No name means a blank avatar — inventing initials would name a
              person who is not the one holding the phone. */}
          <Avatar initials={name ? initials(name) : ''} avatarUrl={s.authAvatarUrl} size={64} radius={17} fontSize={22} />
          <View style={{ flex: 1 }}>
            <Row gap={7}>
              <Text style={[t.overlayTitle, { color: c.txt }]}>{name ?? 'Welcome'}</Text>
            </Row>
            {s.authEmail && <Text style={[t.bodySm, { color: c.txt2, marginTop: 4 }]}>{s.authEmail}</Text>}
            <Row gap={7} style={{ marginTop: 8 }}>
              {role === 'ADMIN' ? (
                <MicroBadge label="Admin" bg={alpha(c.danger, 0.14)} fg={c.danger} />
              ) : isCoach ? (
                <MicroBadge label="Coach" bg={alpha(c.volt, 0.14)} fg={c.accent} />
              ) : (
                <MicroBadge label="Member" bg={alpha(c.volt, 0.12)} fg={c.accent} />
              )}
              {/* The city badge is gone with the header city: no real source. */}
            </Row>
          </View>
          {myId && <Icon name="chevron-right" size={18} color={c.txt3} />}
        </Row>
        </Pressable>
      </Card>

      {/* coach tools — free for every coach */}
      {isCoach && (
        <>
          <SectionHeading style={{ marginTop: 22, marginBottom: 11 }}>Coach tools</SectionHeading>
          <Card>
            <View style={{ padding: 15, gap: 13 }}>
              {/* Each row carries its own glyph. Without one ToolRow falls
                  back to a chevron, so the list a working coach uses every day
                  was five identical badges with a chevron at each end. */}
              <ToolRow icon="inbox" title="Appointment requests" body="Review requests · record decisions" onPress={() => s.set('overlay', 'coachRequests')} />
              <ToolRow icon="sun" title="Today's sessions" body="Day view · mark sessions done" onPress={() => s.set('overlay', 'coachDayView')} />
              {/* One row per decision, like the rows either side of them. These
                  were three sections of a single "Coaching settings" page --
                  what you teach, when you work and what you charge are made at
                  three different times and belong apart. */}
              <ToolRow icon="book-open" title="What you teach" body="Your subjects and experience" onPress={() => s.set('overlay', 'coachSubjects')} />
              <ToolRow icon="calendar" title="When you coach" body="Working hours · days off" onPress={() => s.set('overlay', 'coachHours')} />
              <ToolRow icon="tag" title="Packages, pricing & promos" body="Set prices · answer cancellations" onPress={() => s.set('overlay', 'coachPackages')} />
              {/* Last, under the tools it takes away, and the one row here
                  that is not a place to go. The server refuses while anyone is
                  still owed a session or an answer, so the wording promises
                  nothing the next screen has to take back. */}
              <RowDivider />
              <Pressable
                onPress={() => setStopping(true)}
                accessibilityRole="button"
                accessibilityLabel="Stop coaching"
                accessibilityHint="Removes your coach profile and takes you out of Discover"
                style={{ flexDirection: 'row', alignItems: 'center', minHeight: 44 }}
              >
                <View style={{ width: 42, height: 42, borderRadius: 12, backgroundColor: alpha(c.danger, 0.12), alignItems: 'center', justifyContent: 'center' }}>
                  <Icon name="user-minus" size={18} color={c.danger} />
                </View>
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <Text style={[t.name, { color: c.danger }]}>Stop coaching</Text>
                  <Text style={[t.bodySm, { color: c.txt2 }]}>Leave Discover · keep your account</Text>
                </View>
              </Pressable>
            </View>
          </Card>
        </>
      )}

      {/* ---------------------------- TRAINING ---------------------------- */}
      <SectionHeading style={{ marginTop: 22, marginBottom: 11 }}>Training</SectionHeading>
      <Card style={{ paddingHorizontal: 15 }}>
        <GroupRow
          icon="clock"
          title="My bookings"
          body={
            upcomingCount === null
              ? 'Sessions and packages'
              : `${upcomingCount} upcoming ${upcomingCount === 1 ? 'session' : 'sessions'} · packages`
          }
          badge={upcomingCount ? String(upcomingCount) : undefined}
          onPress={s.openBookings}
        />
        <RowDivider />
        {/* Board annotation: "Add my Communities" */}
        <GroupRow
          icon="users"
          title="My communities"
          body="Crews you own, moderate or follow"
          badge={joinedCount > 0 ? String(joinedCount) : undefined}
          onPress={() => s.set('overlay', 'myCommunities')}
        />
        <RowDivider />
        {/* Only for somebody who is not a coach yet: once they are, everything
            it held lives in Coach tools above. */}
        {!isCoach && <>
          <GroupRow
            icon="award"
            title="Become a coach"
            body="Free. Adds a coach profile so people can book you"
            onPress={() => s.set('overlay', 'coaching')}
          />
          <RowDivider />
        </>}
        <GroupRow
          icon="user-check"
          title="Your circle"
          body="Coaches and partners you follow"
          badge={s.followedIds.length > 0 ? String(s.followedIds.length) : undefined}
          onPress={() => s.set('overlay', 'circle')}
        />
        <RowDivider />
        <GroupRow
          icon="bell"
          title="Notifications"
          body="Booking updates"
          onPress={s.openNotifs}
        />
        {paymentsLive && (
          <>
            <RowDivider />
            <GroupRow
              icon="credit-card"
              title="Payment methods"
              body="Cards and Whish, to pay and to be paid"
              onPress={() => s.set('overlay', 'paymentMethods')}
            />
            <RowDivider />
            <GroupRow
              icon="trending-up"
              title="Earnings"
              body="Money from sessions, courts and events you run"
              onPress={() => s.set('overlay', 'earnings')}
            />
            <RowDivider />
            <GroupRow
              icon="file-text"
              title="Payments"
              body="What you paid, receipts and refunds"
              onPress={() => s.set('overlay', 'paymentHistory')}
            />
          </>
        )}
      </Card>

      {/* ---------------------------- SETTINGS ---------------------------- */}
      <SectionHeading style={{ marginTop: 22, marginBottom: 11 }}>Settings</SectionHeading>
      <Card style={{ paddingHorizontal: 15 }}>
        <GroupRow
          icon="moon"
          title="Appearance"
          body={s.isDark ? 'Dark theme' : 'Light theme'}
          value={s.isDark}
          onToggle={(v) => s.set('isDark', v)}
        />
        {canLock && s.authUid && (
          <>
            <RowDivider />
            {/* Turning it on asks for an unlock first, so it can never be
                switched on by someone who could not then open the app. */}
            <GroupRow
              icon="lock"
              title={`Unlock with ${lockLabel}`}
              body={lockOn ? 'Asked every time the app opens' : 'Off — the app opens straight away'}
              value={lockOn}
              onToggle={(next) => {
                const uid = s.authUid!;
                void setBiometric(uid, next).then((ok) => {
                  if (ok) setLockOn(next);
                  else if (next) s.set('writeError', `${lockLabel} did not confirm, so the lock stays off.`);
                });
              }}
            />
          </>
        )}
      </Card>

      {/* The admin console moved to the web back office. Administration is
          not a phone job: it needs the service role, which must never ship in
          a client, and every tool that used to sit here now has a server-side
          actor check rather than a UI-only gate. Nothing privileged is
          reachable from this build. */}
      <Card style={{ marginTop: 10, paddingHorizontal: 15 }}>
        {/* "My day view" used to sit here too, opening the same overlay as
            "Today's sessions" in Coach tools under a different name, filed
            beside Sign out. One entry point, in the section that is for it. */}
        <>
          <>
            <GroupRow
              icon="log-out"
              title="Sign out"
              // authEmail is nullable, and template-stringing it printed the
              // literal word "null" for any account without one.
              body={[s.authName, s.authEmail].filter(Boolean).join(' · ') || 'Signed in'}
              // A row, not a button, so ConfirmButton does not fit -- but the
              // guarantee is the same: the press asks, it does not sign out.
              onPress={() => setSigningOut(true)}
            />
          </>
        </>
      </Card>

      <ConfirmSheet
        visible={signingOut}
        title="Sign out?"
        body="You will need to sign in again to see your bookings and messages."
        confirmLabel="Sign out"
        confirmIcon="log-out"
        onConfirm={() => {
          setSigningOut(false);
          void signOutUser().catch((error) => {
            track('write_failed', { error_code: analyticsErrorCode(error) });
            s.set('writeError', errorMessage(error));
          });
        }}
        onCancel={() => setSigningOut(false)}
      />

      {/* What actually happens, because none of it is guessable: you leave
          Discover, the tools above go, and the rating and session count do not
          survive a return -- guard_coach_profile_privileges zeroes them on the
          way back in. What does survive is said too, so the choice is not
          scarier than it is. */}
      <ConfirmSheet
        visible={stopping}
        title="Stop coaching?"
        body={'You come out of Discover and the coach tools go with it. Your packages, certificates and hours are kept, and past sessions stay on your record — but your rating and session count start from zero if you ever coach again.'}
        confirmLabel="Stop coaching"
        confirmIcon="user-minus"
        busy={stopBusy}
        onConfirm={() => {
          setStopBusy(true);
          void stopCoaching()
            .then(async () => {
              setStopping(false);
              track('stopped_coaching');
              // The badge, the tools and Discover all read this.
              await s.refreshRole();
            })
            .catch((error) => {
              track('write_failed', { error_code: analyticsErrorCode(error) });
              // "You still have 2 sessions booked" is the answer, not a
              // failure to report -- it is shown as the server wrote it.
              s.set('writeError', errorMessage(error));
              setStopping(false);
            })
            .finally(() => setStopBusy(false));
        }}
        onCancel={() => setStopping(false)}
      />
    </ScrollView>
  );
}

function ToolRow({ count, icon, title, body, onPress }: { count?: string; icon?: any; title: string; body: string; onPress: () => void }) {
  const { c, t } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={count ? `${title}, ${count}` : title}
      accessibilityHint={body}
      style={{ flexDirection: 'row', alignItems: 'center', minHeight: 44 }}
    >
      <View style={{ width: 42, height: 42, borderRadius: 12, backgroundColor: count ? alpha(c.volt, 0.12) : c.surface2, alignItems: 'center', justifyContent: 'center' }}>
        {count ? <Text style={[t.priceSm, { color: c.accent }]}>{count}</Text> : <Icon name={icon ?? 'chevron-right'} size={18} color={c.accent} />}
      </View>
      <View style={{ flex: 1, marginLeft: 12 }}>
        <Text style={[t.name, { color: c.txt }]}>{title}</Text>
        <Text style={[t.bodySm, { color: c.txt2 }]}>{body}</Text>
      </View>
      <Icon name="chevron-right" size={20} color={c.txt3} />
    </Pressable>
  );
}

function RowDivider() {
  const { c } = useTheme();
  return <View style={{ height: 1, backgroundColor: c.line2 }} />;
}

/**
 * One row inside a labelled TRAINING / SETTINGS group. Either a navigation row
 * (chevron + optional badge/dot) or a switch row — in the switch case the whole
 * row is the switch so the tap target clears 44px and carries the label, since
 * the shared `Toggle` has no accessibilityLabel of its own.
 */
function GroupRow({
  icon,
  title,
  body,
  badge,
  dot,
  value,
  onToggle,
  onPress,
}: {
  icon: any;
  title: string;
  body: string;
  badge?: string;
  dot?: boolean;
  value?: boolean;
  onToggle?: (v: boolean) => void;
  onPress?: () => void;
}) {
  const { c, t } = useTheme();
  const isSwitch = typeof onToggle === 'function';
  const content = (
    <Row style={{ paddingVertical: 13, minHeight: 44 }} gap={12}>
      <View style={{ width: 42, height: 42, borderRadius: 12, backgroundColor: c.surface2, alignItems: 'center', justifyContent: 'center' }}>
        <Icon name={icon} size={20} color={c.accent} />
        {dot && (
          <View style={{ position: 'absolute', top: 9, right: 10, width: 8, height: 8, borderRadius: 4, backgroundColor: c.volt }} />
        )}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[t.name, { color: c.txt }]}>{title}</Text>
        <Text style={[t.bodySm, { color: c.txt2, marginTop: 3 }]}>{body}</Text>
      </View>
      {badge ? <MicroBadge label={badge} bg={c.surface2} fg={c.accent} /> : null}
      {isSwitch ? (
        <View pointerEvents="none">
          <Toggle value={!!value} onChange={() => {}} />
        </View>
      ) : (
        <Icon name="chevron-right" size={20} color={c.txt3} />
      )}
    </Row>
  );

  if (isSwitch)
    return (
      <Pressable
        onPress={() => onToggle!(!value)}
        accessibilityRole="switch"
        accessibilityLabel={title}
        accessibilityHint={body}
        accessibilityState={{ checked: !!value }}
      >
        {content}
      </Pressable>
    );

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={badge ? `${title}, ${badge}` : title}
      accessibilityHint={body}
    >
      {content}
    </Pressable>
  );
}
