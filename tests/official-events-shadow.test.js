'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createOfficialEventsShadow,extractBattleIds,guildIdsFromConfigs}=require('../official-events-shadow');
const gid='abcdefghABCDEFGH1234';
function withFlag(fn){
  const old=process.env.OFFICIAL_EVENTS_SHADOW_ENABLED;
  process.env.OFFICIAL_EVENTS_SHADOW_ENABLED='true';
  return Promise.resolve().then(fn).finally(()=>{
    if(old===undefined) delete process.env.OFFICIAL_EVENTS_SHADOW_ENABLED;
    else process.env.OFFICIAL_EVENTS_SHADOW_ENABLED=old;
  });
}
function fixture(fetchImpl,log,now=()=>Date.parse('2026-11-14T00:00:00.000Z')){
 return createOfficialEventsShadow({
   getGuildConfigs:()=>[{guildId:'1165745441120452638',config:{autoBattles:[{targetGuildId:gid}]}}],
   fetchImpl,now,logger:log,
 });
}
function logger(){const lines=[];return {lines,log:s=>lines.push(s),warn:s=>lines.push(s)};}
const response=(items,status=200,headers={})=>({
 ok:status>=200&&status<300,status,
 headers:{get:key=>headers[key]??null},
 json:async()=>items
});
test('strictly collect numeric Battle IDs and valid tracked Guild IDs',()=>{
 assert.deepEqual(extractBattleIds([{BattleId:42},{battleId:'42'},{BattleId:'abc'},{BattleId:0}]),['42']);
 assert.deepEqual(guildIdsFromConfigs([{config:{autoBattles:[{targetGuildId:gid},{targetGuildId:'PLAC'}]}}]),[gid]);
});
test('official shadow is gated OFF by default and makes no requests',async()=>{
 const old=process.env.OFFICIAL_EVENTS_SHADOW_ENABLED;delete process.env.OFFICIAL_EVENTS_SHADOW_ENABLED;
 try{
  let calls=0;const bot=fixture(async()=>{calls++;return response([])},logger());
  assert.equal(bot.start(),false);
  await bot.tick();assert.equal(calls,0);
 }finally{if(old!==undefined)process.env.OFFICIAL_EVENTS_SHADOW_ENABLED=old;}
});
test('first response is baseline; next new ID records source/time; no delivery or state mutation',()=>withFlag(async()=>{
 const calls=[],log=logger(),time={now:100000};
 const bot=fixture(async(url,options)=>{
   calls.push({url,options});
   return response(calls.length===1?[{BattleId:101}]:[{BattleId:101},{BattleId:102}]);
 },log,()=>time.now);
 assert.equal(bot.start(),true);
 await bot.tick();
 assert.equal(calls.length,1);
 assert.ok(calls[0].url.includes('gameinfo-sgp.albiononline.com/api/gameinfo/events?'));
 assert.ok(calls[0].url.includes('guildId='+gid));
 assert.equal(log.lines.filter(x=>x.includes('first_observed')).length,0);
 time.now+=61000;
 await bot.tick();
 assert.equal(calls.length,2);
 assert.equal(log.lines.filter(x=>x.includes('first_observed')).length,1);
 assert.ok(log.lines.some(x=>x.includes('battleId=102')&&x.includes('source=official_events_shadow')));
 assert.equal(bot.stats().known,2);
 bot.stop();
}));
test('429 response sets cooldown instead of spamming API',()=>withFlag(async()=>{
 let n=0,time=100000;const log=logger();
 const bot=fixture(async()=>{n++;return response([],429,{'retry-after':'120'})},log,()=>time);
 assert.equal(bot.start(),true);
 await bot.tick();assert.equal(n,1);
 time+=61000;await bot.tick();assert.equal(n,1);
 time+=61000;await bot.tick();assert.equal(n,2);
 bot.stop();
}));
test('invalid JSON shape does not produce discovery claims',()=>withFlag(async()=>{
 const log=logger(),bot=fixture(async()=>response({BattleId:33}),log);
 bot.start();await bot.tick();
 assert.equal(bot.stats().known,0);
 assert.ok(log.lines.some(x=>x.includes('Invalid events payload')));
 bot.stop();
}));
