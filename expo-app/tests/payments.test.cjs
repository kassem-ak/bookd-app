// Run: node --test tests/payments.test.cjs
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');
const ts = require('typescript');
const { createClient } = require('@supabase/supabase-js');

const ME = '11111111-1111-1111-1111-111111111111';

function harness(responses = {}) {
  const calls = [];
  const supabase = createClient('https://example.invalid', 'test-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      fetch: async (url, init) => {
        const target = new URL(url);
        calls.push({ method: init?.method ?? 'GET', path: target.pathname, query: target.search, body: init?.body ? JSON.parse(init.body) : null });
        const key = Object.keys(responses).find((k) => target.pathname.endsWith(k));
        const { __status = 200, ...rest } = key && !Array.isArray(responses[key]) ? responses[key] : {};
        const payload = key ? (Array.isArray(responses[key]) ? responses[key] : rest) : [];
        return new Response(JSON.stringify(payload), { status: __status, headers: { 'Content-Type': 'application/json' } });
      },
    },
  });
  const dependencies = {
    './supabase': { supabase },
    './session': { ensureAppSession: async () => {}, currentAppUserId: async () => ME },
  };
  const filename = join(__dirname, '../src/lib/payments.ts');
  const code = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  runInNewContext(code, {
    exports,
    require: (id) => { assert.ok(id in dependencies, `Unexpected import: ${id}`); return dependencies[id]; },
    URL, Response, Headers, Promise, Array, Object, JSON, Number, Math, String, Date,
  }, { filename });
  return { module: exports, calls };
}

const ON = { mode: 'test', enabledKinds: ['session', 'court'], feeBps: 300, feeFlatCents: 25, disputeWindowHours: 48 };

test('quote adds the fee to the price, rounded like the server', () => {
  const { module } = harness();
  assert.deepEqual({ ...module.quote(ON, 10000) }, { priceCents: 10000, feeCents: 325, totalCents: 10325 });
  assert.deepEqual({ ...module.quote(ON, 1050) }, { priceCents: 1050, feeCents: 57, totalCents: 1107 }, '31.5 rounds up');
  assert.deepEqual({ ...module.quote(ON, 0) }, { priceCents: 0, feeCents: 0, totalCents: 0 }, 'free is free');
});

test('paymentsOn only for switched-on kinds', () => {
  const { module } = harness();
  assert.equal(module.paymentsOn(ON, 'session'), true);
  assert.equal(module.paymentsOn(ON, 'event'), false);
  assert.equal(module.paymentsOn(module.NO_PAYMENTS, 'session'), false);
});

test('a Whish number must be Lebanese', () => {
  const { module } = harness();
  for (const ok of ['+96171123456', '96171123456', '+961 71 123 456', '+961-3-123456']) assert.equal(module.validWhishNumber(ok), true, ok);
  for (const bad of ['', '71123456', '+33612345678', '+961 71 12', 'abc']) assert.equal(module.validWhishNumber(bad), false, bad);
});

test('earnings split by where the money is', () => {
  const { module } = harness();
  const base = { kind: 'session', subjectId: 's', role: 'payee', feeCents: 0, status: 'held', createdAt: '', expiresAt: '', refundedCents: 0 };
  const summary = module.earningsSummary([
    { ...base, id: 'a', priceCents: 5000, releases: [] },
    { ...base, id: 'b', priceCents: 5000, releases: [{ id: 'r1', amountCents: 5000, commissionCents: 600, releaseAt: '', status: 'waiting' }] },
    { ...base, id: 'c', priceCents: 5000, releases: [{ id: 'r2', amountCents: 5000, commissionCents: 600, releaseAt: '', status: 'released' }] },
    { ...base, id: 'd', priceCents: 5000, releases: [{ id: 'r3', amountCents: 5000, commissionCents: 600, releaseAt: '', status: 'disputed' }] },
    { ...base, id: 'e', priceCents: 4000, refundedCents: 4000, releases: [] },
    { ...base, id: 'f', role: 'payer', priceCents: 9999, releases: [] },
  ]);
  assert.deepEqual({ ...summary }, {
    notYetDoneCents: 5000, inComplaintPeriodCents: 4400, disputedCents: 4400, releasedCents: 4400, commissionCents: 600,
  });
});

test('earnings use what the server says the payee is owed', () => {
  const { module } = harness();
  const base = { kind: 'session', subjectId: 's', role: 'payee', feeCents: 0, status: 'closed', createdAt: '', expiresAt: '', refundedCents: 0 };
  // A platform code paid 1000 of a 5000 list price: the coach is owed 4400 on the list price, not 1000 - 120.
  const summary = module.earningsSummary([
    { ...base, id: 'a', priceCents: 1000, releases: [{ id: 'r1', amountCents: 1000, commissionCents: 600, payeeCents: 4400, releaseAt: '', status: 'released' }] },
    { ...base, id: 'b', priceCents: 5000, releases: [{ id: 'r2', amountCents: 5000, commissionCents: 600, payeeCents: null, releaseAt: '', status: 'released' }] },
  ]);
  assert.equal(summary.releasedCents, 8800);
});

