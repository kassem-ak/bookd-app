import React, { ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { analyticsErrorCode, track } from '../lib/analytics';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { OverlayHeader, OverlayScaffold } from '../components/Overlay';
import {
  Avatar, Button, ButtonTone, Card, Chip, ConfirmSheet, ErrorNote, Field, FormSheet, Icon,
  IconName, MicroBadge, Stars,
  Note, Row, SectionHeading, Segmented, VoltButton,
} from '../components/ui';
import { RefundNegotiation } from '../components/RefundNegotiation';
import {
  BookingStatus,
  MyBooking,
  MyBookings,
  PackageBalance,
  SessionKind,
  acceptSession,
  awaitsConfirmation,
  fetchSessionRatings,
  pastOutcome,
  rateSession,
  ratingsSchemaReady,
  bookingStatusLabel,
  canCancel,
  cancelSession,
  confirmFulfilled,
  fetchMyBookings,
  fetchMyPackageBalances,
  formatCents,
  formatExpiry,
  formatSessionWhen,
  PastOutcome,
  SessionRating,
} from '../lib/bookings';
import { dateKey as dayKey, monthCells, MONTH_NAMES } from '../lib/calendarGrid';
import {
  cancelUnusedPackage, fetchCancellations, fetchMyPackages, fetchPackagePrices,
  hasFulfilledSession, PackageCancellation, PackageProgress,
  progressSummary, requestCancellation, suggestedRefundCents, withdrawCancellation,
} from '../lib/packages';
import { usePaymentConfig } from '../components/usePaymentConfig';
import { paymentsOn } from '../lib/payments';
import { initials } from '../state/models';
import { errorMessage, useStore } from '../state/store';
import { alpha, useTheme } from '../theme';

const EMPTY: MyBookings = { upcoming: [], past: [] };

export function BookingsOverlay() {
  const { c, t } = useTheme();
  const s = useStore();
  const takesPayment = paymentsOn(usePaymentConfig(), 'package');
  const [bookings, setBookings] = useState<MyBookings>(EMPTY);
  const [packages, setPackages] = useState<PackageBalance[]>([]);
  // Counted from the bookings rather than a stored counter, so a cancelled
  // session comes back to the pack instead of being lost.
  const [progress, setProgress] = useState<PackageProgress[]>([]);
  // Cancellation requests, keyed by package. A pack has at most one open
  // request -- the database has a partial unique index saying so.
  const [cancels, setCancels] = useState<Map<string, PackageCancellation>>(new Map());
  const [prices, setPrices] = useState<Map<string, number>>(new Map());
  const [asking, setAsking] = useState<PackageProgress | null>(null);
  // Nothing on a pack is spent until both sides say the session happened, so
  // the prompt to say so lives beside the session itself.
  const [confirmingDone, setConfirmingDone] = useState<string | null>(null);
  // A pack with nothing confirmed comes back in full and needs no coach: the
  // only question is whether this person meant to press it.
  const [givingBack, setGivingBack] = useState<PackageProgress | null>(null);
  // The archive's one filter. How a session ended is the only thing worth
  // filtering by -- who and when are already on every card.
  const [outcome, setOutcome] = useState<PastOutcome | 'all'>('all');
  // Ratings for the whole archive in one read, rather than one per card.
  const [ratings, setRatings] = useState<SessionRating[]>([]);
  const [opened, setOpened] = useState<MyBooking | null>(null);
  // Shut by default. This screen is for what is coming up; history is the
  // longest thing on the page and the least often wanted, so it costs a tap
  // rather than the whole scroll.
  const [showPast, setShowPast] = useState(false);
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Cancelling is destructive and RN Web has no Alert, so the card asks for a
  // second tap in place instead of opening a dialog.
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // What a free cancel actually returned, as the server worked it out.
  const [refundNote, setRefundNote] = useState<string | null>(null);
  const [view, setView] = useState<'list' | 'calendar'>('list');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [mine, balances, packs, requests] = await Promise.all([
        fetchMyBookings(), fetchMyPackageBalances(), fetchMyPackages(), fetchCancellations(),
      ]);
      setBookings(mine);
      setPackages(balances);
      setProgress(packs);
      // Newest first from the server, so the first row for a pack is the
      // current one and anything older is history.
      const latest = new Map<string, PackageCancellation>();
      for (const request of requests) {
        if (!latest.has(request.packageId)) latest.set(request.packageId, request);
      }
      setCancels(latest);
      // Second round trip, and a failure leaves the archive without its
      // ratings rather than without itself.
      try {
        const past = [...mine.past].map((b) => b.id);
        setRatings(await fetchSessionRatings(past));
      } catch {
        setRatings([]);
      }
      // Second round trip because the price is only needed once the packs are
      // known. A failure here leaves the refund box empty rather than wrong,
      // which is the better of the two.
      try {
        setPrices(await fetchPackagePrices(packs.map((pack) => pack.packageId)));
      } catch {
        setPrices(new Map());
      }
    } catch (e) {
      setBookings(EMPTY);
      setPackages([]);
      setProgress([]);
      setCancels(new Map());
      setPrices(new Map());
      setRatings([]);
      setError(e instanceof Error ? e.message : 'Could not load your bookings.');
    } finally {
      setLoading(false);
    }
  }, []);

  // The overlay is unmounted by the router when it closes, so a single load on
  // mount is the whole lifecycle; every write below re-runs it.
  useEffect(() => {
    void load();
  }, [load]);

  const onAccept = async (booking: MyBooking) => {
    setCancellingId(booking.id);
    setActionError(null);
    try {
      await acceptSession(booking);
      await load();
    } catch (e) {
      track('write_failed', { error_code: analyticsErrorCode(e) });
      setActionError(e instanceof Error ? e.message : 'Could not accept that session.');
    } finally {
      setCancellingId(null);
    }
  };

  // Write, then re-read. A package that shows a state the server refused is
  // worse than one that is briefly a beat behind.
  const run = async (write: () => Promise<void>, fallback: string) => {
    setActionError(null);
    setRefundNote(null);
    try {
      await write();
      await load();
    } catch (e) {
      track('write_failed', { error_code: analyticsErrorCode(e) });
      setActionError(e instanceof Error ? e.message : fallback);
    }
  };

  const onCancel = async (booking: MyBooking) => {
    setCancellingId(booking.id);
    setActionError(null);
    try {
      await cancelSession(booking);
      setConfirmingId(null);
      await load();
    } catch (e) {
      track('write_failed', { error_code: analyticsErrorCode(e) });
      setActionError(e instanceof Error ? e.message : 'Could not cancel that session.');
    } finally {
      setCancellingId(null);
    }
  };

  const hasSessions = bookings.upcoming.length > 0 || bookings.past.length > 0;

  return (
    <OverlayScaffold header={<OverlayHeader title="My bookings" onBack={s.closeOverlay} />}>
      <View style={{ paddingHorizontal: 18 }}>
        {loading && <Note>Loading your sessions…</Note>}

        {!loading && error && <ErrorNote message={error} onRetry={load} />}

        {/* Above the view switch, not inside one branch: a cancel started in
            the calendar used to fail into a message only the list could show. */}
        {refundNote && (
          <Text style={[t.bodySm, { color: c.txt2, marginBottom: 10 }]}>{refundNote}</Text>
        )}
        {actionError && (
          <Text accessibilityRole="alert" style={[t.bodySm, { color: c.danger, marginBottom: 10 }]}>
            {actionError}
          </Text>
        )}

        {!loading && !error && hasSessions && (
          <View style={{ marginBottom: 16 }}>
            <Segmented
              options={[{ key: 'list', label: 'List' }, { key: 'calendar', label: 'Calendar' }]}
              selected={view}
              onSelect={(k) => setView(k === 'calendar' ? 'calendar' : 'list')}
            />
          </View>
        )}

        {!loading && !error && view === 'calendar' && (
          <MonthCalendar
            sessions={[...bookings.upcoming, ...bookings.past]}
            confirmingId={confirmingId}
            cancellingId={cancellingId}
            onCancel={(b) => { setActionError(null); setConfirmingId(b.id); }}
            onKeep={() => setConfirmingId(null)}
            onConfirmCancel={(b) => void cancelSession(b)}
          />
        )}

        {!loading && !error && view === 'list' && (() => {
          // A pack whose cancellation was approved buys nothing and books
          // nothing. It sat in Packages next to the live ones for good, which
          // made the list read as more than the person actually has.
          const isCancelled = (pack: PackageProgress) =>
            cancels.get(pack.packageId)?.status === 'approved';
          const livePacks = progress.filter((pack) => !isCancelled(pack));
          const cancelledPacks = progress.filter(isCancelled);
          return (
          <>
            {livePacks.length > 0 ? (
              <>
                <SectionHeading style={{ marginBottom: 11 }}>Packages</SectionHeading>
                <View style={{ gap: 10 }}>
                  {livePacks.map((pack) => {
                    const request = cancels.get(pack.packageId);
                    // 'offered' is still open: the figure is being argued
                    // over, and the pack is what the argument is about.
                    const open = request?.status === 'requested' || request?.status === 'offered';
                    const cancelled = request?.status === 'approved';
                    // Taking a request back, or having it declined, has to
                    // leave you able to ask again. Gating the ask on "a request
                    // exists at all" meant one withdrawal removed the button for
                    // good, with nothing on the card to say why.
                    const settled = request?.status === 'withdrawn' || request?.status === 'rejected';
                    return (
                      <ProgressCard key={pack.packageId} pack={pack} withLabel={`with ${pack.withName}`}
                        request={request}
                        // A cancelled pack books nothing, and a pack with a
                        // question hanging over it should not be spent while
                        // the coach is still deciding.
                        onBook={pack.remaining > 0 && !open && !cancelled
                          ? () => s.openPackBooking(pack.coachId) : undefined}
                        // Nothing confirmed means nothing delivered: the pack
                        // comes back in full and there is no figure to argue
                        // over, so that path asks this person only. One
                        // confirmed session and it is a negotiation.
                        onAskCancel={pack.remaining > 0 && (!request || settled)
                          ? () => {
                            setActionError(null);
                            if (hasFulfilledSession(pack)) { setReason(''); setAsking(pack); }
                            else setGivingBack(pack);
                          } : undefined}
                        onWithdraw={open
                          ? () => void run(() => withdrawCancellation(request!.id),
                              'Could not take that request back.') : undefined}
                        priceCents={prices.get(pack.packageId) ?? 0}
                        onSettled={() => void load()}
                      />
                    );
                  })}
                </View>
              </>
            ) : packages.length > 0 && (
              <>
                <SectionHeading style={{ marginBottom: 11 }}>Packages</SectionHeading>
                <View style={{ gap: 10 }}>
                  {packages.map((pk) => (
                    <PackageCard key={pk.id} pack={pk} />
                  ))}
                </View>
              </>
            )}

            <SectionHeading style={{ marginTop: progress.length > 0 || packages.length > 0 ? 22 : 0, marginBottom: 11 }}>
              Upcoming
            </SectionHeading>
            <View style={{ gap: 10 }}>
              {bookings.upcoming.length === 0 ? (
                <Note>{hasSessions ? 'Nothing coming up.' : 'No sessions booked yet'}</Note>
              ) : (
                bookings.upcoming.map((b) => (
                  <SessionCard
                    key={b.id}
                    booking={b}
                    confirming={confirmingId === b.id}
                    busy={cancellingId === b.id}
                    onAskCancel={() => {
                      setActionError(null);
                      setConfirmingId(b.id);
                    }}
                    onKeep={() => setConfirmingId(null)}
                    onConfirmCancel={() => onCancel(b)}
                    onAccept={() => onAccept(b)}
                  />
                ))
              )}
            </View>

            {(bookings.past.length > 0 || cancelledPacks.length > 0) && (() => {
              // Everything that is over, whether it happened or was called off.
              const counts = bookings.past.reduce((acc, b) => {
                const key = pastOutcome(b);
                acc[key] = (acc[key] ?? 0) + 1;
                return acc;
              }, {} as Record<PastOutcome, number>);
              const shown = outcome === 'all'
                ? bookings.past
                : bookings.past.filter((b) => pastOutcome(b) === outcome);
              // A cancelled pack is one of the cancelled things, so it counts
              // where somebody would look for it rather than in a group of its
              // own that they would have to know to check.
              const cancelledCount = (counts.cancelled ?? 0) + cancelledPacks.length;
              const total = bookings.past.length + cancelledPacks.length;
              const filters: { key: PastOutcome | 'all'; label: string }[] = [
                { key: 'all', label: `All ${total}` },
                ...(counts.completed ? [{ key: 'completed' as const, label: `Completed ${counts.completed}` }] : []),
                ...(counts.unconfirmed ? [{ key: 'unconfirmed' as const, label: `Unconfirmed ${counts.unconfirmed}` }] : []),
                ...(cancelledCount ? [{ key: 'cancelled' as const, label: `Cancelled ${cancelledCount}` }] : []),
              ];
              const showPacks = outcome === 'all' || outcome === 'cancelled';
              return (
                <>
                  {/* The heading is the control. A count on it means the tap
                      is an informed one -- nobody opens a section to find out
                      whether it was worth opening. */}
                  <Pressable
                    onPress={() => setShowPast((open) => !open)}
                    accessibilityRole="button"
                    accessibilityState={{ expanded: showPast }}
                    accessibilityLabel={`Past appointments, ${total}`}
                    accessibilityHint={showPast ? 'Hides your history' : 'Shows your history'}
                    style={{ minHeight: 48, marginTop: 22, justifyContent: 'center' }}
                  >
                    <Row style={{ alignItems: 'center', justifyContent: 'space-between' }}>
                      <Row gap={8} style={{ alignItems: 'center' }}>
                        <SectionHeading>Past appointments</SectionHeading>
                        <Text style={[t.caption, { color: c.txt3 }]}>{total}</Text>
                      </Row>
                      <Icon name={showPast ? 'chevron-up' : 'chevron-down'} size={20} color={c.txt3} />
                    </Row>
                  </Pressable>

                  {showPast && <View style={{ height: 11 }} />}
                  {/* Only worth a filter row once there is more than one kind
                      of ending in the list. */}
                  {showPast && filters.length > 2 && (
                    <ScrollView horizontal showsHorizontalScrollIndicator={false}
                      contentContainerStyle={{ gap: 8, paddingRight: 8, paddingBottom: 11 }}>
                      {filters.map((f) => (
                        <Chip key={f.key} label={f.label} active={outcome === f.key}
                          accessibilityLabel={`Show ${f.label.toLowerCase()} appointments`}
                          onPress={() => setOutcome(f.key)} />
                      ))}
                    </ScrollView>
                  )}
                  {showPast && (
                  <View style={{ gap: 10 }}>
                    {showPacks && cancelledPacks.map((pack) => (
                      <ProgressCard key={`pack-${pack.packageId}`} pack={pack}
                        withLabel={`with ${pack.withName}`}
                        request={cancels.get(pack.packageId)}
                        priceCents={prices.get(pack.packageId) ?? 0} />
                    ))}
                    {shown.length === 0 && !(showPacks && cancelledPacks.length > 0) ? (
                      <Note>Nothing in this part of your history.</Note>
                    ) : shown.map((b) => (
                      <SessionCard key={b.id} booking={b}
                        busy={confirmingDone === b.id}
                        ratings={ratings.filter((r) => r.sessionId === b.id)}
                        onOpen={() => setOpened(b)}
                        onConfirmDone={awaitsConfirmation(b)
                          ? () => void run(async () => {
                              setConfirmingDone(b.id);
                              try { await confirmFulfilled(b.id); } finally { setConfirmingDone(null); }
                            }, 'Could not confirm that session.')
                          : undefined} />
                    ))}
                  </View>
                  )}
                </>
              );
            })()}
          </>
          );
        })()}
        <PastDetailSheet
          booking={opened}
          ratings={opened ? ratings.filter((r) => r.sessionId === opened.id) : []}
          onClose={() => setOpened(null)}
          onRated={() => { setOpened(null); void load(); }}
        />

        <ConfirmSheet
          visible={Boolean(givingBack)}
          title="Cancel this package?"
          body={givingBack
            ? `Neither of you has confirmed a session out of this ${givingBack.total}-session pack, `
              + (takesPayment
                ? 'so it is cancelled. You get back what you paid for this pack, to the card or Whish account that paid.'
                : `so it is cancelled in full and ${formatCents(prices.get(givingBack.packageId) ?? 0)} `
                  + `goes back to you. ${givingBack.withName.split(' ')[0]} pays you directly — `
                  + 'BOOK’D records the amount and does not move the money.')
            : ''}
          confirmLabel="Cancel the package"
          confirmIcon="x-circle"
          cancelLabel="Keep it"
          busy={cancellingId === givingBack?.packageId}
          busyLabel="Cancelling…"
          onCancel={() => setGivingBack(null)}
          onConfirm={() => {
            const pack = givingBack;
            if (!pack) return;
            void run(async () => {
              const { refundCents, moved } = await cancelUnusedPackage(pack.coachId, pack.packageId);
              setRefundNote(moved && refundCents > 0
                ? `${formatCents(refundCents)} is on its way back to the card or Whish account that paid.` : null);
              track('package_cancelled_unused');
              setGivingBack(null);
            }, 'Could not cancel that package.');
          }}
        />

        <FormSheet
          visible={Boolean(asking)}
          title="Request cancellation"
          subtitle={asking ? `${asking.remaining} of ${asking.total} sessions are still unused.` : undefined}
          onClose={() => setAsking(null)}
          footer={
            <VoltButton label="Send the request" enabled={Boolean(asking)}
              onPress={() => {
                const pack = asking;
                if (!pack) return;
                void run(async () => {
                  await requestCancellation(pack.coachId, pack.packageId, reason);
                  track('package_cancellation_requested');
                  setAsking(null);
                }, 'Could not send that request.');
              }} />
          }
        >
          <Text style={[t.bodySm, { color: c.txt2 }]}>
            {asking ? asking.withName.split(' ')[0] : 'Your coach'} decides whether to cancel it and how much to give
            back. {takesPayment
              ? 'Once you both agree, BOOK’D sends the refund back to the card or Whish account that paid.'
              : 'BOOK’D does not move money — whatever you agree is paid between the two of you.'}
          </Text>
          <Text style={[t.caption, { color: c.txt3 }]}>
            Sessions you have already booked stay in your calendar. Cancel those separately if you do not want them.
          </Text>
          <Field value={reason} onChange={setReason} label="Why, optionally"
            placeholder="Moving away, injured, changed plans" />
        </FormSheet>
      </View>
    </OverlayScaffold>
  );
}

