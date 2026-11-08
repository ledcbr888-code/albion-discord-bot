'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createBattleboardIntegration,
  __test: {
    normalizeName, validDiscordServerId, buildTrackedItems, getBattleGuilds,
    targetGuildMatches, evaluateAutoBattleRoutes, deliveryKey, deliveryNonce,
    snapshotFingerprint,
  },
} = require('../battleboard-integration');

test('normalizes names consistently', () => {
  assert.equal(normalizeName('  PLAC   '), 'plac');
});

test('accepts only Discord server snowflakes', () => {
  assert.equal(validDiscordServerId('1165745441120452638'), true);
  assert.equal(validDiscordServerId('12345'), false);
});

test('builds a deduplicated snapshot and fills guild IDs from Auto-Battle settings', () => {
  const items = buildTrackedItems({
    guilds: ['PLAC', 'Psz', { name: 'plac' }],
    players: ['banksigice', 'AD03E', 'banksigice'],
    autoBattles: [
      { targetGuild: 'PLAC', targetGuildId: 'F3SlNDZKTN6ZQj_7jDdyAQ' },
      { targetGuild: 'Psz', targetGuildId: '0SZ1Nlh7RfmuuuxS0lZ3kw' },
    ],
  });
  assert.equal(items.length, 4);
  assert.deepEqual(items.filter(item => item.type === 'guild').map(item => item.id), [
    'F3SlNDZKTN6ZQj_7jDdyAQ',
    '0SZ1Nlh7RfmuuuxS0lZ3kw',
  ]);
  assert.equal(items.filter(item => item.type === 'player').length, 2);
});

test('extracts IDs and names from the battle guild index', () => {
  const guilds = getBattleGuilds({
    guilds: {
      'guild-id-1': { name: 'PLAC' },
      'guild-id-2': { id: 'guild-id-2', name: 'Psz' },
    },
  });
  assert.equal(guilds.length, 2);
  assert.equal(guilds[0].id, 'guild-id-1');
});

test('matches Auto-Battle routes by exact guild ID or normalized name', () => {
  const detail = { guilds: { F3SlNDZKTN6ZQj_7jDdyAQ: { name: 'PLAC' } } };
  assert.equal(targetGuildMatches({ targetGuildId: 'F3SlNDZKTN6ZQj_7jDdyAQ' }, detail, {}), true);
  assert.equal(targetGuildMatches({ targetGuild: 'plac' }, detail, {}), true);
  assert.equal(targetGuildMatches({ targetGuild: 'Other Guild' }, detail, {}), false);
});

test('matches a guild event when its detail guild index is incomplete', () => {
  const event = { matches: [{ type: 'guild', id: 'guild-id-1', name: 'PLAC' }] };
  assert.equal(targetGuildMatches({ targetGuild: 'PLAC' }, {}, event), true);
});

test('checks each route threshold independently against total tracked Fame', () => {
  const routes = [
    { targetGuild: 'PLAC', channelId: '99999999999999999', minFrames: 100000 },
    { targetGuild: 'Psz', channelId: '99999999999999999', minFrames: 200000 },
  ];
  const report = {
    totalFame: 150000,
    playerReportData: [
      { displayName: 'tracked-player-1', guild: 'PLAC', fame: 80000 },
      { displayName: 'tracked-player-2', guild: 'Psz', fame: 70000 },
    ],
  };
  const detail = {
    guilds: {
      plac: { id: 'plac', name: 'PLAC' },
      psz: { id: 'psz', name: 'Psz' },
    },
  };

  const checks = evaluateAutoBattleRoutes(routes, report, detail, {});
  assert.deepEqual(checks.map(check => ({
    targetGuild: check.targetGuild,
    totalFame: check.totalFame,
    minFame: check.minFame,
    eligible: check.eligible,
  })), [
    { targetGuild: 'PLAC', totalFame: 150000, minFame: 100000, eligible: true },
    { targetGuild: 'Psz', totalFame: 150000, minFame: 200000, eligible: false },
  ]);
});

