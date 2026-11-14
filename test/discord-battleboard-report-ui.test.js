'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { __test } = require('../battleboard-integration');

const { formatBattleboardLink, formatDiscordBattleDelay } = __test;
const indexSource = readFileSync(join(__dirname, '..', 'index.js'), 'utf8');

test('masked Discord Battle Link displays only the numeric ID while linking to our real Battle detail route', () => {
  assert.equal(
    formatBattleboardLink('529270332'),
    '[529270332](https://albion-battleboard-clone-1.vercel.app/b/529270332)',
  );
  assert.equal(formatBattleboardLink('1'), '[1](https://albion-battleboard-clone-1.vercel.app/b/1)');
});

test('bottom delay is calculated from verified Battle end to the Discord send timestamp', () => {
  const event = { battle_start_time: '2026-11-14T12:00:00.000Z' };
  const detail = { endTime: '2026-11-14T12:05:00.000Z' };
  const at = new Date('2026-11-14T12:13:34.000Z');
  assert.equal(formatDiscordBattleDelay(event, detail, at),
    '⏱️ Delay (Battle จบ → ส่งรายงาน): 8 นาที 34 วินาที');
});

test('invalid, missing, or future Battle end never invents a delay', () => {
  const event = { battle_start_time: '2026-11-14T12:00:00.000Z' };
  const sentAt = new Date('2026-11-14T12:13:00.000Z');
  for (const endTime of [undefined, 'not-a-time', '2026-11-14T12:14:00.000Z']) {
    assert.match(formatDiscordBattleDelay(event, { endTime }, sentAt),
      /ไม่มีข้อมูลเวลาจบ Battle ที่ใช้คำนวณได้/);
  }
});

test('Auto-Battle omits the DMG/HEAL performance bar PNG only; weapon pages and Guild table remain', () => {
  assert.match(indexSource, /if \(performancePlayers\.length && !options\.autoBattle\) \{/);
  const performance = indexSource.indexOf('if (performancePlayers.length && !options.autoBattle)');
  const renderTop = indexSource.indexOf('generateTopPerformanceImage(top)', performance);
  const appendTop = indexSource.indexOf('attachments.push(topImage)', renderTop);
  const appendGuild = indexSource.indexOf('attachments.push(guildSummaryAttachment)', appendTop);
  assert.ok(renderTop > performance);
  assert.ok(appendTop > renderTop);
  assert.ok(appendGuild > appendTop);
  assert.match(indexSource, /attachments\.push\(playerReport\)/);
  assert.match(indexSource, /attachments\.push\(guildSummaryAttachment\)/);
  assert.match(indexSource, /options\.autoBattle[\s\S]{0,150}https:\/\/albion-battleboard-clone-1\.vercel\.app\/b\//);
});

test('non-Auto-Battle reports retain their original performance image and link behavior', () => {
  assert.ok(indexSource.includes('https://east.albionbb.com/battles/'));
  assert.match(indexSource, /const topImage = await generateTopPerformanceImage\(top\)/);
});
