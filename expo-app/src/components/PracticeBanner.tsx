import React from 'react';
import { Text, View } from 'react-native';
import { useTheme } from '../theme';
import { usePaymentConfig } from './usePaymentConfig';

/** Shown wherever money appears while the gateway is the Test one. */
export function PracticeBanner() {
  const { c, t } = useTheme();
  const config = usePaymentConfig();
  if (config.mode !== 'test' || config.enabledKinds.length === 0) return null;
  return (
    <View accessibilityRole="alert" style={{ backgroundColor: c.amberText, borderRadius: 10, paddingVertical: 8, paddingHorizontal: 12, marginBottom: 12 }}>
      <Text style={[t.bodySm, { color: c.ink, fontWeight: '700' }]}>Practice mode — no real money</Text>
    </View>
  );
}
