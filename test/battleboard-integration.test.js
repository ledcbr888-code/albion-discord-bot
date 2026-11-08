'use strict';
const test = require('node:test');
const { createTrackingBackupScheduler, fingerprintTrackingSnapshot, createThrottledSuccessLogger } = require('../tracking-backup-scheduler');
const assert = require('node:assert/strict');
const {
  createBattleboardIntegration,
  __test: {
    normalizeName, validDiscordServerId, buildTrackedItems, getBattleGuilds,
    targetGuildMatches, evaluateAutoBattleRoutes, deliveryKey, deliveryNonce,
    snapshotFingerprint, hasTrackedSnapshotChanged, timestampMs, formatThaiDuration, formatThaiTimestamp,
    formatPreciseDuration, elapsedMsBetween, getBattleDelayMetrics, formatBattleDelayLines,
  },
} = require('../battleboard-integration');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

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


test('formats elapsed durations in Thai for seconds, minutes, hours, and days', () => {
  assert.equal(formatThaiDuration(500), 'น้อยกว่า 1 วินาที');
  assert.equal(formatThaiDuration(45000), '45 วินาที');
  assert.equal(formatThaiDuration(125000), '2 นาที 5 วินาที');
  assert.equal(formatThaiDuration(3661000), '1 ชั่วโมง 1 นาที 1 วินาที');
  assert.equal(formatThaiDuration(90061000), '1 วัน 1 ชั่วโมง 1 นาที 1 วินาที');
  assert.equal(timestampMs('not-a-date'), null);
});

test('normalizes numeric timestamps and formats precise stage timing in Bangkok time', () => {
  assert.equal(timestampMs(1793923200), 1793923200000);
  assert.equal(timestampMs(1793923200000), 1793923200000);
  assert.equal(timestampMs('1793923200'), 1793923200000);
  assert.equal(formatPreciseDuration(0), '0 ms');
  assert.equal(formatPreciseDuration(275), '275 ms');
  assert.equal(formatPreciseDuration(1250), '1.25 วินาที');
  assert.equal(formatThaiTimestamp('2026-11-08T00:16:26.196Z'),
    '08/11/2026 07:16:26 น. (UTC 2026-11-08T00:16:26.196Z)');
  assert.equal(elapsedMsBetween('2026-11-08T00:16:26.196Z', '2026-11-08T00:18:30.923Z'), 124727);
  assert.equal(elapsedMsBetween('2026-11-08T00:18:30.923Z', '2026-11-08T00:16:26.196Z'), null);
});

test('calculates Battle-start-to-send and Battle-end-to-send delays separately', () => {
  const event = { battle_start_time: '2026-11-08T10:00:00.000Z' };
  const detail = {
    startTime: '2026-11-08T10:00:00.000Z',
    endTime: '2026-11-08T10:04:00.000Z',
  };
  const sentAt = '2026-11-08T10:07:30.000Z';
  const metrics = getBattleDelayMetrics(event, detail, sentAt);
  assert.equal(metrics.fromBattleStartMs, 450000);
  assert.equal(metrics.fromBattleEndMs, 210000);
  assert.deepEqual(formatBattleDelayLines(event, detail, sentAt), [
    '⏱️ ตั้งแต่ Battle เริ่มจนส่งรายงานครบ: 7 นาที 30 วินาที',
    '⏱️ หลัง Battle จบจนส่งรายงานครบ: 3 นาที 30 วินาที',
  ]);
});

