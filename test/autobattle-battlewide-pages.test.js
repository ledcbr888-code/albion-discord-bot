'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { summarizeEntireBattleForGuildPages } = require('../battle-report-layout');

const botSource = readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const integrationSource = readFileSync(path.join(__dirname, '..', 'battleboard-integration.js'), 'utf8');

const fullBattlePlayers = Array.from({ length: 27 }, (_, index) => ({
  displayName: 'Player' + (index + 1),
  guild: index < 16 ? 'PLAC' : index < 23 ? 'Psz' : 'Other Guild',
  kills: index === 20 ? 7 : index === 2 ? 3 : 0,
  deaths: index % 3 === 0 ? 1 : 0,
  fame: index === 25 ? 1250000 : index === 5 ? 850000 : 12000
}));

test('Tracked-Guild report uses ONE whole-Battle summary for every 10-player page', () => {
  // 27 Battle participants but only 23 tracked-Guild players in four image pages:
  // data for Other Guild must still be represented in the battle-wide header.
  const all = summarizeEntireBattleForGuildPages(fullBattlePlayers);
  assert.equal(all.playerCount, 27);
  assert.equal(all.totalKills, 10);
  assert.equal(all.totalDeaths, 9);
  assert.equal(all.totalFame, 27 * 12000 - 2 * 12000 + 1250000 + 850000);
  assert.deepEqual(all.topKiller, { name: 'Player21', kills: 7 });
  assert.deepEqual(all.mvp, { name: 'Player26', fame: 1250000 });
  const tracked = fullBattlePlayers.filter(player => player.guild !== 'Other Guild');
  const pages = [];
  for (let offset=0;offset<tracked.length;offset+=10) {
    pages.push({ rows: tracked.slice(offset,offset+10), sharedBattleStats: all, pageOffset:offset });
  }
  assert.deepEqual(pages.map(page=>page.rows.length), [10,10,3]);
  assert.ok(pages.every(page=>page.sharedBattleStats === all));
  assert.notEqual(pages[0].rows.reduce((v,p)=>v+p.kills,0), all.totalKills);
  assert.equal(pages[2].sharedBattleStats.mvp.name, 'Player26');
});

test('Official summary wins for whole Battle totals, while best players come from full roster', () => {
  const full = summarizeEntireBattleForGuildPages(fullBattlePlayers, {
    totalKills: 15, totalDeaths: 13, totalFame: 3700000, totalPlayers: 31
  });
  assert.equal(full.totalKills, 15);
  assert.equal(full.totalDeaths, 13);
  assert.equal(full.totalFame, 3700000);
  assert.equal(full.playerCount, 31);
  assert.equal(full.topKiller.name, 'Player21');
  assert.equal(full.mvp.name, 'Player26');
});

test('Missing official totals and nonnumeric summary fields do not turn into fake values', () => {
  const v = summarizeEntireBattleForGuildPages([
    { displayName: 'One', kills: 2, deaths: 1, fame: 500000 },
    { displayName: 'Two', kills: 1, deaths: 0, fame: 100000 }
  ], { totalKills:'unknown', totalFame:null, totalPlayers:'', totalDeaths:-3 });
  assert.equal(v.totalKills,3);
  assert.equal(v.totalDeaths,1);
  assert.equal(v.totalFame,600000);
  assert.equal(v.playerCount,2);
});

test('Only tracked-Guild Auto-Battle passes battle-wide stats, not player-only/manual pages', () => {
  assert.match(botSource, /options\.autoBattle === true && hasTrackedGuilds\s*\? summarizeEntireBattleForGuildPages\(allSortedRows, apiData\)\s*: null/);
  assert.match(botSource, /for \(let offset = 0; offset < reportRosterRows\.length; offset \+= playersPerReportPage\)/);
  assert.match(botSource, /const pageInfo = \{[\s\S]{0,290}\.\.\.\(sharedBattleStats \? \{/);
  assert.match(botSource, /sharedBattleStats,\s*pageOffset: pageIndex \* playersPerReportPage/);
  assert.match(botSource, /generatePlayerWeaponReportImage\(pageRows, pageInfo\)/);
  assert.match(botSource, /generateBattleReportFallbackImage\(pageRows, pageInfo\)/);
  // The tracked Guild/player threshold and alert totals keep their old scope.
  assert.match(botSource, /const metricRows = rows/);
});

test('All five top summary cards and player-count badge read shared Battle stats, not page stats', () => {
  assert.match(botSource, /if \(battleInfo\.sharedBattleStats\) \{[\s\S]{0,160}totalKills, totalDeaths, totalFame, topKiller, mvp/);
  assert.match(botSource, /battleInfo\.sharedBattleStats\?\.playerCount \?\? sortedPlayers\.length/);
  assert.match(botSource, /const isMVP = battleInfo\.sharedBattleStats/);
  assert.match(botSource, /const cardRank = battleInfo\.sharedBattleStats \?/);
  assert.match(botSource, /const sharedStats = battleInfo\.sharedBattleStats/);
  assert.match(botSource, /String\(sharedStats\?\.playerCount \?\? players\.length\)/);
});

test('Discord Auto-Battle removes duplicate ID text but keeps working masked Battle Link', () => {
  const begin = integrationSource.indexOf('const alertText =');
  const end = integrationSource.indexOf('const sendPart =', begin);
  const text = integrationSource.slice(begin,end);
  assert.ok(begin>0 && end>begin);
  assert.doesNotMatch(text,/🆔 Battle ID/);
  assert.match(text,/🔗 Battle Link: ' \+ formatBattleboardLink\(battleId\)/);
  assert.match(text,/⚔️ Kills:/);
  assert.match(text,/☠️ Deaths:/);
  assert.match(text,/formatDiscordBattleDelay\(event, detail, new Date\(\)\)/);
  // Retain internal IDs for ACK, deduplication, resume, logs and audit.
  assert.match(integrationSource,/deliveryNonce\(battleId, channelId, partNumber\)/);
});
