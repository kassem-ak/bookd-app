// Run: node tests/analytics.test.cjs
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');
const ts = require('typescript');

function harness() {
  const filename = join(__dirname, '../src/lib/analytics.ts');
  const code = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const jobs = [];
  const api = {};
  const dependencies = {
    'expo-constants': { __esModule: true, default: { expoConfig: { version: '1.0.0' } } },
    'expo-modules-core': { uuid: { v4: randomUUID } },
  };
  runInNewContext(code, {
    exports: api,
    require: (id) => {
      assert.ok(Object.hasOwn(dependencies, id), `Unexpected dependency: ${id}`);
      return dependencies[id];
    },
    setTimeout: (fn) => { jobs.push(fn); return jobs.length; },
    // No fetch, storage or network globals: the seam cannot depend on them.
  }, { filename });
  return {
    api, jobs,
    async tick() {
      jobs.shift()?.();
      await new Promise(setImmediate);
    },
  };
}

const plain = (value) => JSON.parse(JSON.stringify(value));

test('PII keys, free text disguised as enums, unknown keys and nested data are stripped', async () => {
  const h = harness();
  const props = {
    Email: 'a@example.com', phone_number: '+123456789', displayName: 'Alice',
    message: 'secret', BODY: 'secret', text: 'secret', query: 'secret',
    lat: 33.8938, lng: 35.5018, latitude: 33.8938, longitude: 35.5018,
    address: 'secret', event_title: 'secret', community_name: 'secret', bio: 'secret',
    content: 'secret', recipient: 'secret', token: 'secret', password: 'secret',
    value: 'a@example.com', status: 'Alice', provider: 'a@example.com',
    role: 'coach', mode: 'partners', has_input: true, amount_cents: 12500,
    sessions: 5, package_index: 0, active: false, filter: null, error_code: '23505',
  };
  h.api.track('booking_confirmed', props);
  props.amount_cents = 1; // The queue must own its sanitized copy.
  h.api.track('write_failed', {
    error_code: 'failed for a@example.com', error_type: 'Alice', role: { email: 'secret' },
    sessions: Infinity, package_index: -1, amount_cents: 33.8938,
  });
  const records = [];
  h.api.setSink({ send: async (batch) => records.push(...batch) });
  await h.tick();
  assert.deepEqual(plain(records[0].props), {
    role: 'coach', filter: null, mode: 'partners', has_input: true, active: false,
    package_index: 0, sessions: 5, amount_cents: 12500, error_code: '23505',
  });
  assert.deepEqual(plain(records[1].props), {});
  assert.equal(h.api.analyticsErrorCode({ code: '23505', message: 'secret' }), '23505');
  assert.equal(h.api.analyticsErrorCode({ code: 'P0001' }), 'P0001');
  assert.equal(h.api.analyticsErrorCode({ code: 'PGRST116' }), 'PGRST116');
  assert.equal(h.api.analyticsErrorCode(new Error('secret')), 'UNKNOWN_ERROR');
  assert.equal(h.api.analyticsErrorCode({ code: 'Alice' }), 'UNKNOWN_ERROR');
  assert.doesNotThrow(() => h.api.track('write_failed', {
    get error_code() { throw new Error('bad getter'); },
  }));
});

test('no sink means no work; the 300-record cap drops oldest and attach flushes the retained tail', async () => {
  const h = harness();
  for (let i = 0; i < 317; i++) h.api.track('app_open');
  assert.equal(h.jobs.length, 0);
  const batches = [];
  h.api.setSink({ send: async (batch) => batches.push(batch) });
  assert.equal(batches.length, 0, 'setSink must not call provider code synchronously');
  await h.tick();
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, h.api.ANALYTICS_BUFFER_CAP);
  assert.equal(batches[0][0].sequence, 18);
  assert.equal(batches[0].at(-1).sequence, 317);
  h.api.track('message_sent');
  await h.tick();
  assert.equal(batches[1][0].sequence, 318);
  assert.equal(h.jobs.length, 0);
});