test('checks both matching Guild routes against the tracked-player Fame total', () => {
  const routes = [
    { targetGuild: 'Crusader Kings', channelId: '99999999999999999', minFrames: 100000 },
    { targetGuild: 'All In Fighting', channelId: '99999999999999999', minFrames: 200000 },
  ];
  const report = {
    totalFame: 3100000,
    playerReportData: [
      { displayName: 'AD03E', guild: 'All In Fighting', fame: 1100000 },
      { displayName: 'potter200', guild: 'All In Fighting', fame: 1000000 },
      { displayName: 'WhatWrongss', guild: 'All In Fighting', fame: 1000000 },
    ],
  };
  const detail = {
    guilds: {
      ck: { id: 'ck', name: 'Crusader Kings' },
      aif: { id: 'aif', name: 'All In Fighting' },
    },
  };

  const checks = evaluateAutoBattleRoutes(routes, report, detail, {});
  assert.equal(checks.find(check => check.targetGuild === 'Crusader Kings').totalFame, 3100000);
  assert.equal(checks.find(check => check.targetGuild === 'Crusader Kings').eligible, true);
  assert.equal(checks.find(check => check.targetGuild === 'All In Fighting').totalFame, 3100000);
  assert.equal(checks.find(check => check.targetGuild === 'All In Fighting').eligible, true);
});

test('resolves an ID-only Auto-Battle route to its Guild name before checking tracked Fame', () => {
  const checks = evaluateAutoBattleRoutes(
    [{ targetGuildId: 'aif-id', channelId: '99999999999999999', minFrames: 200000 }],
    { totalFame: 300000, playerReportData: [{ displayName: 'AD03E', guild: 'All In Fighting', fame: 300000 }] },
    { guilds: { 'aif-id': { name: 'All In Fighting' } } },
    {}
  );
  assert.equal(checks[0].targetGuild, 'All In Fighting');
  assert.equal(checks[0].totalFame, 300000);
  assert.equal(checks[0].eligible, true);
});

test('creates stable idempotency keys per battle and channel', () => {
  assert.equal(deliveryKey('526764798', '12345678901234567'), '526764798:12345678901234567');
});


test('creates a stable, distinct Discord nonce for every Battle, channel, and report part', () => {
  const first = deliveryNonce('526764798', '12345678901234567', 1);
  assert.equal(first, deliveryNonce('526764798', '12345678901234567', 1));
  assert.match(first, /^[a-f0-9]{24}$/);
  assert.notEqual(first, deliveryNonce('526764799', '12345678901234567', 1));
  assert.notEqual(first, deliveryNonce('526764798', '12345678901234568', 1));
  assert.notEqual(first, deliveryNonce('526764798', '12345678901234567', 2));
});

