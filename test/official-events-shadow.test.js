'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createOfficialEventsShadowProbe,
  __test,
} = require('../official-events-shadow');

const observedAt = '2026-11-13T10:00:00.000Z';

function apiResponse(status, payload, retryAfter = null) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => payload === null ? '' : JSON.stringify(payload),
    headers: { get: name => name.toLowerCase() === 'retry-after' ? retryAfter : null },
  };
}

function fakeHttp(overrides = {}) {
  const calls = [];
  const http = {
    async get(url, config = {}) {
      calls.push({ method: 'GET', url, config });
      if (overrides.get) return overrides.get(url, config);
      return { data: [] };
    },
    async post(url, data, config = {}) {
      calls.push({ method: 'POST', url, data, config });
      if (overrides.post) return overrides.post(url, data, config);
      return { data };
    },
    async delete(url, config = {}) {
      calls.push({ method: 'DELETE', url, config });
      if (overrides.delete) return overrides.delete(url, config);
      return { data: null };
    },
  };
  return { http, calls };
}

function baseOptions(overrides = {}) {
  return {
    env: {
      OFFICIAL_EVENTS_SHADOW_ENABLED: 'true',
      SUPABASE_URL: 'https://battleboard-test.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-secret-not-logged',
    },
    fetchImpl: async () => apiResponse(200, []),
    http: fakeHttp().http,
    logger: { info() {}, warn() {}, error() {} },
    clock: () => new Date(observedAt),
    ...overrides,
  };
}

test('uses the Asia GameInfo Events endpoint and normalizes only one small row per Battle ID', () => {
  assert.equal(__test.OFFICIAL_EVENTS_POLL_INTERVAL_MS, 120000);
  assert.equal(__test.OFFICIAL_EVENTS_PAGE_LIMIT, 51);
  const result = __test.normalizeOfficialEvents([
    {
      EventId: 1001,
      BattleId: 9001,
      TimeStamp: '2026-11-13T09:58:00.000Z',
      Killer: { Id: 'killer-1', Name: 'name-is-not-stored' },
      Victim: { Id: 'victim-1' },
      Equipment: { mainHand: 'large-unused-payload' },
    },
    { EventId: 1002, BattleId: 9001, TimeStamp: '2026-11-13T09:59:00.000Z' },
    { EventId: 1003, BattleId: 9002, TimeStamp: '2026-11-13T09:59:30.000Z' },
    { EventId: 1004, Type: 'KILL' },
    { EventId: 'bad-id', BattleId: 'bad-battle-id' },
  ], observedAt);

  assert.equal(result.rows.length, 2);
  assert.deepEqual(result.rows.map(row => row.battle_id), ['9001', '9002']);
  assert.equal(result.rows[0].event_id, '1001');
  assert.equal(result.rows[0].source, 'official_events_shadow');
  assert.equal(result.rows[0].server, 'asia');
  assert.equal(result.rows[0].observed_at, observedAt);
  assert.equal(result.rows[0].event_time, '2026-11-13T09:58:00.000Z');
  assert.equal(result.rows[0].battle_finished_at, null);
  assert.equal(result.rows[0].is_new_battle, null);
  assert.deepEqual(result.rows[0].raw_payload, {
    eventId: '1001',
    battleId: '9001',
    timestamp: '2026-11-13T09:58:00.000Z',
    playerId: 'killer-1',
    victimId: 'victim-1',
    sourceServer: 'asia',
  });
  assert.equal(JSON.stringify(result.rows[0].raw_payload).includes('large-unused-payload'), false);
  assert.equal(result.rows[0].expires_at, '2026-11-16T10:00:00.000Z');
  assert.equal(result.invalidBattleIdCount, 2);
  assert.equal(result.missingEventIdCount, 0);
});

test('validates PostgREST ID filters and never builds filters from malformed IDs', () => {
  assert.equal(__test.buildInFilter(['100', '200', '100', 'x', null]), 'in.(100,200)');
  assert.equal(__test.buildInFilter([]), null);
  assert.equal(__test.formatLead(65000), '+1 นาที 5 วินาที');
  assert.equal(__test.formatLead(-1200), '-1 วินาที');
});

test('disabled by default and performs no GameInfo or Supabase requests', async () => {
  let externalCalls = 0;
  const probe = createOfficialEventsShadowProbe(baseOptions({
    env: {
      SUPABASE_URL: 'https://battleboard-test.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-secret',
    },
    fetchImpl: async () => { externalCalls++; return apiResponse(200, []); },
    http: {
      get: async () => { externalCalls++; return { data: [] }; },
      post: async () => { externalCalls++; return { data: [] }; },
      delete: async () => { externalCalls++; return { data: null }; },
    },
  }));

  assert.equal(probe.enabled, false);
  assert.deepEqual(await probe.runOnce(), { ok: false, skipped: true, reason: 'disabled' });
  assert.equal(externalCalls, 0);
});

