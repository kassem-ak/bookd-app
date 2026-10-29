import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { CheckoutPanel } from '../components/CheckoutPanel';
import { MissingSubject, OverlayHeader, OverlayScaffold } from '../components/Overlay';
import { usePaymentConfig } from '../components/usePaymentConfig';
import { paymentsOn } from '../lib/payments';
import {
  Button, Card, Chip, Field, FormSheet, Icon, IconButton, Row, SectionHeading, VoltButton,
} from '../components/ui';
import { dateKey, monthCells, MONTH_NAMES } from '../lib/calendarGrid';
import { coachPackageOptions } from '../state/models';
import { fetchCoachAvailability } from '../lib/queries';
import { analyticsErrorCode, track } from '../lib/analytics';
import * as D from '../state/sampleData';
import { fetchBlackouts } from '../lib/availability';
import {
  bookPackageSessions, CancellationStatus, fetchCancellations, fetchMyPackages, isOpenRequest,
  PackageCancellation,
  PackageProgress, progressSummary, requestCancellation, SessionSlot,
} from '../lib/packages';
import { bookingDayLabel, errorMessage, SCHED_TIMES, scheduledFor, useStore } from '../state/store';
import { alpha, useTheme } from '../theme';

// The calendar is Monday-first, like every other calendar in the app and
// like coach_availability.weekday.
const DOW = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const CELL_WIDTH = `${100 / 7}%` as const;

const addMonths = (from: Date, months: number) =>
  new Date(from.getFullYear(), from.getMonth() + months, 1);

const sameMonth = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();

// How far ahead the picker offers. The coach's weekly schedule repeats, so a
// month of it is plenty and keeps the list scannable.
const DAYS_AHEAD = 28;

const localDay = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

const byTime = (slots: string[]) => [...slots].sort((a, b) => SCHED_TIMES.indexOf(a) - SCHED_TIMES.indexOf(b));

const minutesInto = (slot: string) => {
  const match = slot.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return 0;
  let hour = Number(match[1]);
  if (match[3].toUpperCase() === 'PM' && hour < 12) hour += 12;
  if (match[3].toUpperCase() === 'AM' && hour === 12) hour = 0;
  return hour * 60 + Number(match[2]);
};

export type BookableDay = { date: string; day: string; dow: string; slots: string[] };

/** The days this coach can actually be booked on, from today forward.
 *
 *  `week` is keyed 0=Mon..6=Sun, the same as `coach_availability.weekday` and
 *  the same as the server's `extract(isodow) - 1`. A null week means the coach
 *  has not set a schedule, which the booking RPC treats as open — so we offer
 *  every day at suggested times rather than hiding the coach.
 *
 *  Today keeps only slots still ahead: the server accepts today, but offering
 *  a 6:30 AM session at 8 PM is offering something that cannot happen.
 *
 *  `closed` is the coach's days off, which beat the weekly schedule. The RPC
 *  refuses them too -- this is so the client does not offer a day that would be
 *  refused, not the thing that makes the refusal true. */
export function bookableDays(
  week: Record<number, string[]> | null,
  now: Date = new Date(),
  closed: string[] = [],
): BookableDay[] {
  const off = new Set(closed);
  const out: BookableDay[] = [];
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const elapsed = now.getHours() * 60 + now.getMinutes();
  for (let i = 0; i < DAYS_AHEAD; i += 1) {
    const date = new Date(start);
    date.setDate(start.getDate() + i);
    const key = localDay(date);
    if (off.has(key)) continue;
    const weekday = (date.getDay() + 6) % 7;
    let slots = byTime(week ? week[weekday] ?? [] : D.slotDefs);
    if (i === 0) slots = slots.filter((slot) => minutesInto(slot) > elapsed);
    if (!slots.length) continue;
    out.push({
      date: key,
      day: String(date.getDate()),
      dow: date.toLocaleDateString(undefined, { weekday: 'short' }),
      slots,
    });
  }
  return out;
}

