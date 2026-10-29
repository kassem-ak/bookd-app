import { supabase } from './supabase';
import { currentAppUserId, ensureAppSession } from './session';

// Paying inside BOOK'D. The server decides everything that matters -- price,
// fee, rate, who is paid -- and this file only reads it back and asks the
// payments edge function to charge. quote() mirrors the server's fee formula
// so a total can be shown before the payment row exists.

export type PaymentKind = 'session' | 'package' | 'court' | 'tournament' | 'event';

export type PaymentConfig = {
  mode: 'test' | 'live';
  enabledKinds: PaymentKind[];
  feeBps: number;
  feeFlatCents: number;
  disputeWindowHours: number;
};

export const NO_PAYMENTS: PaymentConfig = { mode: 'test', enabledKinds: [], feeBps: 0, feeFlatCents: 0, disputeWindowHours: 48 };

export function paymentsOn(config: PaymentConfig, kind: PaymentKind) {
  return config.enabledKinds.includes(kind);
}

/** Same formula as private.open_payment: round(price × bps / 10000) + flat. */
export function quote(config: PaymentConfig, priceCents: number) {
  const feeCents = priceCents > 0 ? Math.round((priceCents * config.feeBps) / 10000) + config.feeFlatCents : 0;
  return { priceCents, feeCents, totalCents: priceCents + feeCents };
}

export function validWhishNumber(input: string) {
  return /^\+?961\d{7,8}$/.test(input.replace(/[\s-]/g, ''));
}

export type PaymentMethod = {
  id: string; kind: 'card' | 'whish'; display: string;
  canPay: boolean; canReceive: boolean; defaultPay: boolean; defaultReceive: boolean;
};

export type Release = {
  id: string; amountCents: number; commissionCents: number; releaseAt: string;
  status: 'waiting' | 'disputed' | 'released' | 'refunded';
  /** What the payee is owed, set by the server when the release is priced (null before). */
  payeeCents: number | null;
};

export type MyPayment = {
  id: string; kind: PaymentKind; subjectId: string; role: 'payer' | 'payee';
  priceCents: number; feeCents: number; discountCents: number; promoCode: string | null;
  status: string; createdAt: string; expiresAt: string;
  releases: Release[]; refundedCents: number;
};

export type Payout = {
  id: string; amountCents: number;
  status: 'waiting_method' | 'queued' | 'sending' | 'sent' | 'failed'; createdAt: string;
};

export type Earnings = {
  notYetDoneCents: number; inComplaintPeriodCents: number; disputedCents: number;
  releasedCents: number; commissionCents: number;
};

/** Where a payee's money is. Amounts after commission, except notYetDone,
 *  which is the price still held for services not yet done. */
export function earningsSummary(payments: MyPayment[]): Earnings {
  const out: Earnings = { notYetDoneCents: 0, inComplaintPeriodCents: 0, disputedCents: 0, releasedCents: 0, commissionCents: 0 };
  for (const p of payments) {
    if (p.role !== 'payee' || p.status === 'awaiting_payment' || p.status === 'charging') continue;
    let allocated = p.refundedCents;
    for (const r of p.releases) {
      if (r.status === 'refunded') continue;
      allocated += r.amountCents;
      const share = r.payeeCents ?? r.amountCents - r.commissionCents;
      if (r.status === 'waiting') out.inComplaintPeriodCents += share;
      else if (r.status === 'disputed') out.disputedCents += share;
      else if (r.status === 'released') { out.releasedCents += share; out.commissionCents += r.commissionCents; }
    }
    if (p.status === 'held') out.notYetDoneCents += Math.max(0, p.priceCents - allocated);
  }
  return out;
}

async function callPayments<T>(body: Record<string, unknown>): Promise<T> {
  await ensureAppSession();
  const { data, error } = await supabase.functions.invoke('payments', { method: 'POST', body });
  if (error) {
    // supabase-js hides the server's message behind a generic non-2xx error; dig it out of the response body.
    let message: unknown;
    try { message = (await (error as { context?: Response }).context?.json())?.error; } catch { /* no readable body */ }
    throw typeof message === 'string' ? new Error(message) : error;
  }
  if (data && typeof data === 'object' && 'error' in data) throw new Error(String((data as { error: unknown }).error));
  return data as T;
}

export async function fetchPaymentConfig(): Promise<PaymentConfig> {
  const { data, error } = await supabase
    .from('payment_settings')
    .select('mode, enabled_kinds, fee_bps, fee_flat_cents, dispute_window_hours')
    .maybeSingle();
  // No table yet, or unreadable: behave as if payments are off.
  if (error || !data) return NO_PAYMENTS;
  return {
    mode: data.mode === 'live' ? 'live' : 'test',
    enabledKinds: (data.enabled_kinds ?? []) as PaymentKind[],
    feeBps: data.fee_bps ?? 0,
    feeFlatCents: data.fee_flat_cents ?? 0,
    disputeWindowHours: data.dispute_window_hours ?? 48,
  };
}

export async function listPaymentMethods(): Promise<PaymentMethod[]> {
  await ensureAppSession();
  const { data, error } = await supabase
    .from('payment_methods')
    .select('id, kind, display, can_pay, can_receive, default_pay, default_receive')
    .order('created_at');
  if (error) throw error;
  return (data ?? []).map((m) => ({
    id: m.id, kind: m.kind, display: m.display, canPay: m.can_pay, canReceive: m.can_receive,
    defaultPay: m.default_pay, defaultReceive: m.default_receive,
  }));
}

