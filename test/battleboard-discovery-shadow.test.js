'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createBattleboardDiscoveryShadow,
  __test: { normalizeBattleId },
} = require('../battleboard-discovery-shadow');

function makeResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  };
}

function makeEnv(overrides = {}) {
  return {
    BATTLEBOARD_DISCOVERY_SHADOW_ENABLED: 'true',
    BATTLEBOARD_API_URL: 'https://battleboard.example/',
    BOT_API_KEY: 'x'.repeat(40),
    ...overrides,
  };
}

function silentLogger() {
  return { log() {}, warn() {} };
}

test('normalizes only positive numeric Battle IDs without Number precision loss', () => {
  assert.equal(normalizeBattleId('12345678901234567890'), '12345678901234567890');
  assert.equal(normalizeBattleId('00123'), '00123');
  assert.equal(normalizeBattleId(0), null);
  assert.equal(normalizeBattleId('-1'), null);
  assert.equal(normalizeBattleId('battle-123'), null);
  assert.equal(normalizeBattleId(''), null);
});

test('discovery intake is disabled by default and never calls the API', async () => {
  let calls = 0;
  const reporter = createBattleboardDiscoveryShadow({
    env: makeEnv({ BATTLEBOARD_DISCOVERY_SHADOW_ENABLED: 'false' }),
    fetchImpl: async () => { calls++; throw new Error('should not be called'); },
    logger: silentLogger(),
  });

  const result = await reporter.submit(['526812515']);
  assert.deepEqual(result, { ok: true, skipped: 'disabled', submitted: 0 });
  assert.equal(calls, 0);
});

test('requires HTTPS and a valid shared API key when explicitly enabled', async () => {
  let calls = 0;
  const reporter = createBattleboardDiscoveryShadow({
    env: makeEnv({ BATTLEBOARD_API_URL: 'http://battleboard.example' }),
    fetchImpl: async () => { calls++; return makeResponse(200, { ok: true }); },
    logger: silentLogger(),
  });

  const result = await reporter.submit(['526812515']);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'https-required');
  assert.equal(calls, 0);
});

test('posts only deduplicated Battle IDs with the source label and Bearer auth', async () => {
  const captured = [];
  const reporter = createBattleboardDiscoveryShadow({
    env: makeEnv(),
    now: () => Date.parse('2026-11-13T12:00:00.000Z'),
    fetchImpl: async (url, options) => {
      captured.push({ url, options });
      return makeResponse(200, { ok: true, attempted: 2, upserted: 2 });
    },
    logger: silentLogger(),
  });

  const result = await reporter.submit(['526812515', 'not-an-id', '526812515', '527454129', '0']);
  assert.equal(result.ok, true);
  assert.equal(result.submitted, 2);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].url, 'https://battleboard.example/api/bot-discovery');
  assert.equal(captured[0].options.method, 'POST');
  assert.equal(captured[0].options.headers.Authorization, 'Bearer ' + 'x'.repeat(40));

  const payload = JSON.parse(captured[0].options.body);
  assert.equal(payload.server, 'asia');
  assert.equal(payload.items.length, 2);
  assert.deepEqual(payload.items.map(item => item.battleId), ['526812515', '527454129']);
  assert.ok(payload.items.every(item => item.source === 'official_events_shadow'));
  assert.ok(payload.items.every(item => item.observedAt === '2026-11-13T12:00:00.000Z'));
  assert.ok(payload.items.every(item => Object.keys(item).sort().join(',') === 'battleId,observedAt,source'),
    'no raw kill-event payload or unrelated fields should be sent');
});

test('remembers successful submissions for ten minutes but still sends newly observed IDs', async () => {
  let at = Date.parse('2026-11-13T12:00:00.000Z');
  const payloads = [];
  const reporter = createBattleboardDiscoveryShadow({
    env: makeEnv(),
    now: () => at,
    fetchImpl: async (_url, options) => {
      payloads.push(JSON.parse(options.body));
      return makeResponse(200, { ok: true });
    },
    logger: silentLogger(),
  });

  const first = await reporter.submit(['1001', '1002']);
  const repeated = await reporter.submit(['1001', '1002']);
  const mixed = await reporter.submit(['1001', '1003']);
  assert.equal(first.submitted, 2);
  assert.equal(repeated.skipped, 'duplicate');
  assert.equal(repeated.submitted, 0);
  assert.equal(mixed.submitted, 1);
  assert.deepEqual(payloads.map(payload => payload.items.map(item => item.battleId)), [['1001', '1002'], ['1003']]);

  at += 10 * 60 * 1000 + 1;
  const afterExpiry = await reporter.submit(['1001']);
  assert.equal(afterExpiry.submitted, 1);
  assert.equal(payloads.length, 3);
});

test('failed intake does not mark IDs as delivered, so the next observation retries', async () => {
  let calls = 0;
  const reporter = createBattleboardDiscoveryShadow({
    env: makeEnv(),
    fetchImpl: async () => {
      calls++;
      return calls === 1
        ? makeResponse(503, { error: 'temporary unavailable' })
        : makeResponse(200, { ok: true });
    },
    logger: silentLogger(),
  });

  const first = await reporter.submit(['1001']);
  const second = await reporter.submit(['1001']);
  assert.equal(first.ok, false);
  assert.equal(first.submitted, 0);
  assert.equal(second.ok, true);
  assert.equal(second.submitted, 1);
  assert.equal(calls, 2);
});

test('splits unusually large submissions into API batches of at most 100 IDs', async () => {
  const batchSizes = [];
  const reporter = createBattleboardDiscoveryShadow({
    env: makeEnv(),
    fetchImpl: async (_url, options) => {
      batchSizes.push(JSON.parse(options.body).items.length);
      return makeResponse(200, { ok: true });
    },
    logger: silentLogger(),
  });

  const result = await reporter.submit(Array.from({ length: 125 }, (_, index) => String(10000 + index)));
  assert.equal(result.submitted, 125);
  assert.deepEqual(batchSizes, [100, 25]);
});