export function BookingOverlay() {
  const { c, t } = useTheme();
  const s = useStore();
  const p = s.personById(s.openId);

  // EVERY hook runs before the missing-coach return below. Root replaces the
  // people list on refresh, so `p` can go from defined to undefined while this
  // overlay is open; returning early above the hooks changed the hook count
  // between renders and React threw "Rendered fewer hooks than expected",
  // dropping the whole app to the error screen.
  //
  // The first booking records the pack price; later redemptions record zero.
  // Usage establishes pack coverage, not whether the coach has been paid.
  // What this account already owns of each pack, counted from the bookings.
  // The old read was client_package_balances.used, a counter that only went
  // up -- so a cancelled session was gone and the picker offered fewer
  // sessions than the person had actually paid for.
  const [owned, setOwned] = React.useState<Map<string, PackageProgress> | null>(null);
  // A cancellation already asked for, if any. While one is open the pack is
  // frozen: booking more sessions would change the unused count the coach is
  // being asked to refund against.
  const [openRequest, setOpenRequest] = React.useState<PackageCancellation | null>(null);
  // Every cancellation on this coach's packs, by package. `openRequest` above
  // answers "is there a question hanging over this coach"; this answers "can
  // this particular pack still be spent", which is a different question and the
  // one that decides what the screen offers.
  const [packStatus, setPackStatus] = React.useState<Map<string, CancellationStatus>>(new Map());
  const [askingCancel, setAskingCancel] = React.useState(false);
  const [cancelReason, setCancelReason] = React.useState('');
  const [usageLoading, setUsageLoading] = React.useState(true);
  // undefined while the coach's schedule is still loading, null once we know
  // they have not set one.
  const [week, setWeek] = React.useState<Record<number, string[]> | null | undefined>(undefined);
  const [closed, setClosed] = React.useState<string[]>([]);
  // The time sheet opens on tapping a day, so a day tap is one decision
  // rather than two separate lists to hunt through.
  const [pickingTime, setPickingTime] = React.useState(false);
  // Sessions chosen from a multi-session pack, keyed by day so a second tap
  // on the same day replaces the time rather than spending another session
  // of the pack on the same afternoon.
  const [chosenSlots, setChosenSlots] = React.useState<Record<string, string>>({});
  const [bookingError, setBookingError] = React.useState<string | null>(null);
  const [bookingMany, setBookingMany] = React.useState(false);
  const [month, setMonth] = React.useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [bookingQuote, setBookingQuote] = React.useState<{ redeeming: boolean; dueNow: number } | null>(null);
  const paymentConfig = usePaymentConfig();
  const [paid, setPaid] = React.useState(false);
  // False until the checkout panel finds a payment: with payments off there is none, so no pay step flashes.
  const [found, setFound] = React.useState(false);
  // The total the panel charged (0 = confirmed free); null when nothing was paid here.
  const [paidHere, setPaidHere] = React.useState<number | null>(null);
  // A pack booked several at a time: the server returns a count, not the
  // booking ids, so its checkout is found as the newest one instead.
  const [bookedMany, setBookedMany] = React.useState(false);
  const checkoutSubject = bookedMany ? undefined : s.bookedId ?? undefined;
  const personId = p?.id;
  // A new booking (another coach, or booking again) starts unpaid.
  React.useEffect(() => { setPaid(false); setFound(false); setPaidHere(null); }, [personId, s.booked]);
  React.useEffect(() => {
    if (!personId) return;
    let live = true;
    setOwned(null);
    setUsageLoading(true);
    setWeek(undefined);
    fetchMyPackages().then(
      (packs) => {
        if (!live) return;
        setOwned(new Map(packs.map((pack) => [pack.packageId, pack])));
        setUsageLoading(false);
      },
      () => { if (live) setUsageLoading(false); },
    );
    // Independent of the packs: a request that fails to load must not hide
    // the pack itself, and the server refuses a booking on a cancelled pack
    // regardless of what this screen believes.
    fetchCancellations().then(
      (requests) => {
        if (!live) return;
        const mine = requests.filter((request) => request.coachId === personId);
        setOpenRequest(mine.find(
          // 'offered' is open too: a figure is on the table and the unused
          // count is what it is a share of.
          (request) => isOpenRequest(request.status),
        ) ?? null);
        // Newest first from the server, so the first row for a pack is its
        // current state and anything older is history.
        const latest = new Map<string, CancellationStatus>();
        for (const request of mine) {
          if (!latest.has(request.packageId)) latest.set(request.packageId, request.status);
        }
        setPackStatus(latest);
      },
      () => { if (live) { setOpenRequest(null); setPackStatus(new Map()); } },
    );
    // A schedule we cannot read must not hide the coach: fall back to the
    // open-coach offering, which is what the server would accept anyway.
    fetchCoachAvailability(personId).then(
      (rows) => { if (live) setWeek(rows); },
      () => { if (live) setWeek(null); },
    );
    // Days off are a second, independent read. A failure here must not hide the
    // coach: the RPC refuses a closed date anyway, so the worst case is an
    // offered day that comes back with a clear message.
    fetchBlackouts(personId).then(
      (dates) => { if (live) setClosed(dates); },
      () => { if (live) setClosed([]); },
    );
    return () => { live = false; };
  }, [personId]);

  const days = React.useMemo(
    () => (week === undefined ? [] : bookableDays(week, new Date(), closed)),
    [week, closed],
  );
  const bookDate = useStore((state) => state.bookDate);
  const bookSlot = useStore((state) => state.bookSlot);
  // Land on a pack this account is already part-way through.
  //
  // Booking a second session from a ten-pack and being shown "Single session ·
  // $50" is the screen offering to sell something already paid for. If there is
  // an active pack with this coach, that is what the screen opens on.
  React.useEffect(() => {
    const person = useStore.getState().personById(useStore.getState().openId);
    if (!owned || !person) return;
    const options = coachPackageOptions(person);
    const state = useStore.getState();
    const current = options[state.bookPkg];
    const currentRemaining = current?.packageId ? owned.get(current.packageId)?.remaining ?? 0 : 0;
    if (currentRemaining > 0) return;
    const active = options.findIndex(
      (option) => option.packageId && (owned.get(option.packageId)?.remaining ?? 0) > 0,
    );
    if (active >= 0 && active !== state.bookPkg) {
      state.set('bookPkg', active);
      setChosenSlots({});
    }
    // `person` is read through the store rather than listed as a dependency:
    // the people list is replaced on every refresh, and depending on the object
    // would re-run this and fight a choice the person had just made.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owned, personId]);

  const chosen = days.find((entry) => entry.date === bookDate) ?? null;
  // Which days are bookable, by their local key. bookableDays has already
  // applied the weekly hours, the days off and today's elapsed slots, so the
  // calendar colours itself from the same answer the server would give.
  const byDate = React.useMemo(
    () => new Map(days.map((entry) => [entry.date, entry])),
    [days],
  );
  // Paging stops where the offer does. A month with nothing bookable in it is
  // a dead end, and letting someone walk into one is worse than not offering
  // the step.
  const firstMonth = React.useMemo(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  }, []);
  const lastMonth = React.useMemo(() => {
    const last = days[days.length - 1];
    if (!last) return firstMonth;
    const [year, monthNumber] = last.date.split('-').map(Number);
    return new Date(year, monthNumber - 1, 1);
  }, [days, firstMonth]);
  const canGoBack = !sameMonth(month, firstMonth);
  const canGoForward = !sameMonth(month, lastMonth);

  // Select the first real opening once the schedule arrives, and re-select if
  // the day or slot the store is holding is not one this coach offers.
  React.useEffect(() => {
    if (!days.length) return;
    const state = useStore.getState();
    const day = days.find((entry) => entry.date === state.bookDate) ?? days[0];
    const slot = day.slots.includes(state.bookSlot ?? '') ? state.bookSlot : day.slots[0];
    if (state.bookDate !== day.date) state.set('bookDate', day.date);
    if (state.bookSlot !== slot) state.set('bookSlot', slot);
  }, [days]);

  if (!p) return <MissingSubject title="Book a session" message="This coach is no longer available." onBack={s.backToPerson} />;

  // Every chosen session in one call. A loop of single bookings would leave
  // somebody with four of the five they picked and no way to tell which one
  // failed; the server takes the whole list or none of it.
  const bookChosen = async () => {
    if (!selectedPkg?.packageId) return;
    setBookingMany(true);
    setBookingError(null);
    try {
      const slots: SessionSlot[] = picked.map(([date, slot]) => ({
        at: scheduledFor(date, slot),
        label: slot,
      }));
      const count = await bookPackageSessions(p.id, selectedPkg.packageId, slots);
      track('booking_confirmed', { booking_type: 'package', sessions: count });
      setBookingQuote({ redeeming, dueNow });
      setBookedMany(true);
      setChosenSlots({});
      // bookedId null: the panel must not load a stale single-booking subject.
      useStore.setState({ booked: true, bookedId: null });
    } catch (error) {
      track('booking_failed', { error_code: analyticsErrorCode(error) });
      setBookingError(errorMessage(error));
    } finally {
      setBookingMany(false);
    }
  };

  const everyPkg = coachPackageOptions(p);
  // A pack you can still spend: sessions left, and nothing stopping you
  // spending them.
  //
  // `remaining` alone was not that. A cancelled pack keeps its remaining count
  // -- the view reports what was never booked, not what is still yours -- so a
  // member who cancelled found this screen collapsed onto the dead pack with
  // every other package hidden behind it and a button that would not fire. A
  // pack under an open request is frozen for the length of the argument, which
  // is the same dead end for as long as it lasts.
  const spendable = (packageId: string | null | undefined) => {
    if (!packageId) return false;
    if ((owned?.get(packageId)?.remaining ?? 0) <= 0) return false;
    const status = packStatus.get(packageId);
    return !(status && (status === 'approved' || isOpenRequest(status)));
  };
  // Offering the others alongside a live pack invites buying a second one
  // while the first is half unused, and buries the thing they came to spend.
  // With no live pack there is nothing to bury, so the full list comes back.
  const activePkg = everyPkg.find((option) => spendable(option.packageId));
  const pkgs = activePkg ? [activePkg] : everyPkg;
  const selectedPkg = (activePkg ? pkgs[0] : pkgs[s.bookPkg]) ?? pkgs[0];

  // A pack of two or more is booked several sessions at a time. A single
  // session has nothing to choose between, so it keeps the old one-tap path.
  const multi = Boolean(selectedPkg?.packageId) && (selectedPkg?.sessions ?? 1) > 1;
  const picked = Object.entries(chosenSlots)
    .sort(([a], [b]) => (a < b ? -1 : 1));

  const usageKnown = !selectedPkg?.packageId || owned !== null;
  const payKind = selectedPkg?.packageId ? 'package' : 'session';
  const takesPayment = paymentsOn(paymentConfig, payKind);
  const held = selectedPkg?.packageId ? owned?.get(selectedPkg.packageId) : undefined;
  const total = held?.total ?? selectedPkg?.sessions ?? 0;
  const remaining = held ? held.remaining : total;
  // Already bought means already paid for. Booking more of it costs nothing.
  const redeeming = Boolean(held) && remaining > 0;
  // What is still unspent, so the picker stops where the pack does. A pack
  // nobody has bought yet offers all of its sessions.
  const allowance = held ? Math.max(remaining, 0) : selectedPkg?.sessions ?? 1;
  const exhausted = Boolean(held) && remaining <= 0;
  const dueNow = redeeming ? 0 : selectedPkg?.price ?? 0;
  const priceLabel = !usageKnown
    ? usageLoading ? 'Loading…' : 'Unavailable'
    : redeeming
      ? 'Included'
      : dueNow > 0
        ? `$${dueNow}`
        : 'To agree';

  // The server decides whether there is anything to pay: the panel looks for the
  // booking's open checkout and calls onNone when there is none.
  const payStep = !paid;

  if (s.booked) {
    return (
      <OverlayScaffold header={<OverlayHeader title={payStep ? (found ? 'Pay to confirm' : 'Confirming…') : 'Booking confirmed'} onBack={s.closeOverlay} />}>
        <View style={{ paddingHorizontal: 18, alignItems: 'center', paddingTop: 60 }}>
          {payStep ? (
            <View style={{ width: '100%' }}>
              {found && <Text style={[t.overlayTitle, { fontSize: 22, color: c.txt, marginBottom: 12 }]}>Pay to confirm</Text>}
              <CheckoutPanel
                subjectId={checkoutSubject}
                onPaid={(total) => { setPaidHere(total); setPaid(true); }}
                onNone={() => setPaid(true)}
                onFound={() => setFound(true)}
              />
            </View>
          ) : (
            <>
              <View style={{ width: 74, height: 74, borderRadius: 999, backgroundColor: c.volt, alignItems: 'center', justifyContent: 'center' }}>
                <Icon name="check" size={34} color={c.ink} />
              </View>
              <Text style={[t.overlayTitle, { fontSize: 24, color: c.txt, marginTop: 18 }]}>You are booked!</Text>
              <Text style={[t.bodyLg, { color: c.txt2, marginTop: 8, textAlign: 'center' }]}>
                {selectedPkg.name} with {p.name.split(' ')[0]}
                {bookDate ? ` · ${bookingDayLabel(bookDate)}` : ''}{bookSlot ? ` · ${bookSlot}` : ''}
              </Text>
              {bookingQuote && (
                <Text style={[t.bodySm, { color: c.txt3, marginTop: 8, textAlign: 'center' }]}>
                  {bookingQuote.redeeming
                    ? 'Covered by your pack — nothing extra to pay for this booking.'
                    : paidHere === 0
                      ? 'Confirmed — nothing to pay.'
                      : paidHere !== null
                        ? 'Paid. The money is held until the session is done.'
                        : bookingQuote.dueNow > 0
                          ? takesPayment
                            ? 'You can finish paying from Payments in your profile.'
                            : `$${bookingQuote.dueNow} is payable to ${p.name.split(' ')[0]} directly at your session.`
                          : `Agree the price with ${p.name.split(' ')[0]} directly — BOOK'D does not take payment.`}
                </Text>
              )}
              <View style={{ height: 24 }} />
              <View style={{ width: '100%' }}>
                <VoltButton label="View in bookings" onPress={s.goToBookings} />
              </View>
            </>
          )}
        </View>
      </OverlayScaffold>
    );
  }

  return (
    <OverlayScaffold
      header={<OverlayHeader title="Book a session" onBack={s.backToPerson} subtitle={p.name} />}
      bottomBar={
        <View style={{ backgroundColor: c.bg, borderTopColor: c.line, borderTopWidth: 1, padding: 16 }}>
          <Row style={{ justifyContent: 'space-between', marginBottom: 2 }}>
            <Text style={[t.body, { color: c.txt2 }]}>{redeeming ? 'Due now' : 'Total'}</Text>
            <Text style={[t.price, { color: c.accent }]}>{priceLabel}</Text>
          </Row>
          <Text style={[t.caption, { color: c.txt3, marginBottom: 12 }]}>
            {!usageKnown
              ? usageLoading ? 'Checking your pack balance…' : 'Could not check your pack balance. You can still book.'
              : exhausted
                ? 'Every session in this pack has been used. Pick another option.'
                : redeeming
                  ? `Covered by your pack — nothing extra to pay for this booking. ${remaining} of ${total} sessions left in this pack.`
                  : dueNow > 0
                    ? takesPayment
                      ? "You pay when you confirm. BOOK'D holds the money until the session is done."
                      : "Payable to the coach at your session — BOOK'D does not take payment."
                    : "This coach has not set a price. Agree it with them directly — BOOK'D does not take payment."}
          </Text>
          {bookingError && (
            <Text accessibilityRole="alert" style={[t.bodySm, { color: c.danger, marginBottom: 10 }]}>
              {bookingError}
            </Text>
          )}
          <VoltButton
            label={openRequest
              ? 'Cancellation pending'
              : exhausted
              ? 'Pack already used'
              : multi
                ? picked.length > 1
                  ? `Book ${picked.length} sessions`
                  : 'Book this session'
                : 'Confirm booking'}
            // A pack with a cancellation on the table is frozen: booking more
            // of it would change the unused count the coach is being asked to
            // refund against.
            enabled={!exhausted && !openRequest
              && (multi ? picked.length > 0 : Boolean(bookDate && bookSlot))}
            busy={multi ? bookingMany : s.writeBusy === 'booking'}
            busyLabel="Booking..."
            onPress={() => {
              if (multi) {
                void bookChosen();
                return;
              }
              // A late balance read may include this booking's redemption.
              // Only the quote known before submission can describe it.
              const quote = usageKnown ? { redeeming, dueNow } : null;
              setBookingQuote(quote);
              setBookedMany(false);
              void s.confirmBooking().then(() => {
                if (!useStore.getState().booked) return;
                // The amount the screen actually quoted. When the balance was
                // still unknown the event carries no amount at all -- a wrong
                // number in the funnel is worse than a missing one.
                track('booking_confirmed', quote
                  ? { booking_type: quote.redeeming ? 'redemption' : 'purchase', amount_cents: quote.dueNow * 100 }
                  : {});
              });
            }}
          />
        </View>
      }
    >
      <View style={{ paddingHorizontal: 18 }}>
        {/* Package first. What you are buying decides what a day costs, and
            picking the day before the thing being bought put the cheapest
            question last. */}
        <SectionHeading style={{ marginBottom: 11 }}>
          {activePkg ? 'Your package' : 'Package'}
        </SectionHeading>
        <View style={{ gap: 10 }}>
          {pkgs.map((pk, i) => {
            // Collapsed to one pack, that pack is the selection -- bookPkg
            // still indexes the full list, so comparing it here marked the
            // only card on screen as unselected.
            const sel = activePkg ? true : s.bookPkg === i;
            const mine = pk.packageId ? owned?.get(pk.packageId) : undefined;
            return (
              <Pressable key={pk.name} onPress={() => {
                s.set('bookPkg', i);
                // Sessions chosen for the last pack do not belong to this
                // one, and may be more than it has left.
                setChosenSlots({});
                setBookingError(null);
                track('package_selected', { package_index: i, sessions: pk.sessions });
              }}>
                <Card background={sel ? alpha(c.volt, 0.1) : c.surface} borderColor={sel ? c.volt : c.line} style={{ padding: 14 }}>
                  <Row style={{ justifyContent: 'space-between' }}>
                    <View>
                      <Text style={[t.name, { color: c.txt }]}>{pk.name}</Text>
                      <Text style={[t.bodySm, { color: c.txt2, marginTop: 1 }]}>
                        {mine
                          ? `${mine.remaining} of ${mine.total} still to book`
                          : pk.note}
                      </Text>
                    </View>
                    <View style={{ alignItems: 'flex-end' }}>
                      {/* A pack already bought shows what is left of it
                          rather than its price. Quoting the price again on
                          something already paid for reads like a second
                          charge. */}
                      {mine ? (
                        <>
                          <Text style={[t.price, { color: c.accent }]}>{mine.remaining} left</Text>
                          {/* The breakdown only when it says something the
                              number above does not. On an untouched pack it
                              was the same words twice. */}
                          {(mine.booked > 0 || mine.pending > 0 || mine.taken > 0) && (
                            <Text style={[t.caption, { color: c.txt3, marginTop: 1 }]}>
                              {progressSummary(mine)}
                            </Text>
                          )}
                        </>
                      ) : (
                        <Text style={[t.price, { color: c.accent }]}>${pk.price}</Text>
                      )}
                    </View>
                  </Row>
                </Card>
              </Pressable>
            );
          })}
        </View>

        {activePkg && (
          openRequest ? (
            <View style={{ marginTop: 12, borderWidth: 1, borderColor: c.line, borderRadius: 14, padding: 14 }}>
              <Text style={[t.labelSm, { color: c.txt }]}>Cancellation asked for</Text>
              <Text style={[t.bodySm, { color: c.txt2, marginTop: 2 }]}>
                Waiting on {p.name.split(' ')[0]}. Your pack is on hold until it is settled — take the request back in
                My bookings if you want to keep using it.
              </Text>
            </View>
          ) : (
            <Button label="Request cancellation" icon="x-circle" tone="danger" style={{ marginTop: 12 }}
              accessibilityLabel="Request cancellation of this package"
              onPress={() => { setCancelReason(''); setBookingError(null); setAskingCancel(true); }} />
          )
        )}

        <FormSheet
          visible={askingCancel}
          title="Request cancellation"
          subtitle={selectedPkg?.packageId && owned?.get(selectedPkg.packageId)
            ? `${owned.get(selectedPkg.packageId)!.remaining} of ${owned.get(selectedPkg.packageId)!.total} sessions are still unused.`
            : undefined}
          onClose={() => setAskingCancel(false)}
          footer={
            <VoltButton label="Send the request" busy={bookingMany} busyLabel="Sending…"
              enabled={Boolean(selectedPkg?.packageId) && !bookingMany}
              onPress={() => {
                const packageId = selectedPkg?.packageId;
                if (!packageId) return;
                setBookingMany(true);
                setBookingError(null);
                void (async () => {
                  try {
                    await requestCancellation(p.id, packageId, cancelReason);
                    track('package_cancellation_requested');
                    const requests = await fetchCancellations();
                    setOpenRequest(requests.find(
                      (request) => request.coachId === p.id && isOpenRequest(request.status),
                    ) ?? null);
                    setAskingCancel(false);
                  } catch (error) {
                    track('write_failed', { error_code: analyticsErrorCode(error) });
                    setBookingError(errorMessage(error));
                  } finally { setBookingMany(false); }
                })();
              }} />
          }
        >
          <Text style={[t.bodySm, { color: c.txt2 }]}>
            {p.name.split(' ')[0]} decides whether to cancel it and how much to give back — you can settle on a figure
            between you. {paymentsOn(paymentConfig, 'package')
              ? 'Once you both agree, BOOK’D sends the refund back to the card or Whish account that paid.'
              : 'BOOK’D records what you agree; it does not move money.'}
          </Text>
          <Text style={[t.caption, { color: c.txt3 }]}>
            Sessions you have already booked stay in your calendar. Cancel those separately if you do not want them.
          </Text>
          <Field value={cancelReason} onChange={setCancelReason} label="Why, optionally"
            placeholder="Moving away, injured, changed plans" />
        </FormSheet>

        <SectionHeading style={{ marginTop: 22, marginBottom: 11 }}>Pick a day</SectionHeading>
        {week === undefined ? (
          <Text style={[t.bodySm, { color: c.txt3 }]}>Checking when {p.name.split(' ')[0]} is available…</Text>
        ) : days.length === 0 ? (
          <Card style={{ padding: 14 }}>
            <Text style={[t.bodySm, { color: c.txt2 }]}>
              {p.name.split(' ')[0]} has no bookable times in the next four weeks. Message them to arrange a session.
            </Text>
          </Card>
        ) : (
          <>
            <Row style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <IconButton icon="chevron-left" accessibilityLabel="Previous month"
                onPress={() => setMonth(addMonths(month, -1))} enabled={canGoBack} />
              <Text style={[t.labelSm, { color: c.txt }]}>
                {MONTH_NAMES[month.getMonth()]} {month.getFullYear()}
              </Text>
              <IconButton icon="chevron-right" accessibilityLabel="Next month"
                onPress={() => setMonth(addMonths(month, 1))} enabled={canGoForward} />
            </Row>

            <Row>
              {DOW.map((letter, index) => (
                <View key={letter + index} style={{ flex: 1, alignItems: 'center' }}>
                  <Text style={[t.caption, { color: c.txt3 }]}>{letter}</Text>
                </View>
              ))}
            </Row>

            <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
              {monthCells(month.getFullYear(), month.getMonth()).map((day, index) => {
                if (day === null) return <View key={'blank' + index} style={{ width: CELL_WIDTH, height: 48 }} />;
                const key = dateKey(new Date(month.getFullYear(), month.getMonth(), day));
                const entry = byDate.get(key);
                const open = Boolean(entry);
                const sel = multi ? key in chosenSlots : bookDate === key;
                return (
                  <Pressable key={key} disabled={!open}
                    onPress={() => {
                      setBookingError(null);
                      s.set('bookDate', key);
                      // The slot held from the previous day may not exist on
                      // this one -- a coach who works mornings on Monday and
                      // evenings on Wednesday would otherwise keep 9:00 AM
                      // showing on a Wednesday they do not work it.
                      if (entry && !entry.slots.includes(bookSlot ?? '')) s.set('bookSlot', entry.slots[0]);
                      setPickingTime(true);
                    }}
                    accessibilityRole="button"
                    accessibilityState={{ selected: sel, disabled: !open }}
                    accessibilityLabel={entry
                      ? day + ' ' + MONTH_NAMES[month.getMonth()] + ', ' + entry.slots.length + ' times free'
                      : day + ' ' + MONTH_NAMES[month.getMonth()] + ', not available'}
                    style={{ width: CELL_WIDTH, height: 48, alignItems: 'center', justifyContent: 'center' }}>
                    <View style={{ width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center',
                      backgroundColor: sel ? c.volt : open ? alpha(c.volt, 0.14) : 'transparent',
                      borderWidth: open && !sel ? 1 : 0, borderColor: alpha(c.volt, 0.45),
                      opacity: open ? 1 : 0.3 }}>
                      <Text style={[t.bodySm, { color: sel ? c.ink : open ? c.accent : c.txt3 }]}>{day}</Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>

            {/* Colour alone would leave anyone who cannot see it guessing which
                days are which. Every day also says which it is in its
                accessible label; this is the legend for everyone else. */}
            <Row gap={16} style={{ marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <Row gap={6} style={{ alignItems: 'center' }}>
                <View style={{ width: 10, height: 10, borderRadius: 5, borderWidth: 1,
                  borderColor: alpha(c.volt, 0.45), backgroundColor: alpha(c.volt, 0.14) }} />
                <Text style={[t.caption, { color: c.txt2 }]}>Available</Text>
              </Row>
              <Row gap={6} style={{ alignItems: 'center' }}>
                <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: c.volt }} />
                <Text style={[t.caption, { color: c.txt2 }]}>Chosen</Text>
              </Row>
              <Row gap={6} style={{ alignItems: 'center' }}>
                <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: c.surface2 }} />
                <Text style={[t.caption, { color: c.txt2 }]}>Not working</Text>
              </Row>
            </Row>

            {multi ? (
              <View style={{ marginTop: 14, gap: 10 }}>
                <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                  <Text style={[t.labelSm, { color: c.txt }]}>
                    {picked.length} of {allowance} chosen
                  </Text>
                </Row>
                {/* Every session the pack still has, so nobody has to count
                    the pack down themselves. They do not have to book them
                    all now -- what is left stays on the pack. */}
                <Text style={[t.caption, { color: c.txt3 }]}>
                  Book as many as you like now. Whatever you leave stays on the pack for later.
                </Text>
                {picked.map(([date, slot]) => (
                  <Row key={date} gap={10}
                    style={{ alignItems: 'center', borderWidth: 1, borderColor: c.line, borderRadius: 14, padding: 12 }}>
                    <View style={{ flex: 1 }}>
                      <Text style={[t.name, { color: c.txt }]}>{bookingDayLabel(date)}</Text>
                      <Text style={[t.bodySm, { color: c.txt2, marginTop: 1 }]}>{slot}</Text>
                    </View>
                    <Pressable accessibilityRole="button"
                      accessibilityLabel={'Remove ' + bookingDayLabel(date) + ' ' + slot}
                      onPress={() => setChosenSlots((current) => {
                        const next = { ...current };
                        delete next[date];
                        return next;
                      })}
                      style={{ minHeight: 44, width: 44, alignItems: 'flex-end', justifyContent: 'center' }}>
                      <Icon name="x" size={17} color={c.txt3} />
                    </Pressable>
                  </Row>
                ))}
                {picked.length > 0 && (
                  <Button label="Clear" icon="x" accessibilityLabel="Clear the sessions you picked"
                    onPress={() => { setChosenSlots({}); setBookingError(null); }} />
                )}
              </View>
            ) : bookDate && bookSlot ? (
              <Pressable accessibilityRole="button" accessibilityLabel="Change the time"
                onPress={() => setPickingTime(true)} style={{ marginTop: 14 }}>
                <Card background={alpha(c.volt, 0.1)} borderColor={c.volt} style={{ padding: 14 }}>
                  <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                    <View>
                      <Text style={[t.name, { color: c.txt }]}>{bookingDayLabel(bookDate)}</Text>
                      <Text style={[t.bodySm, { color: c.txt2, marginTop: 1 }]}>{bookSlot}</Text>
                    </View>
                    <Text style={[t.label, { color: c.accent }]}>Change</Text>
                  </Row>
                </Card>
              </Pressable>
            ) : null}

            {/* An open coach is a coach who never set their hours. The server
                accepts any time for them, so say these are suggestions rather
                than implying a schedule that does not exist. */}
            {week === null && (
              <Text style={[t.caption, { color: c.txt3, marginTop: 10 }]}>
                {p.name.split(' ')[0]} has not published a schedule. These are suggested times — confirm the exact time with them.
              </Text>
            )}
          </>
        )}

        <FormSheet
          visible={pickingTime && Boolean(chosen)}
          title={chosen ? bookingDayLabel(chosen.date) : 'Pick a time'}
          subtitle={chosen ? chosen.slots.length + (chosen.slots.length === 1 ? ' time free' : ' times free') : undefined}
          onClose={() => setPickingTime(false)}
        >
          <Row style={{ flexWrap: 'wrap' }} gap={9}>
            {(chosen ? chosen.slots : []).map((slot) => {
              const sel = multi && chosen ? chosenSlots[chosen.date] === slot : bookSlot === slot;
              return (
                <Chip key={slot} label={slot} active={sel}
                  onPress={() => {
                    if (multi && chosen) {
                      const already = chosen.date in chosenSlots;
                      // Refuse quietly rather than silently dropping one: the
                      // pack has a size, and spending past it is what the
                      // server refuses anyway.
                      if (!already && picked.length >= allowance) {
                        setBookingError('That is every session this pack has left.');
                        setPickingTime(false);
                        return;
                      }
                      setChosenSlots((current) => ({ ...current, [chosen.date]: slot }));
                    }
                    s.set('bookSlot', slot);
                    setPickingTime(false);
                  }} />
              );
            })}
          </Row>
        </FormSheet>
      </View>
    </OverlayScaffold>
  );
}
