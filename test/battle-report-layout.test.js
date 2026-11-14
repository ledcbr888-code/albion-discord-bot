'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { selectAutoBattleGuildSummaryRows, normalizeGuildLabel, WEAPON_CARD_TEXT_LAYOUT } =
  require('../battle-report-layout.js');

const source = readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const integration = readFileSync(path.join(__dirname, '..', 'battleboard-integration.js'), 'utf8');

// Based on the official Battleboard API for the user-supplied Battle #529273528.
// These are only fixture values: tests don't modify or fetch live battle data.
const guilds = [
  { name:'Psz', killFame:1629000, kills:3, deaths:11 },
  { name:'Sine Ira', killFame:2403354, kills:7, deaths:1 },
  { name:'Another', killFame:2593192, kills:6, deaths:5 },
  { name:'PSC', killFame:1988320, kills:3, deaths:8 },
  { name:'HIGHWAY TO HELL', killFame:0, kills:0, deaths:0 },
  { name:'V A G A B O N D', killFame:2553178, kills:7, deaths:0 },
];

test('Psz below Top 4 is included as row 5 without replacing or reordering Top 4', () => {
  const rows = selectAutoBattleGuildSummaryRows(guilds, ['Psz']);
  assert.deepEqual(rows.map(g => g.name), [
    'Another', 'V A G A B O N D', 'Sine Ira', 'PSC', 'Psz',
  ]);
  assert.equal(rows.length, 5);
  assert.equal(rows.at(-1).killFame, 1629000);
  assert.deepEqual(guilds.map(g => g.name).slice(0, 2), ['Psz', 'Sine Ira'],
    'selection must not mutate source battle data');
});

test('Tracked Guild already in Top 4 stays within exactly 4 image rows', () => {
  const rows = selectAutoBattleGuildSummaryRows(guilds, ['  ANOTHER  ']);
  assert.deepEqual(rows.map(g => g.name), ['Another', 'V A G A B O N D', 'Sine Ira', 'PSC']);
  assert.equal(rows.length, 4);
});

test('Absent tracked Guild is never fabricated, and an unrelated tracked player does not create Guild', () => {
  const rows = selectAutoBattleGuildSummaryRows(guilds, ['Not A Battle Guild']);
  assert.equal(rows.length, 4);
  assert.ok(!rows.some(g => g.name === 'Not A Battle Guild'));
});

test('Several verified tracked Guilds outside Top 4 are included once each', () => {
  const rows = selectAutoBattleGuildSummaryRows(guilds, [' Psz ', 'psz', 'HIGHWAY TO HELL']);
  assert.equal(rows.length, 6);
  assert.deepEqual(rows.slice(4).map(g => g.name), ['Psz', 'HIGHWAY TO HELL']);
  assert.equal(normalizeGuildLabel('  pSZ  '), 'psz');
});

test('Auto-Battle renders all the selected rows; manual reports retain the default Top 4 cap', () => {
  assert.match(source, /selectAutoBattleGuildSummaryRows\(/);
  assert.match(source, /generateGuildSummaryImage\(guildsData, \{ includeAlliance: true, includeAll: options\.autoBattle === true \}\)/);
  assert.match(integration, /reportGuilds: routes\.map\(route => String\(/);
  assert.match(integration, /trackedPlayers: players, trackedGuilds: guilds/);
  assert.match(source, /if \(options\.autoBattle\) \{/);
});

test('weapon card name, Guild and K\/D occupy distinct nonoverlapping vertical bands', () => {
  const a = WEAPON_CARD_TEXT_LAYOUT;
  const nameTop = a.nameBaseline - a.nameFontSize;
  const guildTop = a.guildBaseline - a.guildFontSize;
  const kdTop = a.kdBaseline - a.kdFontSize;
  assert.ok(nameTop >= a.weaponBottom + 5, 'name must clear bottom of weapon circle');
  assert.ok(guildTop >= a.nameBaseline + 7, 'Guild must not collide with name');
  assert.ok(kdTop >= a.guildBaseline + 7, 'K/D must not collide with Guild');
  assert.ok(a.famePillTop >= a.kdBaseline + 9, 'K/D must clear Fame pill');
  assert.match(source, /centerText\(guildLabel, cx, y \+ layout\.guildBaseline/);
  assert.match(source, /const metricY = y \+ layout\.kdBaseline;/);
  assert.match(source, /ctx\.fillText\(name, cx, y \+ layout\.nameBaseline, cardWidth - 28\)/);
  const card = source.slice(source.indexOf('async function generatePlayerWeaponReportImage'),
    source.indexOf('async function generateBattleReportFallbackImage'));
  assert.doesNotMatch(card, /const qText|centerText\(qText|Q\$\{q\}/,
    'No visible Q quality badge remains');
});

test('fallback image also separates player name, Guild, K/D and Fame vertically', () => {
  const fallback = source.slice(source.indexOf('async function generateBattleReportFallbackImage'),
    source.indexOf('function roundedFallback'));
  assert.match(fallback, /ctx\.fillText\(name, cx, y \+ 136, cardWidth - 20\)/);
  assert.match(fallback, /cx, y \+ 156, cardWidth - 20/);
  assert.match(fallback, /cx - 36, y \+ 178/);
  assert.match(fallback, /ctx\.fillText\(formatFame\(p\.fame \|\| 0\), cx, y \+ 201\)/);
});

test('Discord continuation does not include report separator text, while part and ACK logs remain', () => {
  assert.doesNotMatch(integration, /const continuationText/);
  assert.match(integration, /await sendPart\(index \+ 1, \{ files: \[files\[index\]\] \}\)/);
  assert.match(integration, /queueDeliveryAck\(state, serverId, battleId, channelId, partNumber, partsTotal/);
  assert.doesNotMatch(integration, /Fame รวมของผู้ที่ติดตาม:|Fame ตามเงื่อนไขแต่ละ Guild:/);
  assert.match(integration, /formatDiscordBattleDelay\(event, detail, new Date\(\)\)/);
});