/** Sessions grouped by the local day they start on. */
// Re-exported: the grid maths moved to lib/calendarGrid so the date picker can
// share it, and these are the names the tests and the rest of this file use.
export { monthCells };
export { dayKey };

export function byDay(sessions: MyBooking[]): Map<string, MyBooking[]> {
  const days = new Map<string, MyBooking[]>();
  for (const session of sessions) {
    const key = dayKey(session.scheduledFor);
    if (!key) continue;
    const existing = days.get(key);
    if (existing) existing.push(session);
    else days.set(key, [session]);
  }
  return days;
}

// Monday-first, matching monthCells and coach_availability.weekday.
const DOW = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

function MonthCalendar({ sessions, confirmingId, cancellingId, onCancel, onKeep, onConfirmCancel }: {
  sessions: MyBooking[];
  confirmingId: string | null;
  cancellingId: string | null;
  onCancel: (b: MyBooking) => void;
  onKeep: () => void;
  onConfirmCancel: (b: MyBooking) => void;
}) {
  const { c, t } = useTheme();
  const today = new Date();
  const [cursor, setCursor] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1));
  const [selected, setSelected] = useState<string>(() => dayKey(today));

  const days = useMemo(() => byDay(sessions), [sessions]);
  const cells = useMemo(() => monthCells(cursor.getFullYear(), cursor.getMonth()), [cursor]);
  const chosen = days.get(selected) ?? [];
  const step = (months: number) =>
    setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + months, 1));

  return (
    <View>
      <Row style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <TextAction label="Prev" icon="chevron-left" accessibilityLabel="Previous month" onPress={() => step(-1)} />
        <Text style={[t.labelSm, { color: c.txt }]}>
          {MONTH_NAMES[cursor.getMonth()]} {cursor.getFullYear()}
        </Text>
        <TextAction label="Next" icon="chevron-right" accessibilityLabel="Next month" onPress={() => step(1)} />
      </Row>

      <Row style={{ marginBottom: 6 }}>
        {DOW.map((letter, index) => (
          <View key={`${letter}-${index}`} style={{ flex: 1, alignItems: 'center' }}>
            <Text style={[t.caption, { color: c.txt3 }]}>{letter}</Text>
          </View>
        ))}
      </Row>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
        {cells.map((day, index) => {
          if (day === null) return <View key={`blank-${index}`} style={{ width: `${100 / 7}%`, height: 46 }} />;
          const key = dayKey(new Date(cursor.getFullYear(), cursor.getMonth(), day));
          const onThisDay = days.get(key) ?? [];
          const isSelected = key === selected;
          const isToday = key === dayKey(today);
          return (
            <Pressable key={key} onPress={() => setSelected(key)} accessibilityRole="button"
              accessibilityState={{ selected: isSelected }}
              accessibilityLabel={`${day} ${MONTH_NAMES[cursor.getMonth()]}, ${onThisDay.length} ${onThisDay.length === 1 ? 'session' : 'sessions'}`}
              style={{ width: `${100 / 7}%`, height: 46, alignItems: 'center', justifyContent: 'center' }}>
              <View style={{ width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center',
                backgroundColor: isSelected ? c.volt : 'transparent',
                borderWidth: isToday && !isSelected ? 1 : 0, borderColor: c.line }}>
                <Text style={[t.bodySm, { color: isSelected ? c.ink : c.txt }]}>{day}</Text>
              </View>
              {/* One dot per session, capped at three -- past that the count
                  stops being readable and the day is simply "busy". */}
              <Row gap={3} style={{ height: 5, marginTop: 1 }}>
                {onThisDay.slice(0, 3).map((session) => (
                  <View key={session.id} style={{ width: 4, height: 4, borderRadius: 2,
                    backgroundColor: kindTint(session.kind, c).rail }} />
                ))}
              </Row>
            </Pressable>
          );
        })}
      </View>

      <Row gap={14} style={{ marginTop: 12, marginBottom: 4 }}>
        {(['coach', 'partner'] as SessionKind[]).map((kind) => {
          const tint = kindTint(kind, c);
          return (
            <Row key={kind} gap={6} style={{ alignItems: 'center' }}>
              <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: tint.rail }} />
              <Text style={[t.caption, { color: c.txt2 }]}>{tint.label}</Text>
            </Row>
          );
        })}
      </Row>

      <SectionHeading style={{ marginTop: 14, marginBottom: 11 }}>{selectedLabel(selected)}</SectionHeading>
      <View style={{ gap: 10 }}>
        {chosen.length === 0
          ? <Note>Nothing on this day.</Note>
          : chosen
            .slice()
            .sort((a, b) => Date.parse(a.scheduledFor) - Date.parse(b.scheduledFor))
            .map((session) => (
              <SessionCard key={session.id} booking={session}
                confirming={confirmingId === session.id}
                busy={cancellingId === session.id}
                onAskCancel={canCancel(session.status, session.scheduledFor) ? () => onCancel(session) : undefined}
                onKeep={onKeep}
                onConfirmCancel={() => onConfirmCancel(session)} />
            ))}
      </View>
    </View>
  );
}

