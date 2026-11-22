'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { rotateScannerOrder, createAlbionZvZCapacityQueue } = require('../albionzvz-capacity-queue');

test('rotate three Discord servers and tracked Guilds deterministically without mutation',()=>{
    const ids=['A','B','C'];
    assert.deepEqual(rotateScannerOrder(ids,0),ids);
    assert.deepEqual(rotateScannerOrder(ids,1),['B','C','A']);
    assert.deepEqual(rotateScannerOrder(ids,2),['C','A','B']);
    assert.deepEqual(rotateScannerOrder(ids,3),ids);
    assert.deepEqual(rotateScannerOrder([],4),[]);
    assert.deepEqual(ids,['A','B','C']);
});
test('capacity-only wait is bounded to two minutes, with a scheduled retry',()=>{
    let clock=1000;
    const queue=createAlbionZvZCapacityQueue({now:()=>clock});
    assert.equal(queue.isReady('A:G:1'),true);
    assert.deepEqual(queue.onExhausted('A:G:1'),
        {defer:true,remainingMs:120000,nextAttemptAt:46000});
    assert.equal(queue.isReady('A:G:1'),false);
    clock+=45000;
    assert.equal(queue.isReady('A:G:1'),true);
    assert.equal(queue.onExhausted('A:G:1').remainingMs,75000);
    clock+=75000;
    assert.deepEqual(queue.onExhausted('A:G:1'),{defer:false,expired:true,waitedMs:120000});
    assert.equal(queue.isReady('A:G:1'),true);
});
test('scopes are independent, success clearing prevents stale capacity waits',()=>{
    let now=10;
    const queue=createAlbionZvZCapacityQueue({now:()=>now});
    queue.onExhausted('server1:guildA:123');
    assert.equal(queue.isReady('server1:guildA:123'),false);
    assert.equal(queue.isReady('server2:guildA:123'),true);
    assert.equal(queue.isReady('server1:guildB:123'),true);
    assert.equal(queue.isReady('server1:guildA:124'),true);
    queue.clear('server1:guildA:123');
    assert.equal(queue.isReady('server1:guildA:123'),true);
    now+=60000;
    assert.equal(queue.onExhausted('server1:guildA:123').remainingMs,120000);
});
test('capacity tracking has bounded memory',()=>{
    const queue=createAlbionZvZCapacityQueue({now:()=>100,maxEntries:2});
    queue.onExhausted('a');queue.onExhausted('b');queue.onExhausted('c');
    assert.equal(queue.isReady('a'),true);
    assert.equal(queue.isReady('b'),false);
    assert.equal(queue.isReady('c'),false);
});
test('real source decision delays budget exhaustion but retains immediate error fallback',async()=>{
    const index=fs.readFileSync(path.join(__dirname,'..','index.js'),'utf8');
    const code=index.slice(index.indexOf('async function fetchAutoBattlePreferredDetail('),
        index.indexOf('// Global safety net'));
    let at=10_000,reason='DETAIL_REQUEST_BUDGET',officialCalls=0,primaryCalls=0;
    const queue=createAlbionZvZCapacityQueue({now:()=>at});
    const context={
        primaryCapacityQueue:queue,
        zvzSource:{getDetail:async(_id,_guild,_guildId,diagnostic)=>{
            primaryCalls++;diagnostic.reason=reason;return null;}},
        fetchOfficialBattle:async()=>{officialCalls++;return {players:[]};},
        getDetailPlayerCountForSourceLog:()=>0,
        console:{log:()=>{},warn:()=>{}}
    };
    const selector=vm.runInNewContext(code+'\nfetchAutoBattlePreferredDetail',context);
    const call=async()=>{
        const capacityDecision={};
        const detail=await selector('531535615',{
            targetGuild:'xCUTIESx',targetGuildId:'some-id',
            primaryBudgetKey:'server:guild:531535615',capacityDecision
        });
        return {detail,capacityDecision};
    };
    assert.equal((await call()).capacityDecision.deferred,true);
    assert.equal(officialCalls,0);
    at+=60000;
    assert.equal((await call()).capacityDecision.deferred,true);
    assert.equal(officialCalls,0);
    at+=60000;
    assert.ok((await call()).detail);
    assert.equal(officialCalls,1);
    reason='CIRCUIT_DENIED';
    assert.ok((await call()).detail);
    assert.equal(officialCalls,2,'403 and other real failures use Official immediately');
    assert.equal(primaryCalls,4);
});
test('source keeps 3 per minute, scanner keeps 60s cadence and deferrals never mark handled',()=>{
    const root=path.join(__dirname,'..');
    const index=fs.readFileSync(path.join(root,'index.js'),'utf8');
    const source=fs.readFileSync(path.join(root,'albionzvz-source.js'),'utf8');
    assert.match(source,/if\(detailCount>=3\)/);
    assert.match(source,/MIN_REQUEST_GAP_MS=3500/);
    assert.match(source,/if\(status===401\|\|status===403\)/);
    assert.match(index,/getAutoBattleIntervalMs\(\)[\s\S]*?return 60 \* 1000/);
    assert.match(index,/rotateScannerOrder\(serverConfigs, round\)/);
    assert.match(index,/rotateScannerOrder\(trackers, rotation\)/);
    assert.match(index,/if \(!officialBattle && capacityDecision.deferred\) \{[\s\S]*?continue;/);
    assert.match(index,/primaryCapacityQueue\.isReady\(pendingQueueScopeKey \+ ':' \+ id\)/);
});
