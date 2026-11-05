'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  __test: { normalizeName, validDiscordServerId, buildTrackedItems, getBattleGuilds, targetGuildMatches, deliveryKey },
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
