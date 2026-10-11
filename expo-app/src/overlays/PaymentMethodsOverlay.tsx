import React, { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { AddPaymentMethod } from '../components/AddPaymentMethod';
import { OverlayHeader, OverlayScaffold } from '../components/Overlay';
import { PracticeBanner } from '../components/PracticeBanner';
import { Button, Card, Chip, ErrorNote, Row, SectionHeading } from '../components/ui';
import { listPaymentMethods, PaymentMethod, removePaymentMethod, setDefaultPaymentMethod } from '../lib/payments';
import { useStore } from '../state/store';
import { useTheme } from '../theme';

export function PaymentMethodsOverlay() {
  const { c, t } = useTheme();
  const s = useStore();
  const [methods, setMethods] = useState<PaymentMethod[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try { setMethods(await listPaymentMethods()); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not load your payment methods.'); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const act = async (action: () => Promise<void>) => {
    try { await action(); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'That did not work.'); }
  };

  return (
    <OverlayScaffold header={<OverlayHeader title="Payment methods" onBack={s.closeOverlay} />}>
      <View style={{ padding: 16, gap: 16 }}>
        <PracticeBanner />
        {error && <ErrorNote message={error} onRetry={() => void load()} retryLabel="Load payment methods again" />}
        <SectionHeading>Saved</SectionHeading>
        {methods?.length === 0 && <Text style={[t.body, { color: c.txt3 }]}>Nothing saved yet.</Text>}
        {methods?.map((m) => (
          <Card key={m.id} style={{ padding: 14, gap: 10 }}>
            <Text style={[t.bodyLg, { color: c.txt }]}>{m.display}</Text>
            <Row gap={8} style={{ flexWrap: 'wrap' }}>
              {m.canPay && <Chip label={m.defaultPay ? 'Pays by default' : 'Pay with this'} active={m.defaultPay}
                onPress={() => void act(() => setDefaultPaymentMethod(m.id, 'pay'))} />}
              {m.canReceive && <Chip label={m.defaultReceive ? 'Receives payouts' : 'Receive payouts here'} active={m.defaultReceive}
                onPress={() => void act(() => setDefaultPaymentMethod(m.id, 'receive'))} />}
            </Row>
            <Button label="Remove" tone="secondary" onPress={() => void act(() => removePaymentMethod(m.id))}
              accessibilityLabel={`Remove ${m.display}`} />
          </Card>
        ))}
        <SectionHeading>Add</SectionHeading>
        <Text style={[t.bodySm, { color: c.txt3 }]}>To receive money from bookings, add a Whish account.</Text>
        <AddPaymentMethod onAdded={() => void load()} />
      </View>
    </OverlayScaffold>
  );
}