function selectedLabel(key: string) {
  const [year, month, day] = key.split('-').map(Number);
  if (!year || !month || !day) return 'Selected day';
  return `${day} ${MONTH_NAMES[month - 1]} ${year}`;
}

// A past appointment, in full: what it was, how it ended, and what the two of
// you made of it.
//
// The rating rules live on the server and are repeated here only as what the
// form offers. Everyone rates attitude. A coach additionally reads skill and
// can leave a note that only the two of them can read -- which is why that
// note is not on `reviews`, a table the whole app can read.
function PastDetailSheet({ booking, ratings, onClose, onRated }: {
  booking: MyBooking | null;
  ratings: SessionRating[];
  onClose: () => void;
  onRated: () => void;
}) {
  const { c, t } = useTheme();
  const [stars, setStars] = useState(0);
  const [skill, setSkill] = useState(0);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A fresh form per session, so last time's stars are never this time's.
  useEffect(() => {
    setStars(0); setSkill(0); setNote(''); setError(null);
  }, [booking?.id]);

  if (!booking) return null;

  const outcome = pastOutcome(booking);
  const mine = ratings.find((r) => r.subjectId === booking.withId);
  const theirs = ratings.find((r) => r.subjectId !== booking.withId);
  // Nothing to rate about a session that was called off, and nothing to rate
  // twice -- the server replaces rather than duplicating, but offering the
  // form again reads as if the first one did not land.
  // Hidden entirely until the database can record an answer. Offering a form
  // that cannot be submitted is worse than not offering one.
  const canRate = ratingsSchemaReady() && outcome !== 'cancelled' && !mine;

  const send = () => {
    if (stars < 1) { setError('Pick a number of stars first.'); return; }
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        await rateSession({
          sessionId: booking.id,
          kind: booking.kind,
          stars,
          skillStars: skill > 0 ? skill : null,
          feedback: note.trim() || null,
        });
        track('session_rated');
        onRated();
      } catch (e) {
        track('write_failed', { error_code: analyticsErrorCode(e) });
        setError(errorMessage(e));
      } finally { setBusy(false); }
    })();
  };

  return (
    <FormSheet
      visible
      title={booking.withName}
      subtitle={formatSessionWhen(booking)}
      onClose={onClose}
      footer={canRate ? (
        <Button label="Leave your rating" icon="star" tone="primary" full height={52}
          busy={busy} busyLabel="Saving…" enabled={!busy} onPress={send} />
      ) : (
        <Button label="Close" icon="x" full onPress={onClose} />
      )}
    >
      <View style={{ gap: 16 }}>
        <Row gap={8} style={{ flexWrap: 'wrap' }}>
          <MicroBadge label={OUTCOME_LABEL[outcome]} bg={outcomeTint(outcome, c).bg}
            fg={outcomeTint(outcome, c).fg} />
          <MicroBadge label={booking.kind === 'partner' ? 'Partner' : 'Coach'}
            bg={alpha(c.txt3, 0.14)} fg={c.txt2} />
        </Row>

        <View style={{ gap: 4 }}>
          <Text style={[t.caption, { color: c.txt3 }]}>What it cost</Text>
          <Text style={[t.price, { color: c.accent }]}>
            {booking.kind === 'partner' ? 'Free' : formatCents(booking.totalCents)}
          </Text>
        </View>

        {outcome === 'unconfirmed' && (
          <Text style={[t.bodySm, { color: c.txt2 }]}>
            Its time went by and neither of you said whether it happened, so it is
            neither finished nor called off.
          </Text>
        )}

        {(mine || theirs) && (
          <View style={{ gap: 10, paddingTop: 4, borderTopWidth: 1, borderTopColor: c.line2 }}>
            {theirs && (
              <RatingReadout title={`${booking.withName.split(' ')[0]}'s rating of you`}
                rating={theirs} />
            )}
            {mine && (
              <RatingReadout title={`Your rating of ${booking.withName.split(' ')[0]}`}
                rating={mine} />
            )}
          </View>
        )}

        {canRate && (
          <View style={{ gap: 12, paddingTop: 4, borderTopWidth: 1, borderTopColor: c.line2 }}>
            <StarPicker label="Attitude" value={stars} onChange={setStars}
              hint={`How ${booking.withName.split(' ')[0]} was to train with.`} />
            {error && (
              <Text accessibilityRole="alert" style={[t.bodySm, { color: c.danger }]}>{error}</Text>
            )}
          </View>
        )}
      </View>
    </FormSheet>
  );
}

