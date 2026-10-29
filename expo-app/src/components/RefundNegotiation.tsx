import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { Button, Row, VoltButton } from './ui';
import { formatCents } from '../lib/bookings';
import {
  acceptRefund, fetchRefundOffers, offerRefund, PackageCancellation, RefundOffer, standingOffer,
} from '../lib/packages';
import { money, parseMoney } from '../lib/pricing';
import { analyticsErrorCode, track } from '../lib/analytics';
import { errorMessage } from '../state/store';
import { alpha, useTheme } from '../theme';
import { usePaymentConfig } from './usePaymentConfig';
import { paymentsOn } from '../lib/payments';

// Settling on what comes back.
//
// One component for both sides on purpose. The client and the coach are doing
// the same thing -- reading the figures so far, and either accepting the one on
// the table or naming another -- and two implementations of that would be two
// places for the amounts to be presented differently.
//
// With payments off the app only records an agreement and does not move money,
// and the copy says so wherever a figure appears. With them on, the refund goes
// back to whatever paid.
export function RefundNegotiation({ request, suggestedCents, onSettled }: {
  request: PackageCancellation;
  /** What to put in the box before anyone types: the unused share of what was
   *  paid. A starting point, not a rule. */
  suggestedCents: number;
  onSettled: () => void;
}) {
  const { c, t } = useTheme();
  const takesPayment = paymentsOn(usePaymentConfig(), 'package');
  const [offers, setOffers] = useState<RefundOffer[] | null>(null);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const rows = await fetchRefundOffers(request.id);
      setOffers(rows);
      // The box follows the conversation: counter from what they asked, not
      // from a figure nobody has mentioned since the first message.
      const last = rows[rows.length - 1];
      setAmount(money(last ? last.amountCents : suggestedCents));
    } catch (e) {
      setOffers([]);
      setError(errorMessage(e));
    }
  }, [request.id, suggestedCents]);

  useEffect(() => { void load(); }, [load]);

  const run = async (write: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await write();
      await load();
      onSettled();
    } catch (e) {
      track('write_failed', { error_code: analyticsErrorCode(e) });
      setError(errorMessage(e));
    } finally { setBusy(false); }
  };

  const settled = request.status === 'approved' || request.status === 'rejected';
  const standing = offers ? standingOffer(offers) : null;
  const waiting = Boolean(offers?.length) && !standing && !settled;

  if (settled) return null;

  return (
    <View style={{ gap: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: c.line2 }}>
      {error && <Text accessibilityRole="alert" style={[t.bodySm, { color: c.danger }]}>{error}</Text>}

      {/* The exchange, oldest first. People argue about money by remembering
          what was said, so the figures stay rather than being replaced. */}
      {offers?.map((offer) => (
        <Row key={offer.id} gap={8} style={{ alignItems: 'flex-start' }}>
          <Text style={[t.bodySm, { color: offer.mine ? c.txt2 : c.txt, flex: 1 }]}>
            <Text style={{ fontFamily: t.labelSm.fontFamily }}>
              {offer.mine ? 'You' : request.withName.split(' ')[0]}
            </Text>
            {` offered ${formatCents(offer.amountCents)}`}
            {offer.note ? ` — ${offer.note}` : ''}
          </Text>
        </Row>
      ))}

      {waiting && (
        <Text style={[t.caption, { color: c.txt3 }]}>
          Waiting on {request.withName.split(' ')[0]} to accept or counter.
        </Text>
      )}

      {standing && (
        <VoltButton label={`Accept ${formatCents(standing.amountCents)}`} busy={busy} busyLabel="Saving…"
          enabled={!busy}
          onPress={() => void run(async () => {
            await acceptRefund(request.id);
            track('package_cancellation_decided');
          })} />
      )}

      {!waiting && (
        <>
          <Text style={[t.caption, { color: c.txt3 }]}>
            {offers?.length
              ? 'Counter with your own figure, or accept theirs.'
              : takesPayment
                ? "Once you both agree, BOOK’D sends the refund back to the card or Whish account that paid."
                : 'Name the amount that comes back. BOOK’D records what you agree — it does not move the money.'}
          </Text>
          <Row gap={10} style={{ alignItems: 'center' }}>
            <Text style={[t.price, { color: c.accent }]}>$</Text>
            <View style={{ flex: 1 }}>
              <TextInput
                value={amount}
                onChangeText={setAmount}
                placeholder="0"
                placeholderTextColor={c.txt3}
                accessibilityLabel="Amount to give back"
                keyboardType="decimal-pad"
                style={[t.label, { color: c.txt, backgroundColor: c.surface, borderColor: c.line,
                  borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 11, minHeight: 44 }]}
              />
            </View>
            <Button label={offers?.length ? 'Counter' : 'Offer'} icon="send" enabled={!busy}
              accessibilityLabel={offers?.length ? 'Counter with this amount' : 'Offer this amount'}
              onPress={() => {
                const cents = parseMoney(amount);
                if (cents === null) { setError('Enter an amount like 120 or 0.'); return; }
                void run(async () => {
                  await offerRefund(request.id, cents);
                  track('package_refund_offered');
                });
              }} />
          </Row>
        </>
      )}
    </View>
  );
}
