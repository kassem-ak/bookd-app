import React, { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { OverlayHeader, OverlayScaffold } from '../components/Overlay';
import { PracticeBanner } from '../components/PracticeBanner';
import { Button, Card, ErrorNote, Row, SectionHeading } from '../components/ui';
import { formatCents } from '../lib/bookings';
import { Earnings, earningsSummary, fetchMyPayments, fetchMyPayouts, listPaymentMethods, Payout } from '../lib/payments';
import { useStore } from '../state/store';
import { useTheme } from '../theme';

const PAYOUT_LABEL: Record<Payout['status'], string> = {
  waiting_method: 'Waiting for your Whish account',
  queued: 'Sending', sending: 'Sending', sent: 'Sent', failed: 'Failed — BOOK\'D will retry',
};

export function EarningsOverlay() {
  const { c, t } = useTheme();
  const s = useStore();
  const [summary, setSummary] = useState<Earnings | null>(null);
  const [payouts, setPayouts] = useState<Payout[]>([]);
  const [canReceive, setCanReceive] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [payments, outs, methods] = await Promise.all([fetchMyPayments(), fetchMyPayouts(), listPaymentMethods()]);
      setSummary(earningsSummary(payments));
      setPayouts(outs);
      setCanReceive(methods.some((m) => m.defaultReceive));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your earnings.');
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const line = (label: string, cents: number, note: string) => (
    <Row style={{ justifyContent: 'space-between', paddingVertical: 8 }}>
      <View style={{ flex: 1 }}>
        <Text style={[t.body, { color: c.txt }]}>{label}</Text>
        <Text style={[t.caption, { color: c.txt3 }]}>{note}</Text>
      </View>
      <Text style={[t.bodyLg, { color: c.txt }]}>{formatCents(cents)}</Text>
    </Row>
  );

  return (
    <OverlayScaffold header={<OverlayHeader title="Earnings" onBack={s.closeOverlay} />}>
      <View style={{ padding: 16, gap: 16 }}>
        <PracticeBanner />
        {error && <ErrorNote message={error} onRetry={() => void load()} retryLabel="Load earnings again" />}
        {!canReceive && (
          <Card style={{ padding: 14, gap: 10 }}>
            <Text style={[t.body, { color: c.txt }]}>Add a Whish account so BOOK'D can send you what you earn.</Text>
            <Button label="Add Whish account" tone="primary" onPress={() => s.set('overlay', 'paymentMethods')} />
          </Card>
        )}
        {summary && (
          <Card style={{ padding: 14 }}>
            {line('Not yet done', summary.notYetDoneCents, 'Paid by members for sessions still to come')}
            {line('In complaint period', summary.inComplaintPeriodCents, 'Done; released to you after the complaint period')}
            {line('Under review', summary.disputedCents, 'A member reported a problem; an admin decides')}
            {line('Released to you', summary.releasedCents, `After BOOK'D's ${formatCents(summary.commissionCents)} commission`)}
          </Card>
        )}
        <SectionHeading>Payouts</SectionHeading>
        {payouts.length === 0 && <Text style={[t.body, { color: c.txt3 }]}>No payouts yet.</Text>}
        {payouts.map((p) => (
          <Row key={p.id} style={{ justifyContent: 'space-between' }}>
            <Text style={[t.body, { color: c.txt2 }]}>{new Date(p.createdAt).toLocaleDateString()} · {PAYOUT_LABEL[p.status]}</Text>
            <Text style={[t.body, { color: c.txt }]}>{formatCents(p.amountCents)}</Text>
          </Row>
        ))}
      </View>
    </OverlayScaffold>
  );
}