function RatingReadout({ title, rating }: { title: string; rating: SessionRating }) {
  const { c, t } = useTheme();
  return (
    <View style={{ gap: 4 }}>
      <Text style={[t.caption, { color: c.txt3 }]}>{title}</Text>
      <Row gap={10} style={{ alignItems: 'center' }}>
        <Row gap={5} style={{ alignItems: 'center' }}>
          <Text style={[t.caption, { color: c.txt2 }]}>Attitude</Text>
          <Stars value={rating.stars} size={14} />
        </Row>
        {rating.skillStars !== null && (
          <Row gap={5} style={{ alignItems: 'center' }}>
            <Text style={[t.caption, { color: c.txt2 }]}>Skill</Text>
            <Stars value={rating.skillStars} size={14} />
          </Row>
        )}
      </Row>
      {rating.feedback && (
        <View style={{ marginTop: 4, gap: 3 }}>
          <Text style={[t.bodySm, { color: c.txt }]}>{rating.feedback}</Text>
          {/* Said out loud, because a coach writing it needs to know it is not
              going on a public profile. */}
          <Text style={[t.caption, { color: c.txt3 }]}>
            Private — only the two of you can read this.
          </Text>
        </View>
      )}
    </View>
  );
}

function StarPicker({ label, value, onChange, hint }: {
  label: string; value: number; onChange: (n: number) => void; hint?: string;
}) {
  const { c, t } = useTheme();
  return (
    <View style={{ gap: 6 }}>
      <Text style={[t.labelSm, { color: c.txt }]}>{label}</Text>
      {hint && <Text style={[t.caption, { color: c.txt3 }]}>{hint}</Text>}
      <Row gap={6} style={{ alignItems: 'center' }}>
        {[1, 2, 3, 4, 5].map((n) => (
          <Pressable
            key={n}
            onPress={() => onChange(n)}
            // One of a set, not five commands. The targets sit next to each
            // other, which is where a mis-tap costs the most.
            accessibilityRole="radio"
            accessibilityLabel={`${n} out of 5`}
            accessibilityState={{ selected: value >= n }}
            hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
            style={{ minHeight: 44, minWidth: 40, alignItems: 'center', justifyContent: 'center' }}
          >
            <Text style={{ fontSize: 28, color: value >= n ? c.amber : c.mono }}>★</Text>
          </Pressable>
        ))}
      </Row>
    </View>
  );
}

