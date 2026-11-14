'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');

const source=readFileSync(join(__dirname,'..','index.js'),'utf8');
const start=source.indexOf('function weaponIconCacheKey(');
const end=source.indexOf('const weaponIconCache = new Map();',start);
assert.ok(start>=0 && end>start);
const key=runInNewContext(source.slice(start,end)+'; weaponIconCacheKey', {
  normalizeAlbionItemId: value=>String(value||'').trim()
});

test('weapon icon cache distinguishes the same weapon across enchant levels and qualities',()=>{
  const third=key('T5_2H_GLAIVE_CRYSTAL@3',4);
  const fourth=key('T5_2H_GLAIVE_CRYSTAL@4',4);
  const flat=key('T5_2H_GLAIVE_CRYSTAL',4);
  assert.notEqual(third,fourth);
  assert.notEqual(third,flat);
  assert.notEqual(fourth,flat);
  assert.equal(third,'T5_2H_GLAIVE_CRYSTAL@3|Q4');
  assert.equal(fourth,'T5_2H_GLAIVE_CRYSTAL@4|Q4');
  assert.notEqual(key('T4_MAIN_HOLYSTAFF_AVALON@4',1),key('T4_MAIN_HOLYSTAFF_AVALON@4',4));
});

test('Discord report always requests exact enchantment image and does not silently draw flat item',()=>{
  const start=source.indexOf('async function loadAlbionWeaponIcon(');
  const end=source.indexOf('async function loadFameIcon(',start);
  assert.ok(start>=0&&end>start);
  const code=source.slice(start,end);
  assert.match(code,/const cacheKey = weaponIconCacheKey\(id, q\)/);
  assert.match(code,/const encoded = encodeURIComponent\(id\)/);
  assert.doesNotMatch(code,/encodedBase|baseId\|Q|\${encodedBase}/);
  assert.match(code,/const urls = \[/);
  assert.match(code,/weaponIconCache\.set\(cacheKey, img\)/);
});
