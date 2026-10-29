import { useEffect, useState } from 'react';
import { fetchPaymentConfig, NO_PAYMENTS, PaymentConfig } from '../lib/payments';

// One read per app session. Settings change through the console a few times a
// year; a reload picks the change up.
let pending: Promise<PaymentConfig> | null = null;

export function usePaymentConfig(): PaymentConfig {
  const [config, setConfig] = useState<PaymentConfig>(NO_PAYMENTS);
  useEffect(() => {
    let live = true;
    // A failed read comes back as NO_PAYMENTS: forget it so the next mount asks again.
    pending ??= fetchPaymentConfig().catch(() => NO_PAYMENTS).then((value) => {
      if (value === NO_PAYMENTS) pending = null;
      return value;
    });
    void pending.then((value) => { if (live) setConfig(value); });
    return () => { live = false; };
  }, []);
  return config;
}
