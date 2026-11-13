'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createOfficialEventsShadow}=require('../official-events-shadow');
const guildId='abcdefghABCDEFGH1234';
const logs=[];
function makeShadow({fetchEvents,onFirstObserved,clock}){
 return createOfficialEventsShadow({
  getGuildConfigs:()=>[{config:{autoBattles:[{targetGuildId:guildId}]}}],
  fetchImpl:async()=>({ok:true,json:async()=>fetchEvents()}),
  logger:{log:line=>logs.push(line),warn:line=>logs.push(line)},
  now:()=>clock.time,
  onFirstObserved,
 });
}
async function withShadowFlag(fn){
 const old=process.env.OFFICIAL_EVENTS_SHADOW_ENABLED;
 process.env.OFFICIAL_EVENTS_SHADOW_ENABLED='true';
 try{await fn();}
 finally{
  if(old===undefined)delete process.env.OFFICIAL_EVENTS_SHADOW_ENABLED;
  else process.env.OFFICIAL_EVENTS_SHADOW_ENABLED=old;
 }
}
test('45 new Battle IDs flush as 20+20+5 without duplicate or delivery',()=>withShadowFlag(async()=>{
 const clock={time:100000},calls=[],send=[];
 let poll=0;
 const ids=Array.from({length:45},(_,i)=>({BattleId:1000+i}));
 const bot=makeShadow({clock,fetchEvents:()=>++poll===1?[]:ids,onFirstObserved:async items=>{
  assert.ok(items.length<=20);
  calls.push(items.map(x=>x.battleId));
  send.push(...items);
 }});
 try{
  bot.start();await bot.tick();
  clock.time+=61000;await bot.tick();
  assert.deepEqual(calls.map(x=>x.length),[20,20,5]);
  assert.equal(new Set(send.map(x=>x.battleId)).size,45);
  assert.ok(send.every(x=>x.source==='official_events_shadow'&&x.guildId===guildId));
  assert.equal(bot.stats().pendingObservations,0);
  clock.time+=61000;await bot.tick();
  assert.equal(calls.length,3);
 }finally{bot.stop();}
}));
test('HTTP 400 retains batch and retries the SAME observedAt on subsequent quiet poll',()=>withShadowFlag(async()=>{
 const clock={time:100000},calls=[];let poll=0;
 const bot=makeShadow({clock,
  fetchEvents:()=>++poll===1?[]:[{BattleId:777}],
  onFirstObserved:async rows=>{
   calls.push(rows.map(x=>({...x})));
   if(calls.length===1)throw Object.assign(new Error('HTTP 400'),{status:400});
  },
 });
 try{
  bot.start();await bot.tick();
  clock.time+=61000;await bot.tick();
  assert.equal(bot.stats().pendingObservations,1);
  const firstAt=calls[0][0].observedAt;
  clock.time+=61000;await bot.tick();
  assert.equal(bot.stats().pendingObservations,0);
  assert.equal(calls.length,2);
  assert.equal(calls[1][0].observedAt,firstAt);
 }finally{bot.stop();}
}));
test('HTTP 429 honors Retry-After and network timeout retries without rediscovery',()=>withShadowFlag(async()=>{
 const clock={time:100000},calls=[];let poll=0;
 const bot=makeShadow({clock,
  fetchEvents:()=>++poll===1?[]:[{BattleId:778}],
  onFirstObserved:async rows=>{
   calls.push(rows[0].observedAt);
   if(calls.length===1)throw Object.assign(new Error('429'),{status:429,retryAfterMs:120000});
   if(calls.length===2)throw new Error('AbortError');
  },
 });
 try{
  bot.start();await bot.tick();
  clock.time+=61000;await bot.tick();
  assert.equal(calls.length,1);
  const first=calls[0];
  clock.time+=61000;await bot.tick();
  assert.equal(calls.length,1,'Retry-After must hold the unsent batch');
  clock.time+=61000;await bot.tick();
  assert.equal(calls.length,2,'once Retry-After expires, attempt once');
  assert.equal(bot.stats().pendingObservations,1,'network error must not acknowledge');
  clock.time+=61000;await bot.tick();
  assert.equal(calls.length,3);
  assert.ok(calls.every(value=>value===first),'do not rewrite First Seen timestamp on retry');
  assert.equal(bot.stats().pendingObservations,0);
 }finally{bot.stop();}
}));
