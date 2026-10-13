import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { formatCents } from '../lib/bookings';
import {
  applyPromoCode, fetchAwaitingPayment, listPaymentMethods, MyPayment, PaymentMethod, payFor, removePromoCode,
} from '../lib/payments';
import { useTheme } from '../theme';
import { AddPaymentMethod } from './AddPaymentMethod';
import { PracticeBanner } from './PracticeBanner';
import { Button, Chip, ErrorNote, Field, Row, VoltButton } from './ui';

/** The ways to pay, as chips. Kept separate so another option (a wallet) is one more chip here. */
function PayOptions({ methods, chosen, onChoose }: {
  methods: PaymentMethod[]; chosen: string | null; onChoose: (id: string) => void;
}) {
  return (
    <Row gap={8} style={{ flexWrap: 'wrap' }}>
      {methods.map((m) => (
        <Chip key={m.id} label={m.display} active={chosen === m.id} onPress={() => onChoose(m.id)} />
      ))}
    </Row>
  );
}

/** Pay for what was just booked. The booking is held as pending until this
 *  succeeds and is released automatically if it does not within the checkout
 *  time, so leaving this screen never leaves a half-paid booking behind. */
export function CheckoutPanel({ subjectId, onPaid, onNone, onFound }: {
  /** The booking, reservation or event being paid for; without it, the newest open checkout. */
  subjectId?: string;
  /** Called with the total that was charged; 0 means it was confirmed for free. */
  onPaid: (totalCents: number) => void;
  /** Called when there is nothing awaiting payment (already paid, or released). */
  onNone?: () => void;
  /** Called once, the first time a payment is loaded. */
  onFound?: () => void;
}) {
  const { c, t } = useTheme();
  const [payment, setPayment] = useState<MyPayment | null | undefined>(undefined);
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [codeBusy, setCodeBusy] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const onNoneRef = useRef(onNone);
  onNoneRef.current = onNone;
  const onFoundRef = useRef(onFound);
  onFoundRef.current = onFound;
  const foundRef = useRef(false);

  const load = useCallback(async () => {
    const [p, m] = await Promise.all([fetchAwaitingPayment(subjectId), listPaymentMethods()]);
    const payable = m.filter((x) => x.canPay);
    setPayment(p);
    if (!p) onNoneRef.current?.();
    else if (!foundRef.current) { foundRef.current = true; onFoundRef.current?.(); }
    setMethods(payable);
    setChosen((current) => current ?? payable.find((x) => x.defaultPay)?.id ?? payable[0]?.id ?? null);
  }, [subjectId]);
  const first = useCallback(() => {
    setLoadFailed(false);
    load().catch(() => setLoadFailed(true));
  }, [load]);
  useEffect(() => { first(); }, [first]);
  // Re-read the clock so the countdown caption ticks; never used to disable paying.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);

  if (loadFailed && !payment) return <ErrorNote message="Could not load your payment." onRetry={first} />;
  if (payment === undefined) return <ActivityIndicator color={c.accent} style={{ marginVertical: 24 }} />;
  if (payment === null) return null;

  const total = payment.priceCents + payment.feeCents;
  const free = total === 0;
  const minutesLeft = Math.max(0, Math.ceil((Date.parse(payment.expiresAt) - now) / 60000));
  const pay = async () => {
    if (!free && !chosen) return;
    setBusy(true); setMessage(null);
    try {
      // A free total is confirmed without a method; the server ignores it.
      const result = await payFor(payment.id, free ? '' : chosen!);
      if (result.ok) onPaid(total);
      else setMessage(result.message);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'The payment did not go through.');
    } finally {
      setBusy(false);
    }
  };
  const changeCode = async (action: () => Promise<unknown>) => {
    setCodeBusy(true); setMessage(null);
    try { await action(); setCode(''); await load(); }
    catch (e) { setMessage(e instanceof Error ? e.message : 'That code could not be applied.'); }
    finally { setCodeBusy(false); }
  };

  return (
    <View style={{ gap: 12, width: '100%' }}>
      <PracticeBanner />
      <Row style={{ justifyContent: 'space-between' }}>
        <Text style={[t.body, { color: c.txt2 }]}>Price</Text>
        {/* priceCents is after the discount; the list price is shown, then the discount line. */}
        <Text style={[t.body, { color: c.txt }]}>{formatCents(payment.priceCents + payment.discountCents)}</Text>
      </Row>
      {payment.discountCents > 0 && (
        <Row style={{ justifyContent: 'space-between' }}>
          <Text style={[t.body, { color: c.txt2 }]}>Discount</Text>
          <Text style={[t.body, { color: c.txt }]}>{`−${formatCents(payment.discountCents)}`}</Text>
        </Row>
      )}
      <Row style={{ justifyContent: 'space-between' }}>
        <Text style={[t.body, { color: c.txt2 }]}>Payment fee</Text>
        <Text style={[t.body, { color: c.txt }]}>{formatCents(payment.feeCents)}</Text>
      </Row>
      <Row style={{ justifyContent: 'space-between' }}>
        <Text style={[t.bodyLg, { color: c.txt }]}>Total</Text>
        <Text style={[t.price, { color: c.accent }]}>{formatCents(total)}</Text>
      </Row>
      {payment.promoCode ? (
        <Row gap={8} style={{ justifyContent: 'space-between' }}>
          <Text style={[t.body, { color: c.txt }]}>Code APPLIED: {payment.promoCode}</Text>
          <Button label="Remove" tone="secondary" busy={codeBusy} busyLabel="Removing..."
            onPress={() => void changeCode(() => removePromoCode(payment.id))} />
        </Row>
      ) : (
        <Row gap={8}>
          <View style={{ flex: 1 }}>
            <Field label="Discount code" placeholder="CODE" value={code} onChange={setCode} />
          </View>
          <Button label="Apply" tone="secondary" enabled={code.trim().length > 0} busy={codeBusy} busyLabel="Applying..."
            onPress={() => void changeCode(() => applyPromoCode(payment.id, code.trim()))} />
        </Row>
      )}
      <Text style={[t.caption, { color: c.txt3 }]}>
        The money is held by BOOK'D until the booking is done. Cancel before then and the price comes back to you;
        the payment fee does not.{' '}
        {minutesLeft > 0
          ? `Finish within ${minutesLeft} min or the slot is released.`
          : 'This checkout may have expired. If paying fails, book again.'}
      </Text>
      {free ? null : methods.length > 0 ? (
        <PayOptions methods={methods} chosen={chosen} onChoose={setChosen} />
      ) : (
        <AddPaymentMethod onAdded={(id) => { setChosen(id); void load(); }} />
      )}
      {message && <Text accessibilityRole="alert" style={[t.bodySm, { color: c.danger }]}>{message}</Text>}
      <VoltButton
        label={free ? 'Confirm for free' : `Pay ${formatCents(total)}`}
        enabled={free || Boolean(chosen)}
        busy={busy}
        busyLabel={free ? 'Confirming...' : 'Paying...'}
        onPress={() => void pay()}
      />
    </View>
  );
}
