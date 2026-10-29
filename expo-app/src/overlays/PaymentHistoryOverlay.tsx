import React, { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { CheckoutPanel } from '../components/CheckoutPanel';
import { OverlayHeader, OverlayScaffold } from '../components/Overlay';
import { PracticeBanner } from '../components/PracticeBanner';
import { Button, Card, ErrorNote, Field, Row } from '../components/ui';
import { formatCents } from '../lib/bookings';
import { fetchMyPayments, MyPayment, raiseDispute, Release } from '../lib/payments';
import { useStore } from '../state/store';
import { useTheme } from '../theme';

const KIND_LABEL: Record<MyPayment['kind'], string> = {
  session: 'Coach session', package: 'Session pack', court: 'Court', tournament: 'Tournament entry', event: 'Event',
};
const STATUS_LABEL: Record<string, string> = {
  awaiting_payment: 'Waiting for payment', charging: 'Paying…', held: 'Paid · held until done',
  closed: 'Settled', failed: 'Payment failed', expired: 'Checkout expired', cancelled: 'Cancelled',
};

function openComplaint(r: Release) {
  return r.status === 'waiting' && Date.parse(r.releaseAt) > Date.now();
}

export function PaymentHistoryOverlay() {
  const { c, t } = useTheme();
  const s = useStore();
  const [rows, setRows] = useState<MyPayment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reporting, setReporting] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try { setRows((await fetchMyPayments()).filter((p) => p.role === 'payer')); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not load your payments.'); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const report = async (releaseId: string) => {
    setBusy(true); setError(null);
    try { await raiseDispute(releaseId, reason); setReporting(null); setReason(''); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not send that.'); }
    finally { setBusy(false); }
  };

  // Mine to pay: a payee also sees the checkouts others have open with them.
  const awaiting = rows?.find((p) => p.status === 'awaiting_payment' && p.role === 'payer');

  return (
    <OverlayScaffold header={<OverlayHeader title="Payments" onBack={s.closeOverlay} />}>
      <View style={{ padding: 16, gap: 14 }}>
        <PracticeBanner />
        {error && <ErrorNote message={error} onRetry={() => void load()} retryLabel="Load payments again" />}
        {awaiting && (
          <Card style={{ padding: 14, gap: 8 }}>
            <Text style={[t.bodyLg, { color: c.txt }]}>Finish paying · {KIND_LABEL[awaiting.kind]}</Text>
            <CheckoutPanel subjectId={awaiting.subjectId} onPaid={() => void load()} onNone={() => void load()} />
          </Card>
        )}
        {rows?.length === 0 && <Text style={[t.body, { color: c.txt3 }]}>No payments yet.</Text>}
        {rows?.filter((p) => p !== awaiting).map((p) => (
          <Card key={p.id} style={{ padding: 14, gap: 6 }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={[t.bodyLg, { color: c.txt }]}>{KIND_LABEL[p.kind]}</Text>
              <Text style={[t.bodyLg, { color: c.txt }]}>{formatCents(p.priceCents + p.feeCents)}</Text>
            </Row>
            <Text style={[t.caption, { color: c.txt3 }]}>
              {new Date(p.createdAt).toLocaleString()} · {STATUS_LABEL[p.status] ?? p.status}
            </Text>
            <Text style={[t.caption, { color: c.txt3 }]}>
              Price {formatCents(p.priceCents)} + fee {formatCents(p.feeCents)}
              {p.refundedCents > 0 ? ` · ${formatCents(p.refundedCents)} refunded` : ''}
            </Text>
            {p.discountCents > 0 && (
              <Text style={[t.caption, { color: c.txt3 }]}>
                {`Code ${p.promoCode}: −${formatCents(p.discountCents)}`}
              </Text>
            )}
            {p.releases.filter(openComplaint).map((r) => (
              reporting === r.id ? (
                <View key={r.id} style={{ gap: 8 }}>
                  <Field label="What went wrong?" value={reason} onChange={setReason} placeholder="The coach did not show up" />
                  <Row gap={8}>
                    <Button label="Send to BOOK'D" tone="primary" busy={busy} enabled={reason.trim().length >= 5}
                      onPress={() => void report(r.id)} />
                    <Button label="Cancel" tone="secondary" onPress={() => setReporting(null)} />
                  </Row>
                </View>
              ) : (
                <Button key={r.id} label="Report a problem" tone="secondary" onPress={() => setReporting(r.id)}
                  accessibilityLabel={`Report a problem with this ${KIND_LABEL[p.kind].toLowerCase()}, before ${new Date(r.releaseAt).toLocaleString()}`} />
              )
            ))}
            {p.releases.some((r) => r.status === 'disputed') && (
              <Text style={[t.bodySm, { color: c.amberText }]}>You reported a problem. An admin will decide and the money stays held until then.</Text>
            )}
          </Card>
        ))}
      </View>
    </OverlayScaffold>
  );
}
