import React, { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { CheckoutPanel } from '../components/CheckoutPanel';
import { Sheet } from '../components/Sheet';
import { usePaymentConfig } from '../components/usePaymentConfig';
import { Chip, Row, Segmented, SectionHeading, Toggle, VoltButton } from '../components/ui';
import { formatCents } from '../lib/bookings';
import { Venue } from '../lib/courts';
import { paymentsOn } from '../lib/payments';
import { perHourLabel, rsvpSubject } from '../state/courtsData';
import { useStore } from '../state/store';
import { radii, useTheme } from '../theme';

// Delta section C. Booking type, day + start time, hours stepper, equipment
// rent, add-a-coach (routes into the coach calendar), live total estimate.
export const RSVP_TYPES = ['Single', 'Teams', 'Member of team'] as const;
export type RsvpType = (typeof RSVP_TYPES)[number];

const MIN_HOURS = 1;
// reserve_court accepts 1..12; the sheet keeps the tighter product limit.
const MAX_HOURS = 6;
const DAYS_AHEAD = 14;
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function hourOf(time: string) {
  const hour = Number(time.split(':')[0]);
  return Number.isFinite(hour) ? hour : 0;
}

/** Closing at or before opening means the venue closes after midnight. */
function closingHour(venue: Venue) {
  const open = hourOf(venue.opensAt);
  const close = hourOf(venue.closesAt);
  return close <= open ? close + 24 : close;
}

// 0 = Mon .. 6 = Sun, matching venues.open_weekdays.
const weekdayIndex = (date: Date) => (date.getDay() + 6) % 7;

function openDates(venue: Venue) {
  const out: Date[] = [];
  const today = new Date();
  for (let offset = 0; offset < DAYS_AHEAD && out.length < 7; offset += 1) {
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset);
    if (venue.openWeekdays.includes(weekdayIndex(day))) out.push(day);
  }
  return out;
}

/**
 * Start times that fit a booking of `hours` inside the venue's opening hours.
 *
 * ponytail: built on the device clock, so a phone set to another time zone will
 * offer slots shifted from the venue's own wall clock. The server checks the
 * real window (venue_slot_is_open) and refuses with "the venue is not open for
 * that time window", so the worst case is a rejected tap, not a wrong charge.
 * Upgrade path: convert through venue.timezone when picking the instant.
 */
function startTimes(venue: Venue, day: Date, hours: number) {
  const first = hourOf(venue.opensAt);
  const last = closingHour(venue) - hours;
  const now = new Date();
  const out: Date[] = [];
  for (let hour = first; hour <= last; hour += 1) {
    const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, 0, 0, 0);
    // reserve_court rejects the past outright; do not offer it.
    if (at.getTime() > now.getTime()) out.push(at);
  }
  return out;
}

function dayLabel(day: Date) {
  const today = new Date();
  const isToday =
    day.getDate() === today.getDate() &&
    day.getMonth() === today.getMonth() &&
    day.getFullYear() === today.getFullYear();
  return isToday ? 'Today' : `${DAY_NAMES[day.getDay()]} ${String(day.getDate()).padStart(2, '0')}`;
}

