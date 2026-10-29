// Run: node --test tests/ads.test.cjs
// Sponsored cards on Discover: what a row from `ads` is allowed to become.
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');
const ts = require('typescript');

function transpile(file) {
  return ts.transpileModule(readFileSync(join(__dirname, '../src/lib', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

function load({ rows = [], error = null } = {}) {
  const calls = [];
  const socialLinks = {};
  runInNewContext(transpile('socialLinks.ts'), {
    exports: socialLinks,
    require: (id) => {
      if (id === './schema') return { markSocialLinksSchemaMissing() {}, socialLinksSchemaReady: () => true };
      if (id === './supabase') return { supabase: null };
      throw new Error(`Unexpected import: ${id}`);
    },
  });
  const query = {
    select(cols) { calls.push(['select', cols]); return this; },
    eq(col, value) {
      calls.push(['eq', col, value]);
      return calls.filter((c) => c[0] === 'eq').length === 2 ? Promise.resolve({ data: rows, error }) : this;
    },
  };
  const exports = {};
  runInNewContext(transpile('ads.ts'), {
    exports,
    require: (id) => {
      if (id === './socialLinks') return socialLinks;
      if (id === './supabase') return { isSupabaseConfigured: true, supabase: {
        from: (table) => { calls.push(['from', table]); return query; },
        rpc: (fn, args) => { calls.push(['rpc', fn, args]); return Promise.resolve({ error: null }); },
      } };
      throw new Error(`Unexpected import: ${id}`);
    },
    Promise,
  });
  return { lib: exports, calls };
}

const plain = (value) => JSON.parse(JSON.stringify(value));

const ROW = {
  id: 'a1', placement: 'discover', brand: 'Brand', headline: 'Headline', body: 'Body', cta: 'Go',
  image_url: 'https://cdn.example.com/a.jpg', link_url: 'https://example.com/offer', active: true,
};

test('a complete row becomes a complete card', () => {
  const { lib } = load();
  assert.deepEqual(plain(lib.toSponsoredAd(ROW)), {
    id: 'a1', brand: 'Brand', headline: 'Headline', body: 'Body', cta: 'Go',
    imageUrl: 'https://cdn.example.com/a.jpg', linkUrl: 'https://example.com/offer',
    logo: null, tint: null, audience: [], position: null,
  });
});

test('a row without a brand or a headline is not drawn at all', () => {
  const { lib } = load();
  assert.equal(lib.toSponsoredAd({ ...ROW, brand: '  ' }), null);
  assert.equal(lib.toSponsoredAd({ ...ROW, headline: null }), null);
});

test('a link that is not a plain web address never becomes a button', () => {
  const { lib } = load();
  for (const link_url of ['javascript:alert(1)', 'https://user:pass@evil.com', 'not a url']) {
    const ad = lib.toSponsoredAd({ ...ROW, link_url });
    assert.equal(ad.linkUrl, null, link_url);
    assert.equal(ad.cta, null, link_url);
  }
});

test('button words with nowhere to go, or a link with no words, show no button', () => {
  const { lib } = load();
  const noLink = lib.toSponsoredAd({ ...ROW, link_url: null });
  assert.equal(noLink.cta, null);
  const noWords = lib.toSponsoredAd({ ...ROW, cta: '' });
  assert.equal(noWords.linkUrl, null);
});

test('only an https picture is loaded', () => {
  const { lib } = load();
  assert.equal(lib.toSponsoredAd({ ...ROW, image_url: 'http://cdn.example.com/a.jpg' }).imageUrl, null);
});

test('a database from before the migration still gives cards, without photo or button', () => {
  const { lib } = load();
  const { image_url, link_url, ...old } = ROW;
  const ad = lib.toSponsoredAd(old);
  assert.equal(ad.headline, 'Headline');
  assert.equal(ad.imageUrl, null);
  assert.equal(ad.cta, null);
});

test('reads active rows for the placement, and skips the unusable ones', async () => {
  const { lib, calls } = load({ rows: [ROW, { ...ROW, id: 'a2', brand: '' }] });
  const ads = await lib.fetchSponsoredAds('discover');
  assert.deepEqual(calls, [['from', 'ads'], ['select', '*'], ['eq', 'placement', 'discover'], ['eq', 'active', true]]);
  assert.deepEqual(ads.map((ad) => ad.id), ['a1']);
});

test('a failed read is no cards, not an error', async () => {
  const { lib } = load({ error: { message: 'permission denied' } });
  assert.deepEqual([...await lib.fetchSponsoredAds('discover')], []);
});

test('logo and tint are kept only when they are a short badge and a plain colour', () => {
  const { lib } = load();
  const ad = lib.toSponsoredAd({ ...ROW, logo: 'sl', tint: '#2A3A2E' });
  assert.equal(ad.logo, 'SL');
  assert.equal(ad.tint, '#2A3A2E');
  const bad = lib.toSponsoredAd({ ...ROW, logo: '<img>', tint: 'red; background:url(x)' });
  assert.equal(bad.logo, null);
  assert.equal(bad.tint, null);
});

test('targeting becomes readable lines, and anything unknown or odd is left out', () => {
  const { lib } = load();
  assert.deepEqual(plain(lib.audienceLines({ hobbies: ['Running'], goal: 'Run a marathon' })),
    ['People into Running', 'People whose goal is Run a marathon']);
  assert.deepEqual(plain(lib.audienceLines({ communities: ['Running', 'Strength'] })),
    ['Members of Running and Strength communities']);
  assert.deepEqual(plain(lib.audienceLines({ secret_segment: ['vip'], hobbies: [42, 'x'.repeat(41)] })), []);
  assert.deepEqual(plain(lib.audienceLines('not an object')), []);
  assert.deepEqual(plain(lib.audienceLines(null)), []);
});

test('cards come in chosen order, unpositioned ones last by brand', async () => {
  const rows = [
    { ...ROW, id: 'z', brand: 'Zed' },
    { ...ROW, id: 'b', brand: 'Bee', position: 2 },
    { ...ROW, id: 'a', brand: 'Aye' },
    { ...ROW, id: 'c', brand: 'Cee', position: 1 },
  ];
  const { lib } = load({ rows });
  assert.deepEqual((await lib.fetchSponsoredAds('discover')).map((ad) => ad.id), ['c', 'b', 'a', 'z']);
});

test('a view counts once per card per launch, an open every time', () => {
  const { lib, calls } = load();
  assert.equal(lib.recordAdEvent('a1', 'view'), true);
  assert.equal(lib.recordAdEvent('a1', 'view'), false);
  assert.equal(lib.recordAdEvent('a1', 'open'), true);
  assert.equal(lib.recordAdEvent('a1', 'open'), true);
  assert.deepEqual(plain(calls.filter((c) => c[0] === 'rpc')), [
    ['rpc', 'record_ad_event', { p_ad: 'a1', p_kind: 'view' }],
    ['rpc', 'record_ad_event', { p_ad: 'a1', p_kind: 'open' }],
    ['rpc', 'record_ad_event', { p_ad: 'a1', p_kind: 'open' }],
  ]);
});