const OUTCOME_LABEL: Record<PastOutcome, string> = {
  completed: 'Completed',
  cancelled: 'Cancelled',
  unconfirmed: 'Unconfirmed',
};

function outcomeTint(outcome: PastOutcome, c: ReturnType<typeof useTheme>['c']) {
  if (outcome === 'completed') return { bg: alpha(c.volt, 0.14), fg: c.accent };
  if (outcome === 'cancelled') return { bg: alpha(c.danger, 0.14), fg: c.danger };
  return { bg: alpha(c.amber, 0.16), fg: c.amberText };
}

// What is left of a package, from the bookings themselves.
//
// Four numbers rather than one bar: "3 of 10 used" cannot tell somebody whether
// the other seven are bookable now or already spoken for, and that is the only
// question a person opening this card is asking.
export function ProgressCard({ pack, withLabel, onBook, request, priceCents = 0, onAskCancel, onWithdraw, onSettled }: {
  pack: PackageProgress; withLabel: string;
  /** What the pack sold for. The opening refund figure is the unused share of
   *  it, so a missing price opens the box empty rather than at zero. */
  priceCents?: number;
  /** Absent when the pack has nothing left -- a card that looks tappable and
   *  leads to a screen that cannot book anything is worse than a flat one. */
  onBook?: () => void;
  request?: PackageCancellation;
  onAskCancel?: () => void;
  onWithdraw?: () => void;
  /** Re-read after an offer or an acceptance, so the card and the panel cannot
   *  disagree about where the negotiation got to. */
  onSettled?: () => void;
}) {
  const { c, t } = useTheme();
  const takesPayment = paymentsOn(usePaymentConfig(), 'package');
  const spent = pack.taken + pack.booked + pack.pending;
  const filled = pack.total > 0 ? Math.min(Math.max(spent / pack.total, 0), 1) : 0;
  const card = (
    <Card style={{ padding: 14 }}>
      <Row style={{ justifyContent: 'space-between', marginBottom: 10 }}>
        <Row gap={11}>
          <Avatar initials={initials(pack.withName)} size={38} radius={11} fontSize={13} />
          <View>
            <Text style={[t.labelSm, { color: c.txt }]}>{pack.total}-session pack</Text>
            <Text style={[t.caption, { color: c.txt2, marginTop: 1 }]}>{withLabel}</Text>
          </View>
        </Row>
        <Text style={[t.priceSm, { color: c.accent }]}>{pack.remaining} left</Text>
      </Row>
      <View style={{ height: 6, borderRadius: 999, backgroundColor: c.surface2, overflow: 'hidden' }}>
        <View style={{ width: `${filled * 100}%`, height: 6, borderRadius: 999, backgroundColor: c.volt }} />
      </View>
      <Row style={{ justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
        <Text style={[t.caption, { color: c.txt2 }]}>{progressSummary(pack)}</Text>
        {/* The whole card is the button -- this is the label that says so,
            not a second control inside the first one. */}
        {onBook && (
          <Row gap={4} style={{ alignItems: 'center' }}>
            <Text style={[t.label, { color: c.accent }]}>Book a session</Text>
            <Icon name="chevron-right" size={16} color={c.accent} />
          </Row>
        )}
      </Row>

      {request && (
        <View style={{ marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: c.line2 }}>
          {(request.status === 'requested' || request.status === 'offered') && (
            <>
              <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <Text style={[t.bodySm, { color: c.txt2, flex: 1 }]}>
                  {request.status === 'requested'
                    ? `Cancellation asked for. Waiting on ${pack.withName.split(' ')[0]}.`
                    : 'Settling on what comes back'}
                </Text>
                {onWithdraw && (
                  <Button label="Take it back" icon="rotate-ccw" onPress={onWithdraw}
                    accessibilityLabel="Take the cancellation request back" />
                )}
              </Row>
              {onSettled && (
                <RefundNegotiation request={request}
                  suggestedCents={suggestedRefundCents(pack, priceCents)}
                  onSettled={onSettled} />
              )}
            </>
          )}
          {/* Said out loud rather than by the panel disappearing, which read
              as the app forgetting the request had been made. */}
          {request.status === 'withdrawn' && (
            <Text style={[t.bodySm, { color: c.txt2 }]}>
              You took that cancellation request back. Ask again whenever you like.
            </Text>
          )}
          {request.status === 'approved' && (
            <>
              <Text style={[t.bodySm, { color: c.danger }]}>
                Cancelled{request.refundCents !== null ? ` · ${formatCents(request.refundCents)} back` : ''}
              </Text>
              {/* Said plainly: with payments off the app only records what the
                  two of them agreed; with them on it sends the refund back. */}
              <Text style={[t.caption, { color: c.txt3, marginTop: 2 }]}>
                {takesPayment
                  ? 'BOOK’D sends the refund back to the card or Whish account that paid.'
                  : `${pack.withName.split(' ')[0]} pays you directly — BOOK’D does not move money.`}
              </Text>
            </>
          )}
          {request.status === 'rejected' && (
            <Text style={[t.bodySm, { color: c.txt2 }]}>
              {pack.withName.split(' ')[0]} declined the cancellation. Your sessions are still yours.
            </Text>
          )}
        </View>
      )}
    </Card>
  );
  // The ask sits outside the pressable card: nesting a button inside a button
  // makes which one fired a matter of luck.
  const ask = onAskCancel ? (
    <Button label="Request cancellation" icon="x-circle" tone="danger" onPress={onAskCancel}
      accessibilityLabel={`Ask to cancel the package ${withLabel}`} />
  ) : null;

  return (
    <View style={{ gap: 2 }}>
      {onBook ? (
        <Pressable onPress={onBook} accessibilityRole="button"
          accessibilityLabel={`Book one of the ${pack.remaining} sessions left ${withLabel}`}>
          {card}
        </Pressable>
      ) : card}
      {ask}
    </View>
  );
}

function PackageCard({ pack }: { pack: PackageBalance }) {
  const { c, t } = useTheme();
  const expiry = formatExpiry(pack.expiresOn);
  // A zero total would divide by zero and, worse, imply a full bar.
  const progress = pack.total > 0 ? Math.min(Math.max(pack.used / pack.total, 0), 1) : 0;
  const left = Math.max(pack.total - pack.used, 0);
  return (
    <Card style={{ padding: 14 }}>
      <Row style={{ justifyContent: 'space-between', marginBottom: 10 }}>
        <Row gap={11}>
          <Avatar initials={initials(pack.coachName)} size={38} radius={11} fontSize={13} />
          <View>
            <Text style={[t.labelSm, { color: c.txt }]}>{pack.coachName} · {pack.label}</Text>
            <Text style={[t.caption, { color: c.txt2, marginTop: 1 }]}>
              {pack.used} of {pack.total} used{expiry ? ` · ${expiry}` : ''}
            </Text>
          </View>
        </Row>
        <Text style={[t.priceSm, { color: c.accent }]}>{left} left</Text>
      </Row>
      <View style={{ height: 6, borderRadius: 999, backgroundColor: c.surface2, overflow: 'hidden' }}>
        <View style={{ width: `${progress * 100}%`, height: 6, borderRadius: 999, backgroundColor: c.volt }} />
      </View>
    </Card>
  );
}

function SessionCard({
  booking,
  confirming = false,
  busy = false,
  onAskCancel,
  onKeep,
  onConfirmCancel,
  onAccept,
  onConfirmDone,
  ratings,
  onOpen,
}: {
  booking: MyBooking;
  confirming?: boolean;
  busy?: boolean;
  onAskCancel?: () => void;
  onKeep?: () => void;
  onConfirmCancel?: () => void;
  onAccept?: () => void;
  /** Every rating either party left on this session. Archive cards only. */
  ratings?: SessionRating[];
  /** Opens the detail sheet. Archive cards only -- a live session has nothing
   *  to look back at. */
  onOpen?: () => void;
  /** Present only on a session whose time has passed and which is still
   *  waiting to be confirmed by this account. */
  onConfirmDone?: () => void;
}) {
  const { c, t } = useTheme();
  const s = useStore();
  const config = usePaymentConfig();
  // With payments on, a pending coach session is one the booker has not paid
  // for; with them off it is one the coach has not answered.
  const payNow = booking.status === 'pending' && booking.kind === 'coach' && paymentsOn(config, 'session');
  const badge = statusTint(booking.status, c);
  const kind = kindTint(booking.kind, c);
  const when = formatSessionWhen(booking);
  const cancellable = Boolean(onAskCancel) && canCancel(booking.status, booking.scheduledFor);
  // One two-step confirm serves two different decisions: dropping a session
  // you already have, and turning down one somebody just asked you for. The
  // mechanism underneath is the same call, but the person reading it pressed
  // a different word, so the words here follow the button, not the call.
  const ask = booking.needsAnswer && onAccept
    ? {
      question: 'Decline this session? They are told you cannot make it.',
      keep: 'Back',
      keepLabel: `Leave the request from ${booking.withName} unanswered`,
      confirm: 'Yes, decline',
      working: 'Declining…',
      confirmLabel: `Confirm declining training with ${booking.withName} on ${when}`,
    }
    : {
      question: 'Cancel this session?',
      keep: 'Keep',
      keepLabel: `Keep your session with ${booking.withName} on ${when}`,
      confirm: 'Yes, cancel',
      working: 'Cancelling…',
      confirmLabel: `Confirm cancelling your session with ${booking.withName} on ${when}`,
    };
  return (
    <Card style={{ padding: 14, borderLeftWidth: 3, borderLeftColor: kind.rail }}>
      <Row gap={11}>
        <Avatar initials={initials(booking.withName)} size={40} radius={12} fontSize={14} />
        <View style={{ flex: 1 }}>
          <Text style={[t.name, { color: c.txt }]}>{booking.withName}</Text>
          <Text style={[t.bodySm, { color: c.txt2, marginTop: 1 }]}>{when}</Text>
        </View>
        <Row gap={6}>
          <MicroBadge label={kind.label} bg={kind.bg} fg={kind.fg} />
          {payNow ? (
            <Pressable onPress={() => s.set('overlay', 'paymentHistory')} accessibilityRole="button"
              accessibilityLabel="Awaiting payment. Open payments to pay.">
              <MicroBadge label="Awaiting payment" bg={badge.bg} fg={badge.fg} />
            </Pressable>
          ) : (
            <MicroBadge label={bookingStatusLabel(booking.status)} bg={badge.bg} fg={badge.fg} />
          )}
        </Row>
      </Row>

      {/* Its time has passed and it is still open, so the only thing left to
          settle is whether it actually happened. Both of you have to say so --
          the coach is the one party who gains by saying it did. */}
      {onConfirmDone && (
        <View style={{ marginTop: 10, gap: 8 }}>
          <Text style={[t.caption, { color: c.txt2 }]}>
            {booking.coachConfirmed
              ? `${booking.withName.split(' ')[0]} says this session happened.`
              : 'Did this session happen?'}
          </Text>
          <Button label="It happened" icon="check" tone="primary" height={44}
            busy={busy} busyLabel="Confirming…" enabled={!busy}
            accessibilityLabel={`Confirm the session with ${booking.withName} happened`}
            onPress={onConfirmDone} />
        </View>
      )}
      {/* In the archive the card carries the rating and the way into the rest
          of it. A live session has neither. */}
      {onOpen && (
        <View style={{ marginTop: 10, gap: 8 }}>
          {ratings && ratings.length > 0 && (
            <Row gap={8} style={{ alignItems: 'center', flexWrap: 'wrap' }}>
              {ratings.map((r) => (
                <Row key={r.authorId} gap={4} style={{ alignItems: 'center' }}>
                  <Text style={[t.caption, { color: c.txt3 }]}>
                    {r.subjectId === booking.withId ? 'You rated' : 'They rated you'}
                  </Text>
                  <Stars value={r.stars} size={12} />
                  {r.feedback ? <Icon name="message-square" size={12} color={c.txt3} /> : null}
                </Row>
              ))}
            </Row>
          )}
          <Button label="View details" icon="chevron-right"
            accessibilityLabel={`View the session with ${booking.withName} on ${when}`}
            onPress={onOpen} />
        </View>
      )}

      {booking.clientConfirmed && !booking.coachConfirmed && (
        <Text style={[t.caption, { color: c.txt3, marginTop: 10 }]}>
          You said this happened. Waiting on {booking.withName.split(' ')[0]}.
        </Text>
      )}

      {/* Hidden while the confirm row is up. Both render "Decline", so asking
          "are you sure?" underneath the button that asked it left two Declines
          on screen and no way to tell which one was the real answer. */}
      {booking.needsAnswer && onAccept && !confirming && (
        <Row style={{ marginTop: 10, justifyContent: 'space-between' }} gap={10}>
          <Text style={[t.caption, { color: c.txt2, flex: 1 }]}>
            {booking.withName.split(' ')[0]} asked you to train.
          </Text>
          <Row gap={14}>
            <TextAction label={busy ? 'Saving…' : 'Accept'} icon="check" busy={busy}
              accessibilityLabel={`Accept training with ${booking.withName} on ${when}`}
              onPress={busy ? undefined : onAccept} />
            <TextAction label="Decline" icon="x" tone="danger"
              accessibilityLabel={`Decline training with ${booking.withName} on ${when}`}
              onPress={busy ? undefined : onAskCancel} />
          </Row>
        </Row>
      )}

      {cancellable && confirming ? (
        <Row style={{ marginTop: 10, justifyContent: 'space-between' }} gap={10}>
          <Text style={[t.caption, { color: c.txt2, flex: 1 }]}>{ask.question}</Text>
          <Row gap={14}>
            <TextAction
              label={ask.keep}
              icon="check"
              accessibilityLabel={ask.keepLabel}
              onPress={busy ? undefined : onKeep}
            />
            <TextAction
              label={busy ? ask.working : ask.confirm}
              icon="x-circle"
              tone="danger"
              busy={busy}
              accessibilityLabel={ask.confirmLabel}
              onPress={busy ? undefined : onConfirmCancel}
            />
          </Row>
        </Row>
      ) : (
        <Row style={{ marginTop: 10 }} gap={8}>
          {/* "Free" rather than "$0" -- a zero price reads like one somebody
              forgot to set, and a partner session has no price by design. */}
          <Text style={[t.caption, { color: c.txt3 }]}>
            {booking.kind === 'partner' ? 'Free' : formatCents(booking.totalCents)}
          </Text>
          <View style={{ flex: 1 }} />
          {cancellable && (
            <TextAction
              label="Cancel"
              icon="x"
              tone="danger"
              accessibilityLabel={`Cancel your session with ${booking.withName} on ${when}`}
              onPress={onAskCancel}
            />
          )}
        </Row>
      )}
    </Card>
  );
}

// The row actions on a booking card. A wrapper rather than <Button> at each
// call site only because the label doubles as the accessible name here: the
// visible word is "Decline" but what is being declined has to be said in full.
function TextAction({
  label,
  icon,
  tone = 'secondary',
  accessibilityLabel,
  onPress,
  busy = false,
}: {
  label: string;
  icon: IconName;
  tone?: ButtonTone;
  accessibilityLabel: string;
  onPress?: () => void;
  busy?: boolean;
}) {
  return (
    <Button label={label} icon={icon} tone={tone} busy={busy}
      enabled={Boolean(onPress)} onPress={onPress ?? (() => {})}
      accessibilityLabel={accessibilityLabel} />
  );
}


// What kind of session it is, in colour AND in words.
//
// Volt for a coach, cyan for a partner -- both are existing theme tokens that
// already work in the light and dark palettes, so neither needed inventing.
//
// The word is not decoration. Colour alone excludes anyone who cannot tell
// these two apart, and this is the only thing distinguishing a session you pay
// for from one you do not.
export function kindTint(kind: SessionKind, c: ReturnType<typeof useTheme>['c']) {
  return kind === 'partner'
    ? { rail: c.cyan, label: 'Partner', bg: alpha(c.cyan, 0.14), fg: c.cyan }
    : { rail: c.volt, label: 'Coach', bg: alpha(c.volt, 0.14), fg: c.accent };
}

// Status colours come straight from the theme tokens the rest of the app uses:
// live = volt, waiting = amber, ended badly = danger, done = neutral.
function statusTint(status: BookingStatus, c: ReturnType<typeof useTheme>['c']) {
  if (status === 'confirmed') return { bg: alpha(c.volt, 0.14), fg: c.accent };
  if (status === 'pending') return { bg: alpha(c.amber, 0.18), fg: c.amberText };
  if (status === 'cancelled' || status === 'no_show') return { bg: alpha(c.danger, 0.12), fg: c.danger };
  return { bg: c.surface2, fg: c.txt2 };
}