test('records first observation per Battle ID and compares with Battle List first_seen_at', async () => {
  const events = [
    {
      EventId: 1001,
      BattleId: 9001,
      TimeStamp: '2026-11-13T09:58:00.000Z',
      Killer: { Id: 'killer-1', Name: 'ignored' },
    },
    { EventId: 1002, BattleId: 9001, TimeStamp: '2026-11-13T09:59:00.000Z' },
    { EventId: 1003, BattleId: 9002, TimeStamp: '2026-11-13T09:59:30.000Z' },
    { EventId: 1004, TimeStamp: '2026-11-13T09:59:45.000Z' },
  ];
  const { http, calls } = fakeHttp({
    get: async (url, config) => {
      if (url.endsWith('/discovery_observations')) {
        assert.equal(config.params.source, 'eq.official_events_shadow');
        assert.equal(config.params.server, 'eq.asia');
        return { data: [{ battle_id: '9001', event_id: '999', observed_at: '2026-11-13T09:58:00.000Z' }] };
      }
      if (url.endsWith('/battle_history')) {
        assert.equal(config.params.server, 'eq.asia');
        return { data: [{ battle_id: 9001, first_seen_at: '2026-11-13T10:01:00.000Z' }] };
      }
      throw new Error('Unexpected GET ' + url);
    },
    post: async (url, rows, config) => {
      assert.ok(url.endsWith('/discovery_observations'));
      assert.equal(config.params.on_conflict, 'source,server,battle_id');
      assert.match(config.headers.Prefer, /resolution=ignore-duplicates/);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].battle_id, '9002');
      assert.equal(rows[0].is_new_battle, true);
      assert.deepEqual(Object.keys(rows[0].raw_payload).sort(), [
        'battleId', 'eventId', 'playerId', 'sourceServer', 'timestamp', 'victimId',
      ]);
      return { data: rows };
    },
  });
  const probe = createOfficialEventsShadowProbe(baseOptions({
    fetchImpl: async url => {
      assert.equal(url, 'https://gameinfo-sgp.albiononline.com/api/gameinfo/events?limit=51&offset=0');
      return apiResponse(200, events);
    },
    http,
  }));

  const result = await probe.runOnce();
  assert.equal(result.ok, true);
  assert.equal(result.server, 'asia');
  assert.equal(result.apiEventCount, 4);
  assert.equal(result.eventsWithBattleId, 3);
  assert.equal(result.distinctBattleIds, 2);
  assert.equal(result.insertedBattleRows, 1);
  assert.equal(result.battleListMatched, 1);
  assert.equal(result.battleListLookupOk, true);
  assert.equal(result.pageCapReached, false);
  assert.equal(result.samples[0].battleId, '9001');
  assert.equal(result.samples[0].leadMs, 180000);
  assert.equal(result.samples[1].battleId, '9002');
  assert.equal(result.samples[1].battleListSeen, false);
  assert.equal(calls.filter(call => call.method === 'DELETE').length, 1, 'expired shadow data is pruned on the initial run');
  assert.equal(calls.some(call => call.url.includes('battle_detail_queue')), false);
  assert.equal(calls.some(call => call.url.includes('cron-sync')), false);
});

test('does not overlap two Official Events requests in the same bot process', async () => {
  let release;
  let notifyStarted;
  const started = new Promise(resolve => { notifyStarted = resolve; });
  const waitForRelease = new Promise(resolve => { release = resolve; });
  let apiCalls = 0;
  const probe = createOfficialEventsShadowProbe(baseOptions({
    fetchImpl: async () => {
      apiCalls++;
      notifyStarted();
      await waitForRelease;
      return apiResponse(200, []);
    },
  }));

  try {
    const first = probe.runOnce();
    await started;
    const second = await probe.runOnce();
    assert.deepEqual(second, { ok: true, skipped: true, reason: 'already-running' });
    assert.equal(apiCalls, 1);
    release();
    const result = await first;
    assert.equal(result.ok, true);
    assert.equal(apiCalls, 1);
  } finally {
    release();
  }
});

test('marks a full 51-event page as capped instead of claiming full coverage', async () => {
  const page = Array.from({ length: 51 }, (_, index) => ({
    EventId: index + 1,
    BattleId: 8000 + index,
    TimeStamp: observedAt,
  }));
  const { http } = fakeHttp({
    get: async url => url.endsWith('/discovery_observations') || url.endsWith('/battle_history')
      ? { data: [] } : Promise.reject(new Error('Unexpected URL: ' + url)),
    post: async (_url, rows) => ({ data: rows }),
  });
  const probe = createOfficialEventsShadowProbe(baseOptions({
    fetchImpl: async () => apiResponse(200, page),
    http,
  }));

  const result = await probe.runOnce();
  assert.equal(result.apiEventCount, 51);
  assert.equal(result.pageCapReached, true);
  assert.equal(result.distinctBattleIds, 51);
});

test('backs off after API rate limiting and respects Retry-After', async () => {
  let apiCalls = 0;
  const probe = createOfficialEventsShadowProbe(baseOptions({
    fetchImpl: async () => {
      apiCalls++;
      return apiResponse(429, { message: 'Too many requests' }, '180');
    },
  }));

  const first = await probe.runOnce();
  const second = await probe.runOnce();
  assert.equal(first.ok, false);
  assert.equal(first.retryInMs, 180000);
  assert.equal(second.skipped, true);
  assert.equal(second.reason, 'backoff-active');
  assert.equal(apiCalls, 1);
});
