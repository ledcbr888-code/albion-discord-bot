'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { runInNewContext } = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const pkg = require('../package.json');

function isolatedAsyncFunction(name, context) {
  const start = source.indexOf('async function ' + name + '(');
  const end = source.indexOf('\nasync function ', start + 1);
  assert.ok(start >= 0 && end > start, name + ' not found');
  return runInNewContext(source.slice(start, end) + '\n' + name, context);
}

test('security: no request/cloudscraper dependency, no legacy HTTP calls, primary reporting unchanged', () => {
  assert.equal(pkg.dependencies.request, undefined);
  assert.equal(pkg.dependencies.cloudscraper, undefined);
  assert.doesNotMatch(source, /cloudscraper/);
  assert.match(source, /summarizeEntireBattleForGuildPages/);
  assert.match(source, /weaponIconCacheKey/);
  assert.match(source, /Auto-Battle scheduler started/);
});

test('AlbionBB weapon fallback uses one bounded Axios call and preserves tracked weapon IDs', async () => {
  const calls = [];
  const fetchMap = isolatedAsyncFunction('fetchAlbionBBWeaponMap', {
    axios: { get: async (url, opts) => {
      calls.push({ url, opts });
      return { data: { events: [{ Killer: { Name: 'Tester', itemId: 'T5_MAIN_FROSTSTAFF@3' } }] } };
    }},
    extractMainHandInfo: entity => entity.itemId ? { id: entity.itemId, quality: 1 } : null,
    console: { log() {}, warn() {} },
    Map, setTimeout, Math
  });
  const result = await fetchMap('529400001');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.timeout, 15000);
  assert.match(calls[0].url, /529400001/);
  assert.equal(result.get('tester').id, 'T5_MAIN_FROSTSTAFF@3');
});

test('AlbionBB HTML fallback returns null after one failed bounded Axios call', async () => {
  let calls = 0;
  const fallback = isolatedAsyncFunction('fetchAlbionBBPageFallback', {
    axios: { get: async () => { calls++; throw new Error('blocked'); } },
    console: { warn() {}, log() {} }
  });
  assert.equal(await fallback('123'), null);
  assert.equal(calls, 1);
});

test('AVA canonical local map list remains preferred without making HTTP requests', async () => {
  let httpCalls = 0;
  const fetchIndex = isolatedAsyncFunction('fetchAuthoritativeAvaMapIndex', {
    require: () => ({ all: Array.from({ length: 400 }, (_, i) => 'Map-' + i) }),
    axios: { get: async () => { httpCalls++; throw Error('not required'); } },
    console: { log() {} }
  });
  const maps = await fetchIndex();
  assert.equal(maps.length, 400);
  assert.equal(httpCalls, 0);
});

test('AVA Roads fallback keeps source URL, timeouts and parsed map metadata using Axios', async () => {
  const calls = [];
  const fakeCheerio = {
    load: () => selector => ({ text: () => 'teros-aulusum T6 Gold chest 3' })
  };
  const fetchMap = isolatedAsyncFunction('fetchAlbionRoadsMapData', {
    resolveAvaMapName: async () => ({ name: 'teros-aulusum', score: 1 }),
    ALBION_ROADS_SOURCE: 'https://albionroads.com/roads',
    axios: { get: async (url, opts) => { calls.push({ url, opts }); return { data: '<html></html>' }; } },
    cheerio: fakeCheerio,
    extractAvaCountFromPageText: () => 3,
    extractAlbionRoadsImage: () => '',
    console: { log() {}, warn() {} }
  });
  const map = await fetchMap('teros-aulusum');
  assert.equal(map.tier, 'T6');
  assert.equal(map.source, 'albionroads.com');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.timeout, 15000);
  assert.ok(calls[0].url.includes('search='));
});