test('payFor sends the checkout action and passes a decline through', async () => {
  const { module, calls } = harness({ '/functions/v1/payments': { ok: false, message: 'The test card was declined. Try another method.' } });
  const result = await module.payFor('p1', 'm1');
  assert.deepEqual({ ...result }, { ok: false, message: 'The test card was declined. Try another method.' });
  assert.deepEqual(calls.at(-1).body, { action: 'checkout', paymentId: 'p1', methodId: 'm1' });
});

test('fetchMyPayments marks my role and totals refunds', async () => {
  const { module } = harness({
    '/rest/v1/payments': [{
      id: 'p1', kind: 'session', subject_id: 'b1', payer_id: ME, payee_id: 'x', price_cents: 5000, fee_cents: 150,
      status: 'held', created_at: '2026-10-10T10:00:00Z', expires_at: '2026-10-10T10:15:00Z',
      payment_releases: [], refunds: [{ amount_cents: 1000 }, { amount_cents: 500 }],
    }],
  });
  const [row] = await module.fetchMyPayments();
  assert.equal(row.role, 'payer');
  assert.equal(row.refundedCents, 1500);
  assert.equal(row.feeCents, 150);
});

test('fetchMyPayments maps the promo discount and code', async () => {
  const { module } = harness({
    '/rest/v1/payments': [{
      id: 'p1', kind: 'session', subject_id: 'b1', payer_id: ME, payee_id: 'x', price_cents: 4000, fee_cents: 145,
      discount_cents: 1000, promo_code: 'SPRING',
      status: 'awaiting_payment', created_at: '2026-10-10T10:00:00Z', expires_at: '2026-10-10T10:15:00Z',
      payment_releases: [], refunds: [],
    }],
  });
  const [row] = await module.fetchMyPayments();
  assert.equal(row.discountCents, 1000);
  assert.equal(row.promoCode, 'SPRING');
});

test('applyPromoCode sends the rpc args and maps the quote row', async () => {
  const { module, calls } = harness({
    '/rest/v1/rpc/apply_promo_code': [{ price_cents: 4000, discount_cents: 1000, fee_cents: 145, total_cents: 4145, promo_kind: 'coach' }],
  });
  const result = await module.applyPromoCode('p1', 'SPRING');
  assert.deepEqual(calls.at(-1).body, { p_payment: 'p1', p_code: 'SPRING' });
  assert.deepEqual({ ...result }, { priceCents: 4000, discountCents: 1000, feeCents: 145, totalCents: 4145, promoKind: 'coach' });
});

const AWAITING = {
  id: 'p1', kind: 'court', subject_id: 'res-1', payer_id: ME, payee_id: 'x', price_cents: 3000, fee_cents: 0,
  status: 'awaiting_payment', created_at: '2026-10-10T10:00:00Z', expires_at: '2026-10-10T10:15:00Z',
  payment_releases: [], refunds: [],
};

test('fetchAwaitingPayment with a subject asks for that subject only', async () => {
  const { module, calls } = harness({ '/rest/v1/payments': [AWAITING] });
  const row = await module.fetchAwaitingPayment('res-1');
  assert.equal(row.subjectId, 'res-1');
  const query = new URLSearchParams(calls.at(-1).query);
  assert.equal(query.get('subject_id'), 'eq.res-1');
  assert.equal(query.get('payer_id'), `eq.${ME}`);
  assert.equal(query.get('status'), 'eq.awaiting_payment');
  assert.equal(query.get('limit'), '1');
});

test('fetchAwaitingPayment without a subject takes the newest open checkout', async () => {
  const { module, calls } = harness({ '/rest/v1/payments': [AWAITING] });
  await module.fetchAwaitingPayment();
  const query = new URLSearchParams(calls.at(-1).query);
  assert.equal(query.has('subject_id'), false);
  assert.equal(query.get('order'), 'created_at.desc');
});

test('fetchAwaitingPayment returns null when nothing is open for the subject', async () => {
  const { module } = harness({ '/rest/v1/payments': [] });
  assert.equal(await module.fetchAwaitingPayment('res-2'), null);
});

test('payFor surfaces the server message from a non-2xx reply', async () => {
  const { module } = harness({ '/functions/v1/payments': { __status: 422, error: 'Pick one of your payment methods.' } });
  await assert.rejects(module.payFor('p1', 'm1'), (e) => e.message === 'Pick one of your payment methods.');
});