test('a detail-pending Auto-Battle does not block later events and is retried', async () => {
  const oldApiUrl = process.env.BATTLEBOARD_API_URL;
  const oldApiKey = process.env.BOT_API_KEY;
  const oldFetch = global.fetch;
  const channelId = '99999999999999999';
  const serverId = '1165745441120452638';
  const events = [
    {
      battle_id: '1001',
      checked_at: '2026-11-08T00:00:01.000Z',
      matches: [{ type: 'guild', id: 'guild-plac', name: 'PLAC' }],
    },
    {
      battle_id: '1002',
      checked_at: '2026-11-08T00:00:02.000Z',
      matches: [{ type: 'guild', id: 'guild-plac', name: 'PLAC' }],
    },
  ];
  const config = {
    guilds: [{ id: 'guild-plac', name: 'PLAC' }],
    players: ['AD03E'],
    autoBattles: [{
      targetGuild: 'PLAC',
      targetGuildId: 'guild-plac',
      channelId,
      minFrames: 100000,
      enabled: true,
    }],
    battleboardState: {},
  };
  const items = buildTrackedItems(config);
  Object.assign(config.battleboardState, {
    snapshotInitialized: true,
    snapshotFingerprint: snapshotFingerprint(items),
    lastSnapshotSyncAt: new Date().toISOString(),
    cursorInitialized: true,
    eventCursor: { after: '2026-11-08T00:00:00.000Z', afterBattleId: '0' },
    delivered: [],
    pendingEvents: [],
  });

  const eventCalls = { count: 0 };
  const detailCalls = new Map();
  const sent = [];
  let integration;
  process.env.BATTLEBOARD_API_URL = 'https://battleboard.example';
  process.env.BOT_API_KEY = 'test-key-'.padEnd(40, 'x');
  global.fetch = async urlValue => {
    const url = new URL(String(urlValue));
    let body;
    if (url.pathname === '/api/bot-tracked-entities' && url.searchParams.get('mode') === 'events') {
      eventCalls.count++;
      body = { items: eventCalls.count === 1 ? events : [] };
    } else if (url.pathname === '/api/bot-battle-detail') {
      const id = url.searchParams.get('id');
      const calls = (detailCalls.get(id) || 0) + 1;
      detailCalls.set(id, calls);
      if (id === '1001' && calls === 1) {
        body = { status: 404 };
      } else {
        body = {
          ready: true,
          detailSchemaVersion: 4,
          detail: { guilds: { 'guild-plac': { id: 'guild-plac', name: 'PLAC' } } },
        };
      }
    } else {
      throw new Error('Unexpected fake URL: ' + url.href);
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };

  integration = createBattleboardIntegration({
    client: {
      channels: {
        fetch: async id => {
          assert.equal(id, channelId);
          return {
            send: async payload => {
              sent.push(payload);
              return { id: 'message-' + sent.length };
            },
          };
        },
      },
    },
    getAllGuildConfigs: () => [{ guildId: serverId, config }],
    getGuildConfig: () => config,
    saveData: () => {},
    buildBattleReportPayload: async battleId => ({
      totalFame: 500000,
      totalKills: 10,
      totalDeaths: 2,
      battleUrl: 'https://example.test/battle/' + battleId,
      payload: { files: [Buffer.from('image-part-1'), Buffer.from('image-part-2')], content: 'report body for ' + battleId },
    }),
    formatFame: value => Number(value || 0).toLocaleString(),
  });

  try {
    await integration.tick();
    assert.equal(sent.length, 2, 'the later ready Battle should send both report parts during the first poll');
    assert.equal(sent[0].nonce, deliveryNonce('1002', channelId, 1));
    assert.equal(sent[0].enforceNonce, true);
    assert.match(sent[0].content, /Battle ID: 1002/);
    assert.equal(sent[1].nonce, deliveryNonce('1002', channelId, 2));
    assert.match(sent[1].content, /ส่วนที่ 2\/2.*Battle ID: 1002/);
    assert.equal(config.battleboardState.eventCursor.afterBattleId, '1002');
    assert.deepEqual(config.battleboardState.pendingEvents.map(entry => entry.battleId), ['1001']);

    integration.stop();
    await integration.tick();
    assert.equal(sent.length, 4, 'the earlier Battle should send both parts after its detail becomes ready');
    assert.equal(sent[2].nonce, deliveryNonce('1001', channelId, 1));
    assert.match(sent[2].content, /Battle ID: 1001/);
    assert.equal(sent[3].nonce, deliveryNonce('1001', channelId, 2));
    assert.match(sent[3].content, /ส่วนที่ 2\/2.*Battle ID: 1001/);
    assert.equal(config.battleboardState.pendingEvents.length, 0);
    assert.equal(detailCalls.get('1001'), 2);
    assert.equal(detailCalls.get('1002'), 1);
  } finally {
    if (integration) integration.stop();
    global.fetch = oldFetch;
    if (oldApiUrl === undefined) delete process.env.BATTLEBOARD_API_URL;
    else process.env.BATTLEBOARD_API_URL = oldApiUrl;
    if (oldApiKey === undefined) delete process.env.BOT_API_KEY;
    else process.env.BOT_API_KEY = oldApiKey;
  }
});

test('does not refresh an unchanged tracking snapshot more often than every five minutes', () => {
  const items = buildTrackedItems({ guilds: ['PLAC'], players: [] });
  const signature = require('../battleboard-integration').__test.snapshotFingerprint(items);
  const state = {
    snapshotInitialized: true,
    snapshotFingerprint: signature,
    lastSnapshotSyncAt: '2026-11-06T00:00:00.000Z',
  };
  const { isSnapshotSyncDue } = require('../battleboard-integration').__test;
  assert.equal(isSnapshotSyncDue(state, items, Date.parse('2026-11-06T00:04:59.000Z')), false);
  assert.equal(isSnapshotSyncDue(state, items, Date.parse('2026-11-06T00:05:00.000Z')), true);
  assert.equal(isSnapshotSyncDue(state, buildTrackedItems({ guilds: ['Psz'], players: [] }), Date.parse('2026-11-06T00:01:00.000Z')), true);
});

test('backs off transient API failures exponentially and caps retry delay at five minutes', () => {
  const { retryDelayMs } = require('../battleboard-integration').__test;
  assert.equal(retryDelayMs(1), 30000);
  assert.equal(retryDelayMs(2), 60000);
  assert.equal(retryDelayMs(3), 120000);
  assert.equal(retryDelayMs(20), 300000);
});

test('only clears a previous website snapshot when the local tracking list becomes empty', () => {
  const { needsEmptySnapshotCleanup } = require('../battleboard-integration').__test;
  assert.equal(needsEmptySnapshotCleanup({ snapshotInitialized: false }), false);
  assert.equal(needsEmptySnapshotCleanup({ snapshotInitialized: true, snapshotFingerprint: '[]' }), false);
  assert.equal(needsEmptySnapshotCleanup({ snapshotInitialized: true, snapshotFingerprint: '[["guild","plac","id"]]' }), true);
});
