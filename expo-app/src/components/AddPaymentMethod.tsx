import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { addTestCard, addWhish, validWhishNumber } from '../lib/payments';
import { useTheme } from '../theme';
import { Button, Field, Row } from './ui';
import { usePaymentConfig } from './usePaymentConfig';

/** Add a way to pay or be paid. Card numbers are never typed into BOOK'D: in
 *  practice mode there are two preset test cards; live cards will open the
 *  gateway's own form. */
export function AddPaymentMethod({ onAdded }: { onAdded: (id: string) => void }) {
  const { c, t } = useTheme();
  const config = usePaymentConfig();
  const [number, setNumber] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (label: string, action: () => Promise<string>) => {
    setBusy(label); setError(null);
    try { onAdded(await action()); setNumber(''); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not add that method.'); }
    finally { setBusy(null); }
  };

  return (
    <View style={{ gap: 10 }}>
      {config.mode === 'test' ? (
        <Row gap={8} style={{ flexWrap: 'wrap' }}>
          <Button label="Add test Visa (approves)" tone="secondary" busy={busy === 'ok'}
            onPress={() => void run('ok', () => addTestCard('visa_ok'))} />
          <Button label="Add test Visa (declines)" tone="secondary" busy={busy === 'decline'}
            onPress={() => void run('decline', () => addTestCard('visa_decline'))} />
        </Row>
      ) : (
        <Text style={[t.bodySm, { color: c.txt3 }]}>Cards open the payment company's secure form. Coming with live payments.</Text>
      )}
      <Field label="Whish number" value={number} onChange={setNumber} placeholder="+961 71 123 456" keyboardType="phone-pad" />
      <Button label="Add Whish account" tone="primary" busy={busy === 'whish'}
        enabled={validWhishNumber(number)}
        onPress={() => void run('whish', () => addWhish(number))} />
      {error && <Text accessibilityRole="alert" style={[t.bodySm, { color: c.danger }]}>{error}</Text>}
    </View>
  );
}