test('does not report negative or fabricated delays when Battle timestamps are missing or invalid', () => {
  const metrics = getBattleDelayMetrics(
    { battle_start_time: '2026-11-08T10:00:00.000Z' },
    { endTime: 'invalid-time' },
    '2026-11-08T09:59:00.000Z'
  );
  assert.equal(metrics.fromBattleStartMs, null);
  assert.equal(metrics.fromBattleEndMs, null);
  assert.match(formatBattleDelayLines({}, {}, '2026-11-08T10:00:00.000Z')[0], /ไม่มีข้อมูลเวลาเริ่ม/);
  assert.match(formatBattleDelayLines({}, {}, '2026-11-08T10:00:00.000Z')[1], /ไม่มีข้อมูลเวลาจบ/);
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
  const battleStartTime = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const battleEndTime = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const events = [
    {
      battle_id: '1001',
      battle_start_time: battleStartTime,
      first_seen_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      checked_at: new Date(Date.now() - 34 * 60 * 1000).toISOString(),
      matches: [{ type: 'guild', id: 'guild-plac', name: 'PLAC' }],
    },
    {
      battle_id: '1002',
      battle_start_time: battleStartTime,
      first_seen_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      checked_at: new Date(Date.now() - 34 * 60 * 1000 + 1000).toISOString(),
      matches: [{ type: 'guild', id: 'guild-plac', name: 'PLAC' }],
    },
    {
      battle_id: '1002',
      battle_start_time: battleStartTime,
      first_seen_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      checked_at: new Date(Date.now() - 34 * 60 * 1000 + 2000).toISOString(),
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
  const capturedLogs = [];
  const oldConsoleLog = console.log;
  const oldConsoleWarn = console.warn;
  const oldConsoleError = console.error;
  console.log = (...args) => capturedLogs.push(args.join(' '));
  console.warn = (...args) => capturedLogs.push(args.join(' '));
  console.error = (...args) => capturedLogs.push(args.join(' '));
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
          detail: {
            startTime: battleStartTime,
            endTime: battleEndTime,
            guilds: { 'guild-plac': { id: 'guild-plac', name: 'PLAC' } },
          },
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
    assert.equal(detailCalls.get('1002'), 2);
    assert.ok(capturedLogs.some(line => line.includes('รับ Events feed จาก Battleboard') && line.includes('API ใช้เวลา=')));
    assert.ok(capturedLogs.some(line => line.includes('บอทได้รับ Battle Event') && line.includes('first_seen→checked_at=')));
    assert.ok(capturedLogs.some(line => line.includes('รายละเอียด Battle พร้อมใช้งาน') && line.includes('API รวม')));
    assert.ok(capturedLogs.some(line => line.includes('สร้างรายงาน/ไฟล์เสร็จ') && line.includes('จำนวนไฟล์=2')));
    assert.ok(capturedLogs.some(line => line.includes('ตรวจ Fame/เกณฑ์เสร็จ') && line.includes('ผ่าน')));
    assert.ok(capturedLogs.some(line => line.includes('สรุปเวลาแต่ละขั้นตอน') && line.includes('checked_at→บอทรับ=')));
    assert.ok(capturedLogs.some(line => line.includes('ประมวลผล Battle ที่ค้างเสร็จแล้ว') && line.includes('Retry ทั้งหมด=1')));
    assert.equal(capturedLogs.filter(line => line.includes('กำลังส่งรายงานส่วนที่') && line.includes('ไฟล์แนบ')).length, 4);
    assert.equal(capturedLogs.filter(line => line.includes('ส่งรายงานส่วนที่') && line.includes('เข้า Discord สำเร็จ')).length, 4);
    assert.ok(capturedLogs.filter(line => line.includes('ส่งรายงานส่วนที่') && line.includes('เข้า Discord สำเร็จ'))
      .every(line => line.includes('ใช้เวลาส่ง=')), 'each sent file should report its own send duration');
    assert.equal(capturedLogs.filter(line => line.includes('ส่งรายงานครบทุกส่วนเข้า Discord สำเร็จ')).length, 2);
    assert.ok(capturedLogs.filter(line => line.includes('ส่งรายงานครบทุกส่วนเข้า Discord สำเร็จ'))
      .every(line => line.includes('ใช้เวลาส่งรวม=')), 'each completed report should report total send duration');
    assert.equal(capturedLogs.filter(line => line.includes('ตั้งแต่ Battle เริ่มจนส่งรายงานครบ')).length, 2);
    assert.equal(capturedLogs.filter(line => line.includes('หลัง Battle จบจนส่งรายงานครบ')).length, 2);
    assert.ok(capturedLogs.some(line => line.includes('รายละเอียด Battle ยังไม่พร้อม จัดเข้าคิวรอข้อมูลแล้ว')));
    assert.ok(capturedLogs.some(line => line.includes('เริ่มส่งรายงาน') && line.includes('Battle ID=1002')));
    assert.ok(capturedLogs.some(line => line.includes('ข้ามรายงานนี้ เพราะมีบันทึกว่าส่งเข้า Discord สำเร็จแล้ว') && line.includes('Battle ID=1002')),
      'a previously delivered event should state why it was skipped instead of silently continuing');
  } finally {
    if (integration) integration.stop();
    console.log = oldConsoleLog;
    console.warn = oldConsoleWarn;
    console.error = oldConsoleError;
    global.fetch = oldFetch;
    if (oldApiUrl === undefined) delete process.env.BATTLEBOARD_API_URL;
    else process.env.BATTLEBOARD_API_URL = oldApiUrl;
    if (oldApiKey === undefined) delete process.env.BOT_API_KEY;
    else process.env.BOT_API_KEY = oldApiKey;
  }
});

test('only reports a tracked-entity sync when the snapshot content changes', () => {
  const items = buildTrackedItems({ guilds: ['PLAC'], players: [] });
  const state = {
    snapshotInitialized: true,
    snapshotFingerprint: snapshotFingerprint(items),
  };
  assert.equal(hasTrackedSnapshotChanged(state, items), false);
  assert.equal(hasTrackedSnapshotChanged(state, buildTrackedItems({ guilds: ['Psz'], players: [] })), true);
  assert.equal(hasTrackedSnapshotChanged({ snapshotInitialized: false }, items), true);
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



test('coalesces a burst of saves and writes only the latest snapshot', async () => {
  const writes = [];
  const scheduler = createTrackingBackupScheduler({
    debounceMs: 10,
    minIntervalMs: 0,
    write: async snapshot => { writes.push(JSON.parse(snapshot)); },
  });
  try {
    scheduler.enqueue(JSON.stringify({ value: 1, updatedAt: 'first' }));
    scheduler.enqueue(JSON.stringify({ value: 2, updatedAt: 'second' }));
    scheduler.enqueue(JSON.stringify({ value: 3, updatedAt: 'latest' }));
    await wait(40);
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0], { value: 3, updatedAt: 'latest' });
  } finally {
    scheduler.stop();
  }
});

test('enforces a minimum write interval and keeps only the newest pending snapshot', async () => {
  const writes = [];
  const scheduler = createTrackingBackupScheduler({
    debounceMs: 5,
    minIntervalMs: 80,
    write: async snapshot => { writes.push({ value: JSON.parse(snapshot).value, at: Date.now() }); },
  });
  try {
    scheduler.enqueue(JSON.stringify({ value: 1 }));
    await wait(25);
    assert.equal(writes.length, 1);
    scheduler.enqueue(JSON.stringify({ value: 2 }));
    scheduler.enqueue(JSON.stringify({ value: 3 }));
    await wait(25);
    assert.equal(writes.length, 1, 'the second write must respect the minimum interval');
    await wait(75);
    assert.equal(writes.length, 2);
    assert.equal(writes[1].value, 3, 'intermediate state should be coalesced');
    assert.ok(writes[1].at - writes[0].at >= 45);
  } finally {
    scheduler.stop();
  }
});

test('ignores updatedAt-only changes and unchanged snapshots', async () => {
  const writes = [];
  const scheduler = createTrackingBackupScheduler({
    debounceMs: 5,
    minIntervalMs: 0,
    write: async snapshot => { writes.push(JSON.parse(snapshot)); },
  });
  try {
    scheduler.markSaved(JSON.stringify({ value: 1, updatedAt: 'loaded-from-remote' }));
    assert.equal(
      fingerprintTrackingSnapshot({ value: 1, updatedAt: 'different-write-time' }),
      fingerprintTrackingSnapshot({ value: 1, updatedAt: 'loaded-from-remote' })
    );
    scheduler.enqueue(JSON.stringify({ value: 1, updatedAt: 'new-local-save' }));
    await wait(20);
    assert.equal(writes.length, 0, 'updatedAt by itself must not trigger a remote write');

    scheduler.enqueue(JSON.stringify({ value: 2, updatedAt: 'changed-data' }));
    await wait(20);
    assert.equal(writes.length, 1);
    scheduler.enqueue(JSON.stringify({ value: 2, updatedAt: 'later-write-time' }));
    await wait(20);
    assert.equal(writes.length, 1, 'an unchanged successful snapshot must not be written again');
  } finally {
    scheduler.stop();
  }
});

test('retries a failed backup and preserves the newest pending snapshot', async () => {
  const writes = [];
  const errors = [];
  let attempts = 0;
  const scheduler = createTrackingBackupScheduler({
    debounceMs: 1,
    minIntervalMs: 0,
    retryBaseMs: 10,
    retryMaxMs: 20,
    write: async snapshot => {
      attempts++;
      writes.push(JSON.parse(snapshot).value);
      if (attempts === 1) throw new Error('temporary network failure');
    },
    onError: (error, failureCount) => errors.push({ message: error.message, failureCount }),
  });
  try {
    scheduler.enqueue(JSON.stringify({ value: 'latest-state' }));
    await wait(60);
    assert.equal(attempts, 2);
    assert.deepEqual(writes, ['latest-state', 'latest-state']);
    assert.deepEqual(errors, [{ message: 'temporary network failure', failureCount: 1 }]);
    assert.equal(scheduler.getStatus().failureCount, 0);
  } finally {
    scheduler.stop();
  }
});

test('a newer snapshot arriving during a write supersedes older pending work', async () => {
  const writes = [];
  let releaseFirst;
  let firstStarted;
  const started = new Promise(resolve => { firstStarted = resolve; });
  const scheduler = createTrackingBackupScheduler({
    debounceMs: 1,
    minIntervalMs: 0,
    write: async snapshot => {
      const value = JSON.parse(snapshot).value;
      writes.push(value);
      if (value === 1) {
        firstStarted();
        await new Promise(resolve => { releaseFirst = resolve; });
      }
    },
  });
  try {
    scheduler.enqueue(JSON.stringify({ value: 1 }));
    await started;
    scheduler.enqueue(JSON.stringify({ value: 2 }));
    scheduler.enqueue(JSON.stringify({ value: 3 }));
    releaseFirst();
    await wait(40);
    assert.deepEqual(writes, [1, 3]);
  } finally {
    scheduler.stop();
  }
});



test('throttles repeated successful backup logs and reports an aggregate count', () => {
  let now = 1000;
  const messages = [];
  const reportSuccess = createThrottledSuccessLogger('GitHub', {
    intervalMs: 60000,
    now: () => now,
    log: message => messages.push(message),
  });

  reportSuccess();
  reportSuccess();
  reportSuccess();
  assert.equal(messages.length, 1);
  assert.match(messages[0], /GitHub.*รวม 1 ครั้ง/);

  now += 60000;
  reportSuccess();
  assert.equal(messages.length, 2);
  assert.match(messages[1], /GitHub.*รวม 3 ครั้ง/);
});

test('continuous save activity does not postpone the first scheduled backup', async () => {
  const writes = [];
  const scheduler = createTrackingBackupScheduler({
    debounceMs: 25,
    minIntervalMs: 0,
    write: async snapshot => { writes.push(JSON.parse(snapshot).value); },
  });
  try {
    for (let value = 1; value <= 4; value++) {
      scheduler.enqueue(JSON.stringify({ value }));
      await wait(4);
    }
    await wait(15);
    assert.deepEqual(writes, [4], 'the first timer should flush the newest snapshot without waiting for a quiet period');
  } finally {
    scheduler.stop();
  }
});

test('frequent updates do not postpone a scheduled retry after a failed backup', async () => {
  let attempts = 0;
  const writes = [];
  const scheduler = createTrackingBackupScheduler({
    debounceMs: 1,
    minIntervalMs: 0,
    retryBaseMs: 30,
    retryMaxMs: 30,
    write: async snapshot => {
      attempts++;
      writes.push(JSON.parse(snapshot).value);
      if (attempts === 1) throw new Error('offline');
    },
  });
  try {
    scheduler.enqueue(JSON.stringify({ value: 'initial' }));
    await wait(8);
    for (let value = 1; value <= 5; value++) {
      scheduler.enqueue(JSON.stringify({ value }));
      await wait(4);
    }
    await wait(22);
    assert.equal(attempts, 2, 'the retry timer should not be reset by each subsequent save');
    assert.deepEqual(writes, ['initial', 5]);
  } finally {
    scheduler.stop();
  }
});