function timeLabel(at: Date) {
  const hours = at.getHours();
  const period = hours >= 12 ? 'PM' : 'AM';
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${hour12}:${String(at.getMinutes()).padStart(2, '0')} ${period}`;
}

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

export function RsvpSheet() {
  const { c, t } = useTheme();
  const s = useStore();

  const subject = rsvpSubject(s.venues, s.rsvpRef);
  const target = subject?.title ?? s.rsvpTarget ?? null;
  const type = s.rsvpType as RsvpType;
  const hours = Math.max(MIN_HOURS, Math.round(Number(s.rsvpHours)) || MIN_HOURS);
  const gear = s.rsvpGear;
  const coach = s.rsvpCoach;

  const venue = subject?.venue ?? null;
  const perHour = s.rsvpPerHour;
  const gearRate = subject?.equipmentCentsPerHour ?? null;
  // Display estimate only — the server writes the total that is charged.
  const total = s.rsvpTotal();
  const busy = s.writeBusy === 'rsvp';

  const startsAt = s.rsvpStartsAt ? new Date(s.rsvpStartsAt) : null;
  const days = venue ? openDates(venue) : [];
  const selectedDay = startsAt ?? days[0] ?? null;
  const times = venue && selectedDay ? startTimes(venue, selectedDay, hours) : [];

  const close = () => s.set('sheet', null);

  const pickDay = (day: Date) => {
    if (!venue) return;
    // Changing the day invalidates the chosen instant; move to that day's first
    // open slot rather than silently keeping the old one.
    const [first] = startTimes(venue, day, hours);
    s.set('rsvpStartsAt', first ? first.toISOString() : null);
  };

  const setHours = (n: number) => {
    const next = Math.min(MAX_HOURS, Math.max(MIN_HOURS, n));
    s.set('rsvpHours', next);
    // A longer booking can run past closing, so drop a start that no longer fits.
    if (venue && startsAt && startsAt.getHours() + next > closingHour(venue)) {
      s.set('rsvpStartsAt', null);
    }
  };

  const [booked, setBooked] = useState(false);
  const paymentConfig = usePaymentConfig();
  const [paid, setPaid] = useState(false);
  const [noPayment, setNoPayment] = useState(false);
  const [found, setFound] = useState(false);
  const takesPayment = paymentsOn(paymentConfig, perHour ? 'court' : 'tournament');
  const confirm = () => {
    void s.confirmRsvp().then((ok) => { if (ok) setBooked(true); });
  };

  const canConfirm = Boolean(subject) && (!perHour || Boolean(s.rsvpStartsAt));

  // The server decides whether there is anything to pay: the panel looks for
  // this reservation's open checkout and calls onNone when there is none.
  if (booked && !paid && !noPayment) {
    return (
      <Sheet title={found ? 'Pay to confirm' : 'Confirming…'} subtitle={venue ? venue.name : ''} onClose={close}>
        <View style={{ padding: 16 }}>
          <CheckoutPanel subjectId={s.rsvpBookedId ?? undefined}
            onPaid={() => setPaid(true)} onNone={() => setNoPayment(true)} onFound={() => setFound(true)} />
        </View>
      </Sheet>
    );
  }

  if (booked) {
    return (
      <Sheet
        title="Court reserved"
        subtitle={venue ? venue.name : ''}
        onClose={close}
        footer={<VoltButton label="Done" icon="check" onPress={close} />}
      >
        <View style={{ gap: 10, paddingVertical: 4 }}>
          <Text style={[t.bodyLg, { color: c.txt }]}>{target}</Text>
          {startsAt && (
            <Text style={[t.body, { color: c.txt2 }]}>
              {startsAt.toLocaleString(undefined, {
                weekday: 'long', day: 'numeric', month: 'long',
                hour: 'numeric', minute: '2-digit',
              })}
              {perHour ? ` · ${hours} ${hours === 1 ? 'hour' : 'hours'}` : ''}
            </Text>
          )}
          <Text style={[t.price, { color: c.accent }]}>{formatCents(total)}</Text>
          <Text style={[t.caption, { color: c.txt3 }]}>
            {paid
              ? 'It is in My bookings now. Paid — BOOK’D holds the money until it is done.'
              : 'It is in My bookings now. The venue is paid at the door — BOOK’D does not move money.'}
          </Text>
        </View>
      </Sheet>
    );
  }

  return (
    <Sheet
      title={target ? 'RSVP · ' + target : 'RSVP'}
      subtitle={
        (venue ? venue.name + ' · ' : '') +
        (perHour ? perHourLabel(s.rsvpPriceCents) : formatCents(s.rsvpPriceCents) + ' entry')
      }
      onClose={close}
      footer={
        <VoltButton
          label={coach ? 'Continue to coach calendar' : 'Confirm RSVP'}
          onPress={confirm}
          enabled={canConfirm}
          busy={busy}
          busyLabel="Reserving..."
        />
      }
    >
      <SectionHeading style={{ color: c.txt3, marginBottom: 9 }}>Booking type</SectionHeading>
      <Segmented
        options={RSVP_TYPES.map((k) => ({ key: k, label: k }))}
        selected={type}
        onSelect={(k) => s.set('rsvpType', k)}
        fontSize={12.5}
        pad={11}
      />

      {/* A tournament is a flat per-team entry fee, so a start time, hours and
          hourly equipment hire do not apply to it. */}
      {perHour && venue && (
        <>
          <SectionHeading style={{ color: c.txt3, marginTop: 20, marginBottom: 9 }}>Day</SectionHeading>
          <ChipScroller>
            {days.map((day) => (
              <PickChip
                key={day.toDateString()}
                label={dayLabel(day)}
                accessibilityLabel={`Book on ${dayLabel(day)}`}
                active={Boolean(startsAt && sameDay(startsAt, day))}
                onPress={() => pickDay(day)}
              />
            ))}
          </ChipScroller>
          {days.length === 0 && (
            <Text style={[t.bodySm, { color: c.txt3 }]}>No open days in the next two weeks.</Text>
          )}

          <SectionHeading style={{ color: c.txt3, marginTop: 20, marginBottom: 9 }}>Start time</SectionHeading>
          <ChipScroller>
            {times.map((at) => (
              <PickChip
                key={at.toISOString()}
                label={timeLabel(at)}
                accessibilityLabel={`Start at ${timeLabel(at)}`}
                active={Boolean(startsAt && startsAt.getTime() === at.getTime())}
                onPress={() => s.set('rsvpStartsAt', at.toISOString())}
              />
            ))}
          </ChipScroller>
          {times.length === 0 && (
            <Text style={[t.bodySm, { color: c.txt3 }]}>
              No {hours}-hour slot left that day — pick another day or fewer hours.
            </Text>
          )}

          <SectionHeading style={{ color: c.txt3, marginTop: 20, marginBottom: 9 }}>Number of hours</SectionHeading>
          <Row
            style={{
              backgroundColor: c.surface,
              borderColor: c.line,
              borderWidth: 1,
              borderRadius: radii.input,
              paddingHorizontal: 14,
              paddingVertical: 11,
            }}
            gap={12}
          >
            <StepperButton
              label="Decrease hours"
              glyph="−"
              disabled={hours <= MIN_HOURS}
              onPress={() => setHours(hours - 1)}
            />
            <Text
              accessibilityRole="text"
              accessibilityLabel={hours + (hours === 1 ? ' hour' : ' hours') + ' booked'}
              style={[t.overlayTitle, { fontSize: 17, color: c.txt, flex: 1, textAlign: 'center' }]}
            >
              {hours} {hours === 1 ? 'hour' : 'hours'}
            </Text>
            <StepperButton
              label="Increase hours"
              glyph="+"
              disabled={hours >= MAX_HOURS}
              onPress={() => setHours(hours + 1)}
            />
          </Row>

          {/* No gear rate means the venue hires no equipment and reserve_court
              would refuse; do not offer the toggle at all. */}
          {gearRate !== null && (
            <ToggleRow
              title="Equipment rent"
              subtitle={'Rackets & balls · +' + perHourLabel(gearRate)}
              value={gear}
              onChange={(v) => s.set('rsvpGear', v)}
              style={{ marginTop: 20 }}
            />
          )}
        </>
      )}
      <ToggleRow
        title="Add a coach"
        subtitle="Opens the coach's calendar next · billed with the coach"
        value={coach}
        onChange={(v) => s.set('rsvpCoach', v)}
        style={{ marginTop: 11 }}
      />

      <Row
        style={{
          marginTop: 20,
          backgroundColor: c.surface2,
          borderRadius: radii.input,
          paddingHorizontal: 15,
          paddingVertical: 13,
        }}
      >
        <View style={{ flex: 1 }}>
          <Text style={[t.label, { color: c.txt }]}>Total</Text>
          <Text style={[t.caption, { fontSize: 11.5, color: c.txt3, marginTop: 2 }]}>
            {takesPayment ? 'You pay this when you confirm' : 'Estimate · confirmed by the venue'}
          </Text>
        </View>
        <Text style={[t.price, { fontSize: 18, color: c.accent }]}>{formatCents(total)}</Text>
      </Row>
    </Sheet>
  );
}

function ChipScroller({ children }: { children: React.ReactNode }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
      {children}
    </ScrollView>
  );
}

// `Chip` is shared and carries no accessibility props, so wrap it the way
// ToggleRow wraps `Toggle`.
function PickChip({
  label,
  accessibilityLabel,
  active,
  onPress,
}: {
  label: string;
  accessibilityLabel: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <View accessible accessibilityRole="button" accessibilityLabel={accessibilityLabel} accessibilityState={{ selected: active }}>
      <Chip label={label} active={active} onPress={onPress} />
    </View>
  );
}

function StepperButton({
  label,
  glyph,
  disabled,
  onPress,
}: {
  label: string;
  glyph: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  const { c, t } = useTheme();
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled) }}
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      style={{
        width: 34,
        height: 34,
        borderRadius: 10,
        backgroundColor: c.surface2,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.45 : 1,
      }}
    >
      <Text style={[t.overlayTitle, { fontSize: 17, color: c.txt2 }]}>{glyph}</Text>
    </Pressable>
  );
}

function ToggleRow({
  title,
  subtitle,
  value,
  onChange,
  style,
}: {
  title: string;
  subtitle: string;
  value: boolean;
  onChange: (v: boolean) => void;
  style?: React.ComponentProps<typeof View>['style'];
}) {
  const { c, t } = useTheme();
  return (
    <Row
      style={[
        {
          backgroundColor: c.surface,
          borderColor: c.line,
          borderWidth: 1,
          borderRadius: radii.input,
          paddingHorizontal: 14,
          paddingVertical: 13,
          minHeight: 44,
        },
        style,
      ]}
      gap={12}
    >
      <View style={{ flex: 1 }}>
        <Text style={[t.label, { fontSize: 14.5, color: c.txt }]}>{title}</Text>
        <Text style={[t.caption, { fontSize: 12, color: c.txt2, marginTop: 2 }]}>{subtitle}</Text>
      </View>
      <View accessible accessibilityLabel={title}>
        <Toggle value={value} onChange={onChange} />
      </View>
    </Row>
  );
}