export async function addTestCard(card: 'visa_ok' | 'visa_decline') {
  return (await callPayments<{ id: string }>({ action: 'add-method', kind: 'card', testCard: card })).id;
}

export async function addWhish(number: string) {
  return (await callPayments<{ id: string }>({ action: 'add-method', kind: 'whish', number })).id;
}

export async function removePaymentMethod(id: string) {
  await ensureAppSession();
  const { error } = await supabase.rpc('remove_payment_method', { p_id: id });
  if (error) throw error;
}

export async function setDefaultPaymentMethod(id: string, purpose: 'pay' | 'receive') {
  await ensureAppSession();
  const { error } = await supabase.rpc('set_default_payment_method', { p_id: id, p_purpose: purpose });
  if (error) throw error;
}

const PAYMENT_COLUMNS =
  'id, kind, subject_id, payer_id, payee_id, price_cents, fee_cents, discount_cents, promo_code, status, created_at, expires_at, '
  + 'payment_releases(id, amount_cents, commission_cents, payee_cents, release_at, status), refunds(amount_cents)';

type PaymentRow = {
  id: string; kind: PaymentKind; subject_id: string; payer_id: string; payee_id: string;
  price_cents: number; fee_cents: number; discount_cents: number | null; promo_code: string | null;
  status: string; created_at: string; expires_at: string;
  payment_releases: {
    id: string; amount_cents: number; commission_cents: number; payee_cents: number | null;
    release_at: string; status: Release['status'];
  }[] | null;
  refunds: { amount_cents: number }[] | null;
};

function toPayment(row: PaymentRow, me: string | null): MyPayment {
  return {
    id: row.id, kind: row.kind, subjectId: row.subject_id,
    role: row.payer_id === me ? 'payer' : 'payee',
    priceCents: row.price_cents, feeCents: row.fee_cents,
    discountCents: row.discount_cents ?? 0, promoCode: row.promo_code ?? null,
    status: row.status, createdAt: row.created_at, expiresAt: row.expires_at,
    releases: (row.payment_releases ?? []).map((r) => ({
      id: r.id, amountCents: r.amount_cents, commissionCents: r.commission_cents, releaseAt: r.release_at, status: r.status,
      payeeCents: r.payee_cents ?? null,
    })),
    refundedCents: (row.refunds ?? []).reduce((sum, r) => sum + r.amount_cents, 0),
  };
}

export async function fetchMyPayments(): Promise<MyPayment[]> {
  await ensureAppSession();
  const me = await currentAppUserId();
  const { data, error } = await supabase.from('payments').select(PAYMENT_COLUMNS)
    .order('created_at', { ascending: false }).limit(500);
  if (error) throw error;
  return ((data ?? []) as unknown as PaymentRow[]).map((row) => toPayment(row, me));
}

/** The checkout the member just started: the unpaid payment for that booking,
 *  reservation or event when its id is known, else their newest unpaid one. */
export async function fetchAwaitingPayment(subjectId?: string): Promise<MyPayment | null> {
  await ensureAppSession();
  const me = await currentAppUserId();
  if (!me) return null;
  let query = supabase.from('payments').select(PAYMENT_COLUMNS)
    .eq('payer_id', me).eq('status', 'awaiting_payment');
  if (subjectId) query = query.eq('subject_id', subjectId);
  const { data, error } = await query.order('created_at', { ascending: false }).limit(1);
  if (error) throw error;
  const row = (data ?? [])[0] as unknown as PaymentRow | undefined;
  return row ? toPayment(row, me) : null;
}

export async function fetchMyPayouts(): Promise<Payout[]> {
  await ensureAppSession();
  const { data, error } = await supabase.from('payee_payouts')
    .select('id, amount_cents, status, created_at').order('created_at', { ascending: false }).limit(100);
  if (error) throw error;
  return (data ?? []).map((p) => ({ id: p.id, amountCents: p.amount_cents, status: p.status, createdAt: p.created_at }));
}

export async function payFor(paymentId: string, methodId: string) {
  return callPayments<{ ok: true } | { ok: false; message: string }>({ action: 'checkout', paymentId, methodId });
}

export type Quote = {
  priceCents: number; discountCents: number; feeCents: number; totalCents: number;
  promoKind: 'coach' | 'platform' | null;
};

type QuoteRow = {
  price_cents: number; discount_cents: number; fee_cents: number; total_cents: number;
  promo_kind: Quote['promoKind'];
};

/** Put a promo code on an unpaid payment; the server re-prices and returns the new quote. */
export async function applyPromoCode(paymentId: string, code: string): Promise<Quote> {
  await ensureAppSession();
  const { data, error } = await supabase.rpc('apply_promo_code', { p_payment: paymentId, p_code: code });
  if (error) throw error;
  const row = (data as QuoteRow[] | null)?.[0];
  if (!row) throw new Error('That code could not be applied.');
  return {
    priceCents: row.price_cents, discountCents: row.discount_cents, feeCents: row.fee_cents,
    totalCents: row.total_cents, promoKind: row.promo_kind ?? null,
  };
}

export async function removePromoCode(paymentId: string) {
  await ensureAppSession();
  const { error } = await supabase.rpc('remove_promo_code', { p_payment: paymentId });
  if (error) throw error;
}

export async function raiseDispute(releaseId: string, reason: string) {
  await ensureAppSession();
  const { error } = await supabase.rpc('raise_dispute', { p_release: releaseId, p_reason: reason });
  if (error) throw error;
}
