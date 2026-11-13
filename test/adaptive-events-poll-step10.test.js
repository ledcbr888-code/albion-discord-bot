'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBattleboardIntegration, __test } = require('../battleboard-integration');

const serverId = '1165745441120452638';
const priorCursor = { after: '2026-11-11T00:00:00.000Z', afterBattleId: '0' };
function setup(overrides = {}) {
  const config = {
    guilds: [{ id: 'guild-plac', name: 'PLAC' }],
    players: [],
    autoBattles: [{ enabled: true, targetGuild: 'PLAC', channelId: '99999999999999999' }],
    battleboardState: {
      cursorInitialized: true,
      eventCursor: { ...priorCursor },
      snapshotInitialized: true,
      pendingEvents: [],
      delivered: [],
    },
  };
  const { buildTrackedItems, snapshotFingerprint } = __test;
  config.battleboardState.snapshotFingerprint = snapshotFingerprint(buildTrackedItems(config));
  config.battleboardState.lastSnapshotSyncAt = new Date().toISOString();
  return { config, integration: createBattleboardIntegration({
    client: {}, getAllGuildConfigs: () => [{ guildId: serverId, config }],
    getGuildConfig: () => config, saveData: () => true,
    isBattleProcessed: () => true,
    ...overrides,
  }) };
}
async function scoped(callback) {
  const envUrl = process.env.BATTLEBOARD_API_URL;
  const envKey = process.env.BOT_API_KEY;
  const oldFetch = global.fetch;
  const oldLog = console.log;
  const oldWarn = console.warn;
  const oldError = console.error;
  process.env.BATTLEBOARD_API_URL = 'https://battleboard.example';
  process.env.BOT_API_KEY = 'unit-test-'.padEnd(40, 'x');
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  try { await callback(); } finally {
    global.fetch = oldFetch;
    console.log = oldLog;
    console.warn = oldWarn;
    console.error = oldError;
    if (envUrl === undefined) delete process.env.BATTLEBOARD_API_URL;
    else process.env.BATTLEBOARD_API_URL = envUrl;
    if (envKey === undefined) delete process.env.BOT_API_KEY;
    else process.env.BOT_API_KEY = envKey;
  }
}
function reply(body, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: key => headers[String(key).toLowerCase()] || null },
    text: async () => JSON.stringify(body),
  };
}
test('Step 10 cadence and endpoint timeouts are explicitly bounded', () => {
  assert.equal(__test.EVENT_POLL_IDLE_MS, 60_000);
  assert.equal(__test.EVENT_POLL_BURST_MS, 7_000);
  assert.ok(__test.EVENT_POLL_BURST_MS >= 5_000 && __test.EVENT_POLL_BURST_MS <= 10_000);
  assert.equal(__test.MAX_CONSECUTIVE_BURST_POLLS, 6);
  assert.equal(__test.EVENTS_FEED_TIMEOUT_MS, 10_000);
  assert.equal(__test.SUMMARY_TIMEOUT_MS, 15_000);
  assert.equal(__test.DETAIL_TIMEOUT_MS, 30_000);
});
test('new Events schedule 7s burst; empty Events restore 60s and preserve cursor', async () => {
  await scoped(async () => {
    let calls = 0;
    global.fetch = async () => {
      calls++;
      if (calls === 1) return reply({ items: [], cursor: priorCursor }); // preflight
      if (calls === 2) return reply({ items: [{
        battle_id: '529000001', checked_at: '2026-11-11T00:01:00.000Z',
        matches: [{ type: 'guild', id: 'guild-plac', name: 'PLAC' }],
      }] });
      return reply({ items: [] });
    };
    const { config, integration } = setup();
    try {
      assert.equal(await integration.start(), true);
      await integration.tick();
      assert.equal(integration.getPollStatus().lastScheduledDelayMs, 7_000);
      assert.equal(integration.getPollStatus().consecutiveBurstPolls, 1);
      assert.equal(config.battleboardState.eventCursor.afterBattleId, '529000001');
      await integration.tick();
      assert.equal(integration.getPollStatus().lastScheduledDelayMs, 60_000);
      assert.equal(integration.getPollStatus().consecutiveBurstPolls, 0);
    } finally { integration.stop(); }
  });
});
test('429 Retry-After suppresses further requests and never enters burst', async () => {
  await scoped(async () => {
    let calls = 0;
    global.fetch = async () => {
      calls++;
      if (calls === 1) return reply({ items: [], cursor: priorCursor });
      return reply({ error: 'too many requests' }, 429, { 'retry-after': '120' });
    };
    const { config, integration } = setup();
    try {
      assert.equal(await integration.start(), true);
      await integration.tick();
      const untilMs = Date.parse(config.battleboardState.retryAfterAt);
      assert.ok(untilMs >= Date.now() + 115_000, 'must respect Retry-After');
      assert.ok(integration.getPollStatus().lastScheduledDelayMs >= 115_000);
      await integration.tick();
      assert.equal(calls, 2, 'cooldown must avoid additional HTTP calls');
      assert.equal(integration.getPollStatus().consecutiveBurstPolls, 0);
    } finally { integration.stop(); }
  });
});
test('single-flight and shutdown abort in-flight feed without advancing cursor', async () => {
  await scoped(async () => {
    let started;
    const requestStarted = new Promise(resolve => { started = resolve; });
    let calls = 0;
    global.fetch = async (_url, options) => {
      calls++;
      if (calls === 1) return reply({ items: [], cursor: priorCursor });
      started();
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('aborted on stop')), { once: true });
      });
    };
    const { config, integration } = setup();
    try {
      assert.equal(await integration.start(), true);
      const first = integration.tick();
      await requestStarted;
      assert.equal(integration.getPollStatus().activeRequests, 1);
      await integration.tick();
      assert.equal(calls, 2, 'single-flight rejects overlapping tick');
      integration.stop();
      await first;
      assert.equal(integration.getPollStatus().activeRequests, 0);
      assert.equal(integration.getPollStatus().running, false);
      assert.equal(config.battleboardState.eventCursor.afterBattleId, '0');
      assert.equal(config.battleboardState.consecutiveFailures || 0, 0);
    } finally { integration.stop(); }
  });
});
