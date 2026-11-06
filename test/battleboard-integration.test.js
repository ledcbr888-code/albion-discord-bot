'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  __test: { normalizeName, validDiscordServerId, buildTrackedItems, getBattleGuilds, targetGuildMatches, deliveryKey, toTimestampMs, formatElapsedMs, getAttachmentName, getAttachmentSizeBytes, formatAttachmentSize, classifyLatency, createEmptyLatencySummary, formatThaiDateTime, flushLatencySummary },
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

test('creates stable idempotency keys per battle and channel', () => {
  assert.equal(deliveryKey('526764798', '12345678901234567'), '526764798:12345678901234567');
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


test('parses battle and Discord timestamps in ISO, Unix seconds, and milliseconds', () => {
  const { toTimestampMs } = require('../battleboard-integration').__test;
  assert.equal(toTimestampMs('2026-11-06T00:00:00.000Z'), Date.parse('2026-11-06T00:00:00.000Z'));
  assert.equal(toTimestampMs(1793923200), 1793923200000);
  assert.equal(toTimestampMs(1793923200000), 1793923200000);
  assert.equal(toTimestampMs('not-a-date'), null);
});

test('formats delivery delays as readable Thai durations', () => {
  const { formatElapsedMs } = require('../battleboard-integration').__test;
  assert.equal(formatElapsedMs(252000), '4 นาที 12 วินาที');
  assert.equal(formatElapsedMs(3723000), '1 ชม. 2 นาที 3 วินาที');
  assert.equal(formatElapsedMs(null), 'ไม่ทราบ');
});

test('uses the actual attachment name in delivery timing logs', () => {
  const { getAttachmentName } = require('../battleboard-integration').__test;
  assert.equal(getAttachmentName({ name: 'guild-summary.png' }, 'fallback.png'), 'guild-summary.png');
  assert.equal(getAttachmentName({}, 'report-image-1'), 'report-image-1');
});


test('formats report attachment sizes when the source is a Buffer or exposes size', () => {
  const { getAttachmentSizeBytes, formatAttachmentSize } = require('../battleboard-integration').__test;
  assert.equal(getAttachmentSizeBytes({ attachment: Buffer.alloc(2048) }), 2048);
  assert.equal(getAttachmentSizeBytes({ size: 1048576 }), 1048576);
  assert.equal(getAttachmentSizeBytes({ attachment: 'local-file-path.png' }), null);
  assert.equal(formatAttachmentSize(1536), '1.5 KB');
  assert.equal(formatAttachmentSize(1572864), '1.50 MB');
  assert.equal(formatAttachmentSize(null), 'ไม่ทราบขนาด');
});

test('classifies Battle-to-Discord latency using the agreed five and ten minute levels', () => {
  const { classifyLatency } = require('../battleboard-integration').__test;
  assert.equal(classifyLatency(4 * 60 * 1000), 'เร็ว');
  assert.equal(classifyLatency(5 * 60 * 1000), 'เริ่มช้า');
  assert.equal(classifyLatency(10 * 60 * 1000), 'ช้าผิดปกติ');
  assert.equal(classifyLatency(null), 'ยังวัดไม่ได้');
});

test('initializes an isolated 30-minute summary window per tracked Discord server', () => {
  const { createEmptyLatencySummary } = require('../battleboard-integration').__test;
  const summary = createEmptyLatencySummary(Date.parse('2026-11-06T00:00:00.000Z'));
  assert.equal(summary.windowStartedAt, '2026-11-06T00:00:00.000Z');
  assert.equal(summary.reportsSent, 0);
  assert.equal(summary.fileUploadAttempts, 0);
  assert.equal(summary.fastestBattleToDiscordMs, null);
  assert.equal(summary.slowestBattleToDiscordMs, null);
});


test('formats report timestamps in Thailand time', () => {
  const { formatThaiDateTime } = require('../battleboard-integration').__test;
  const formatted = formatThaiDateTime('2026-11-06T00:00:00.000Z');
  assert.match(formatted, /06\/11\/2026/);
  assert.match(formatted, /07:00:00/);
  assert.match(formatted, /น\./);
});

test('emits and resets the per-server 30-minute Thai summary window', () => {
  const { flushLatencySummary } = require('../battleboard-integration').__test;
  const state = {
    latencySummary: {
      windowStartedAt: '2026-11-06T00:00:00.000Z',
      reportsSent: 2,
      belowFame: 1,
      detailPending: 3,
      detailRetryAttempts: 1,
      noRoute: 0,
      fileUploadAttempts: 4,
      fileUploadSuccesses: 3,
      fileUploadFailures: 1,
      apiFailures: 0,
      otherPollFailures: 0,
      totalBattleToDiscordMs: 600000,
      battleToDiscordSamples: 2,
      fastestBattleToDiscordMs: 120000,
      slowestBattleToDiscordMs: 480000,
      totalReportGenerationMs: 5000,
      reportGenerationSamples: 2,
      totalDiscordSendMs: 1000,
      discordSendSamples: 3,
    },
  };
  const originalLog = console.log;
  const captured = [];
  console.log = (...args) => captured.push(args.join(' '));
  try {
    assert.equal(flushLatencySummary(state, '1165745441120452638', Date.parse('2026-11-06T00:29:59.000Z')), false);
    assert.equal(flushLatencySummary(state, '1165745441120452638', Date.parse('2026-11-06T00:30:00.000Z')), true);
  } finally {
    console.log = originalLog;
  }
  assert.equal(captured.length, 1);
  assert.match(captured[0], /สรุปทุก 30 นาที/);
  assert.match(captured[0], /รายงานส่งครบ=2/);
  assert.match(captured[0], /ต่ำกว่าเกณฑ์ Fame=1/);
  assert.match(captured[0], /75\.0%/);
  assert.equal(state.latencySummary.reportsSent, 0);
  assert.equal(state.latencySummary.fileUploadAttempts, 0);
});

test('builds a direct BOSS BOT Battleboard detail link for Discord alerts', () => {
  const { buildBattleboardDetailUrl } = require('../battleboard-integration').__test;
  assert.equal(
    buildBattleboardDetailUrl('526855865'),
    'https://albion-battleboard-clone-1.vercel.app/battles/526855865',
  );
  assert.equal(buildBattleboardDetailUrl('invalid'), 'https://albion-battleboard-clone-1.vercel.app/');
});
