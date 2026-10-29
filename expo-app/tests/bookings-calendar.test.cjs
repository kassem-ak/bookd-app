// Run: node tests/bookings-calendar.test.cjs
// Two tables in one list, and a month grid drawn by hand. What can go wrong:
// a partner session landing in the wrong list or the wrong colour, a partner
// read failing and taking the coach bookings with it, and — the classic — a
// 9pm session showing up on the wrong day because a UTC conversion moved it.
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');
const ts = require('typescript');
const { createClient } = require('@supabase/supabase-js');

const ME = '00000000-0000-4000-8000-0000000000aa';
const HOUR = 3600 * 1000;

function load(file, dependencies, extraGlobals = {}) {
  const filename = join(__dirname, `../src/${file}`);
  const code = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
  }).outputText;
  const exports = {};
  runInNewContext(code, {
    exports,
    require: (id) => {
      assert.ok(id in dependencies, `Unexpected import: ${id}`);
      return dependencies[id];
    },
    URL, Response, Headers, Promise, Array, Object, JSON, Number, Math, String, Date, Map, Set, isNaN,
    ...extraGlobals,
  }, { filename });
  return exports;
}

function bookingsLib({ rows = [], partners = [], partnersThrow = false } = {}) {
  const supabase = createClient('https://example.invalid', 'test-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (url) => {
      const target = new URL(url);
      const payload = target.pathname.endsWith('/bookings') ? rows : [];
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } },
  });
  return load('lib/bookings.ts', {
    './supabase': { supabase },
    // Screening is fire-and-forget and deliberately swallows everything, so
    // nothing under test depends on it.
    './gwin': { screenQuietly: () => {} },
    './schema': { fulfilmentSchemaReady: () => true, markFulfilmentSchemaMissing: () => {} },
    './session': { ensureAppSession: async () => ME, currentAppUserId: async () => ME },
    './partners': {
      PartnerSession: {},
      fetchPartnerSessions: async () => {
        if (partnersThrow) throw new Error('partner read failed');
        return partners;
      },
      decidePartnerSession: async () => {},
    },
  });
}

const soon = (hours) => new Date(Date.now() + hours * HOUR).toISOString();

const coachRow = (id, at, status = 'confirmed') => ({
  id, coach_id: 'coach-1', scheduled_for: at, slot_label: '6:30 PM',
  status, total_cents: 4500, coach: { name: 'Dana Coach' },
});

const partnerRow = (id, at, status = 'accepted', mine = true) => ({
  id, scheduledFor: at, slotLabel: '7:00 PM', note: null, status,
  withId: 'peer-1', withName: 'Sam Peer', withAvatarUrl: null, mine,
});

// ---- the merge -------------------------------------------------------------

test('a partner session appears in the same list as a coach booking', async () => {
  const lib = bookingsLib({
    rows: [coachRow('b1', soon(48))],
    partners: [partnerRow('p1', soon(24))],
  });
  const mine = await lib.fetchMyBookings();
  assert.equal(mine.upcoming.length, 2);
  // Sorted across both sources: the next session first, whichever table it is
  // in. One ORDER BY cannot do that.
  // Joined rather than deepEqual: the array was built inside the vm realm, so a
  // structural compare fails on prototype identity alone.
  assert.equal(mine.upcoming.map((b) => b.id).join(','), 'p1,b1');
  assert.equal(mine.upcoming.map((b) => b.kind).join(','), 'partner,coach');
});

test('a partner session is free, not zero-priced', async () => {
  const lib = bookingsLib({ partners: [partnerRow('p1', soon(24))] });
  const [session] = (await lib.fetchMyBookings()).upcoming;
  assert.equal(session.totalCents, 0);
  assert.equal(session.kind, 'partner');
  assert.equal(session.withName, 'Sam Peer');
});

test('partner statuses map onto booking statuses without widening the enum', async () => {
  const cases = [
    ['proposed', 'pending'],
    ['accepted', 'confirmed'],
    // "They said no" and "someone called it off" both mean it is not happening.
    ['declined', 'cancelled'],
    ['cancelled', 'cancelled'],
  ];
  for (const [given, expected] of cases) {
    const lib = bookingsLib({ partners: [partnerRow('p1', soon(24), given)] });
    const mine = await lib.fetchMyBookings();
    const all = [...mine.upcoming, ...mine.past];
    assert.equal(all[0].status, expected, `${given} should display as ${expected}`);
  }
});

test('a declined or cancelled partner session is past, not upcoming', async () => {
  const lib = bookingsLib({ partners: [partnerRow('p1', soon(24), 'declined')] });
  const mine = await lib.fetchMyBookings();
  assert.equal(mine.upcoming.length, 0);
  assert.equal(mine.past.length, 1);
});

test('an invitation waiting on me is flagged; one I sent is not', async () => {
  const waiting = bookingsLib({ partners: [partnerRow('p1', soon(24), 'proposed', false)] });
  assert.equal((await waiting.fetchMyBookings()).upcoming[0].needsAnswer, true);

  const mine = bookingsLib({ partners: [partnerRow('p1', soon(24), 'proposed', true)] });
  assert.equal((await mine.fetchMyBookings()).upcoming[0].needsAnswer, false);
});

test('a failed partner read does not take the coach bookings down with it', async () => {
  const lib = bookingsLib({ rows: [coachRow('b1', soon(48))], partnersThrow: true });
  const mine = await lib.fetchMyBookings();
  // Half a list beats an error screen: they are independent reads.
  assert.equal(mine.upcoming.length, 1);
  assert.equal(mine.upcoming[0].kind, 'coach');
});