test('throwing and rejecting sinks never throw to callers, retain events, and pause until reattached', async () => {
  for (const asynchronous of [false, true]) {
    const h = harness();
    let calls = 0;
    const fail = () => { calls++; throw new Error('provider failed'); };
    assert.doesNotThrow(() => h.api.setSink({ send: asynchronous ? async () => fail() : fail }));
    assert.doesNotThrow(() => h.api.track('app_open'));
    await h.tick();
    for (let i = 0; i < 400; i++) assert.doesNotThrow(() => h.api.track('message_sent'));
    await h.tick();
    assert.equal(calls, 1);
    assert.equal(h.jobs.length, 0, 'new events must not cause a retry loop');
    const records = [];
    h.api.setSink({ send: async (batch) => records.push(...batch) });
    await h.tick();
    assert.equal(records.length, 300);
    assert.equal(records[0].sequence, 102);
    assert.equal(records.at(-1).sequence, 401);
  }
});

test('records snapshot identity without relabeling anonymous history; sign-out clears identity', async () => {
  const h = harness();
  const id = randomUUID();
  h.api.track('app_open');
  h.api.identify(id);
  h.api.track('profile_opened');
  h.api.identify(null);
  h.api.track('guest_entered');
  h.api.identify('a@example.com');
  h.api.track('app_open');
  const records = [];
  h.api.setSink({ send: async (batch) => records.push(...batch) });
  await h.tick();
  assert.deepEqual(records.map((r) => r.userId), [null, id, null, null]);
  assert.match(records[0].sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.notEqual(records[0].sessionId, id);
  assert.equal(new Set(records.map((r) => r.sessionId)).size, 1);
  for (const record of records) {
    assert.equal(new Date(record.timestamp).toISOString(), record.timestamp);
    assert.equal(record.appVersion, '1.0.0');
    assert.ok(Object.isFrozen(record));
    assert.ok(Object.isFrozen(record.props));
  }
});

test('one in-flight batch stays bounded and ordered while new records overflow the queue', async () => {
  const h = harness();
  let release;
  const batches = [];
  h.api.track('app_open');
  h.api.setSink({ send: (batch) => {
    batches.push(batch);
    return new Promise((resolve) => { release = resolve; });
  } });
  await h.tick();
  for (let i = 0; i < 400; i++) h.api.track('message_sent');
  assert.equal(h.jobs.length, 0);
  assert.equal(batches.length, 1);
  release();
  await h.tick();
  await h.tick();
  assert.equal(batches.length, 2);
  assert.equal(batches[1].length, 300);
  assert.equal(batches[1][0].sequence, 102);
  release();
  await h.tick();
});

test('detach stops future sends, replacement flushes records after an old sink rejects', async () => {
  const h = harness();
  let reject;
  h.api.setSink({ send: () => new Promise((_, fail) => { reject = fail; }) });
  h.api.track('app_open');
  await h.tick();
  h.api.setSink(null);
  h.api.track('guest_entered');
  const records = [];
  h.api.setSink({ send: async (batch) => records.push(...batch) });
  reject(new Error('old provider'));
  await h.tick();
  await h.tick();
  assert.deepEqual(records.map((r) => r.sequence), [1, 2]);
  h.api.setSink(null);
  h.api.track('message_sent');
  await h.tick();
  assert.equal(records.length, 2);
  assert.equal(h.jobs.length, 0);
});

test('an ad id goes through only as a uuid, with its placement', async () => {
  const h = harness();
  const id = randomUUID();
  h.api.track('ad_viewed', { ad_id: id, placement: 'discover' });
  h.api.track('ad_opened', { ad_id: 'a@example.com', placement: 'somewhere' });
  const records = [];
  h.api.setSink({ send: async (batch) => records.push(...batch) });
  await h.tick();
  assert.deepEqual(plain(records[0].props), { placement: 'discover', ad_id: id });
  assert.deepEqual(plain(records[1].props), {});
});