test('past is most-recent-first while upcoming is soonest-first', async () => {
  const lib = bookingsLib({
    rows: [coachRow('old', soon(-200), 'completed'), coachRow('recent', soon(-2), 'completed')],
    partners: [partnerRow('p-soon', soon(3)), partnerRow('p-later', soon(300))],
  });
  const mine = await lib.fetchMyBookings();
  assert.equal(mine.upcoming.map((b) => b.id).join(','), 'p-soon,p-later');
  assert.equal(mine.past.map((b) => b.id).join(','), 'recent,old');
});

// ---- the month grid --------------------------------------------------------

function calendarHelpers() {
  // The overlay is a .tsx full of React Native imports; only its exported pure
  // helpers are under test, so everything else is stubbed away.
  const noop = new Proxy({}, { get: () => () => null });
  // The real grid maths: it moved to lib/calendarGrid so the date picker could
  // share it, and stubbing it would test the stub rather than the calendar.
  const grid = load('lib/calendarGrid.ts', {});
  return load('overlays/BookingsOverlay.tsx', {
    '../lib/calendarGrid': grid,
    react: { default: noop, useCallback: () => {}, useEffect: () => {}, useMemo: () => {}, useState: () => [] },
    'react-native': noop,
    '../components/Overlay': noop,
    '../components/ui': noop,
    '../lib/analytics': { analyticsErrorCode: () => '', track: () => {} },
    '../lib/bookings': {
      bookingStatusLabel: () => '', canCancel: () => false, cancelSession: async () => {},
      acceptSession: async () => {}, fetchMyBookings: async () => ({ upcoming: [], past: [] }),
      fetchMyPackageBalances: async () => [], formatCents: () => '', formatExpiry: () => null,
      formatSessionWhen: () => '',
    },
    '../lib/packages': {
      fetchMyPackages: async () => [], progressSummary: () => '',
      fetchCancellations: async () => [], requestCancellation: async () => {},
      withdrawCancellation: async () => {}, suggestedRefundCents: () => 0,
    },
    '../components/RefundNegotiation': noop,
    '../components/usePaymentConfig': { usePaymentConfig: () => ({}) },
    '../lib/payments': { paymentsOn: () => false },
    '../state/models': { initials: () => '' },
    '../state/store': { useStore: () => ({}) },
    '../theme': { alpha: () => '', useTheme: () => ({ c: {}, t: {} }) },
  });
}

test('a session is bucketed by its LOCAL day, not a UTC one', () => {
  const { dayKey } = calendarHelpers();
  // 9pm local. toISOString() would roll this into tomorrow anywhere east of
  // UTC, which is the off-by-one a calendar must never have.
  const late = new Date(2026, 8, 19, 21, 30, 0);
  assert.equal(dayKey(late), '2026-09-19');
  // And the other edge: half past midnight is still its own day.
  assert.equal(dayKey(new Date(2026, 8, 20, 0, 30, 0)), '2026-09-20');
});

test('an unparseable date is bucketed nowhere rather than into today', () => {
  const { dayKey, byDay } = calendarHelpers();
  assert.equal(dayKey('not a date'), '');
  const days = byDay([{ id: 'x', scheduledFor: 'not a date', kind: 'coach' }]);
  assert.equal(days.size, 0);
});

test('sessions group by day, several to a day', () => {
  const { byDay } = calendarHelpers();
  const days = byDay([
    { id: 'a', scheduledFor: new Date(2026, 8, 19, 10, 0).toISOString(), kind: 'coach' },
    { id: 'b', scheduledFor: new Date(2026, 8, 19, 18, 0).toISOString(), kind: 'partner' },
    { id: 'c', scheduledFor: new Date(2026, 8, 21, 9, 0).toISOString(), kind: 'coach' },
  ]);
  assert.equal(days.get('2026-09-19').length, 2);
  assert.equal(days.get('2026-09-21').length, 1);
  assert.equal(days.get('2026-09-20'), undefined);
});

test('the grid pads so the 1st lands on its own weekday', () => {
  const { monthCells } = calendarHelpers();
  // Monday-first, matching coach_availability.weekday and the app's week.
  // September 2026 starts on a Tuesday, so one blank, and has 30 days.
  const sept = monthCells(2026, 8);
  assert.equal(sept.length, 1 + 30);
  assert.equal(JSON.stringify(sept.slice(0, 2)), '[null,1]');
  assert.equal(sept[sept.length - 1], 30);
});

test('February knows about leap years', () => {
  const { monthCells } = calendarHelpers();
  const leap = monthCells(2028, 1).filter((cell) => cell !== null);
  const common = monthCells(2026, 1).filter((cell) => cell !== null);
  assert.equal(leap.length, 29);
  assert.equal(common.length, 28);
});

test('a month starting on Monday needs no padding at all', () => {
  const { monthCells } = calendarHelpers();
  // 1 June 2026 is a Monday.
  const june = monthCells(2026, 5);
  assert.equal(june[0], 1);
  assert.equal(june.length, 30);
});

test('a month starting on Sunday is padded by a full week, not none', () => {
  const { monthCells } = calendarHelpers();
  // 1 November 2026 is a Sunday -- the last column in a Monday-first week, and
  // the case a Sunday-first grid gets exactly backwards.
  const nov = monthCells(2026, 10);
  assert.equal(nov.slice(0, 6).filter((cell) => cell === null).length, 6);
  assert.equal(nov[6], 1);
  assert.equal(nov.length, 6 + 30);
});
