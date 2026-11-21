'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createAlbionZvZSource,parseList,parseDetail,formatEndDelay,battleLink}=require('../albionzvz-source');
const {backupTrackingFile,validateTracking}=require('../temporary-source-backup');

const now=Date.parse('2026-11-21T07:00:00Z');
const start=new Date(now-20*60_000).toISOString(),end=new Date(now-8*60_000-24_000).toISOString();
const guildId='ABCDEFGHIJKLMNOPQRSTUV',otherId='QRSTUVWXYZABCDEFGHIJKL',id='531020000';
function fixture(battleId=id){
    const row={id:Number(battleId),startTime:start,endTime:end,guildNames:['Guild One','Guild Two'],
        guildMasses:[{guildId,name:'Guild One',mass:5,kills:1,allianceId:null,allianceName:null},
            {guildId:otherId,name:'Guild Two',mass:5,kills:1,allianceId:null,allianceName:null}],
        totalParticipants:10,mass:10,totalKills:2,totalFame:300000};
    const players=Array.from({length:10},(_,i)=>({name:'Player '+i,
        guildName:i<5?'Guild One':'Guild Two',guildId:i<5?guildId:otherId,
        kills:i===0||i===5?1:0,deaths:i===1||i===6?1:0,killFame:i===0?200000:i===5?100000:0}));
    const battle={id:Number(battleId),startTime:start,endTime:end,totalKills:2,totalFame:300000,players};
    return {row,body:{server:'asia',battle}};
}
function sourceFixture(handler,enabled=true){
    let at=now,calls=[];
    const source=createAlbionZvZSource({env:{ALBIONZVZ_PRIMARY_ENABLED:String(enabled)},now:()=>at,log:()=>{},
        random:()=>0,sleep:async ms=>{at+=ms;},
        http:{get:async(url,options)=>{calls.push({url,options});return handler(url,options);}}});
    return {source,calls,advance:ms=>{at+=ms;}};
}
test('disabled source and original startup baseline make no AlbionZvZ requests',async()=>{
    const {source,calls}=sourceFixture(()=>{throw Error('Unexpected HTTP');},false);
    assert.deepEqual(await source.discover('Guild One','server:guild'),{ids:[],useOfficial:true});
    assert.equal(await source.getDetail(id,'Guild One',guildId),null);
    const on=sourceFixture(()=>{throw Error('Unexpected HTTP');});
    assert.deepEqual(await on.source.discover('Guild One','server:guild',{baselineOnly:true}),{ids:[],useOfficial:true});
    assert.equal(calls.length,0);assert.equal(on.calls.length,0);
});
test('list and detail accept coherent Asia data, reject other regions, incomplete rows and conflicting guild IDs',()=>{
    const {row,body}=fixture();
    assert.equal(parseList({server:'asia',rows:[row]},now)[0].id,id);
    assert.equal(parseList({server:'europe',rows:[row]},now),null);
    assert.equal(parseList({rows:[{...row,guildNames:undefined}]},now),null);
    const parsed=parseDetail(body,id,row,'Guild One',now,guildId);
    assert.equal(parsed.players.length,10);
    assert.equal(parsed.guilds[guildId].killFame,200000);
    assert.equal(parsed.guilds[otherId].kills,1);
    assert.equal(parsed.players[0].guildId,guildId);
    assert.equal(parseDetail(body,id,row,'Guild One',now,otherId),null);
    assert.equal(parseDetail({...body,server:'americas'},id,row,'Guild One',now,guildId),null);
    assert.equal(parseDetail(body,'999',row,'Guild One',now,guildId),null);
    assert.equal(parseDetail({...body,battle:{...body.battle,players:body.battle.players.slice(1)}},id,row,'Guild One',now,guildId),null);
    assert.equal(parseDetail(body,id,{...row,totalFame:1},'Guild One',now,guildId),null);
    assert.equal(parseDetail({...body,battle:{...body.battle,endTime:start}},id,row,'Guild One',now,guildId),null);
});
test('global list shared between trackers, exact guild IDs, fallback on no match, periodic Official reconciliation',async()=>{
    const {row}=fixture();const f=sourceFixture(()=>({data:{server:'asia',rows:[row]}}));
    const opts={guildId,processed:new Set()};
    assert.deepEqual(await f.source.discover('Guild One','first',opts),{ids:[id],useOfficial:true});
    f.source.noteOfficial('first');
    assert.deepEqual(await f.source.discover('Guild One','first',opts),{ids:[id],useOfficial:false});
    assert.deepEqual(await f.source.discover('Guild One','wrong',{guildId:otherId}),{ids:[],useOfficial:true});
    assert.deepEqual(await f.source.discover('Guild One','first',{guildId,processed:new Set([id])}),{ids:[id],useOfficial:true});
    assert.equal(f.calls.length,1);
    assert.equal(f.calls[0].options.params.server,'asia');
    assert.equal(f.calls[0].options.params.limit,25);
    f.advance(300001);
    assert.equal((await f.source.discover('Guild One','first',opts)).useOfficial,true);
});
test('primary detail cache preserves identity; 3 uncached details per minute, missing data returns null',async()=>{
    const ids=[id,'531020001','531020002','531020003'];
    const fixtures=ids.map(fixture);
    const f=sourceFixture((url,options)=>({data:url.endsWith('/api/battles')?{rows:fixtures.map(x=>x.row)}
        :fixtures.find(x=>String(x.row.id)===options.params.battleId).body}));
    await f.source.discover('Guild One','s',{guildId});
    assert.equal(f.source.hasKnownBattle(id),true);
    assert.equal(f.source.hasKnownBattle('999999999'),false);
    const data=await f.source.getDetail(id,'Guild One',guildId);
    assert.ok(f.source.isPrimaryData(data));assert.ok(f.source.isPrimaryData(await f.source.getDetail(id,'Guild One',guildId)));
    assert.equal(f.calls.length,2);
    assert.equal(await f.source.getDetail(id,'Guild One',otherId),null);
    await f.source.getDetail(ids[1],'Guild One',guildId);await f.source.getDetail(ids[2],'Guild One',guildId);
    assert.equal(await f.source.getDetail(ids[3],'Guild One',guildId),null);
    assert.equal(f.calls.length,4);
});
test('403 stops future AlbionZvZ calls for this process; 429 respects Retry-After and falls back',async()=>{
    for(const status of [403,429]){
        const f=sourceFixture(()=>{throw {response:{status,headers:{'retry-after':'900'}}};});
        assert.equal((await f.source.discover('Guild One','s',{guildId})).useOfficial,true);
        f.advance(600000);await f.source.discover('Guild One','s',{guildId});assert.equal(f.calls.length,1);
        f.advance(300001);await f.source.discover('Guild One','s',{guildId});assert.equal(f.calls.length,status===403?1:2);
    }
});
test('invalid third-party detail is rejected, not treated as a valid zero-fame report',async()=>{
    const {row,body}=fixture();
    const f=sourceFixture(url=>({data:url.endsWith('/api/battles')?{rows:[row]}:{...body,battle:{...body.battle,players:[]}}}));
    await f.source.discover('Guild One','s',{guildId});
    assert.equal(await f.source.getDetail(id,'Guild One',guildId),null);
});
test('end-to-send delay uses actual end time, never substitutes start or future time',()=>{
    assert.equal(formatEndDelay({startTime:start,endTime:end},now),'⏱️ Delay (Battle จบ → ส่งรายงาน): 8 นาที 24 วินาที');
    assert.match(formatEndDelay({startTime:start},now),/ไม่มีข้อมูลเวลาจบ/);
    assert.match(formatEndDelay({startTime:end,endTime:start},now),/ไม่มีข้อมูลเวลาจบ/);
    assert.match(formatEndDelay({endTime:now+1000},now),/ไม่มีข้อมูลเวลาจบ/);
    assert.match(battleLink(id),/\?server=asia\)$/);
});
function fakeIO(){
    const files=new Map([['/data/tracking.json',JSON.stringify({version:3,guilds:{one:{processedBattles:['123']}}})]]);
    const io={readFileSync:p=>{if(!files.has(p))throw Error('missing');return files.get(p);},
        mkdirSync:()=>{},lstatSync:()=>({isFile:()=>true}),existsSync:p=>files.has(p),
        writeFileSync:(p,data,opts)=>{assert.equal(opts.mode,0o600);assert.equal(opts.flag,'wx');if(files.has(p))throw Error('exists');files.set(p,data);},
        linkSync:(src,dst)=>{if(files.has(dst))throw Object.assign(Error('exists'),{code:'EEXIST'});files.set(dst,files.get(src));},
        unlinkSync:p=>files.delete(p)};
    const paths={dirname:p=>p.slice(0,p.lastIndexOf('/')),join:(...parts)=>parts.join('/')};
    return {files,io,paths};
}
test('pre-switch backup is private, once-only, never overwrites or modifies live tracking',()=>{
    const f=fakeIO(),opts={io:f.io,paths:f.paths,uuid:()=>'test'};
    const first=backupTrackingFile('/data/tracking.json',opts);
    assert.equal(first.created,true);
    const old=f.files.get(first.path);
    f.files.set('/data/tracking.json',JSON.stringify({version:3,guilds:{one:{processedBattles:['123','456']}}}));
    assert.equal(backupTrackingFile('/data/tracking.json',opts).created,false);
    assert.equal(f.files.get(first.path),old);
    assert.deepEqual(validateTracking(f.files.get('/data/tracking.json')).guilds.one.processedBattles,['123','456']);
    assert.equal([...f.files.keys()].filter(p=>p.endsWith('.tmp')).length,0);
});
test('invalid source or corrupt prior backup fails safely without replacing data',()=>{
    const f=fakeIO(),opts={io:f.io,paths:f.paths,uuid:()=>'test'};
    const first=backupTrackingFile('/data/tracking.json',opts);
    f.files.set(first.path,'broken');
    assert.throws(()=>backupTrackingFile('/data/tracking.json',opts));
    assert.equal(f.files.get(first.path),'broken');
    f.files.set('/data/tracking.json','{"version":2}');
    assert.throws(()=>backupTrackingFile('/data/tracking.json',opts));
    assert.equal(f.files.get('/data/tracking.json'),'{"version":2}');
});

test('backup writes and verifies a real, non-overwriting snapshot on disk',()=>{
    const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bossbot-backup-test-'));
    try {
        const live=path.join(dir,'tracking.json');
        const fixture=JSON.stringify({version:3,guilds:{test:{processedBattles:['123'],battleboardState:{cursor:42,delivered:[{key:'123:456',status:'sent'}]}}}});
        fs.writeFileSync(live,fixture);
        const result=backupTrackingFile(live);
        assert.equal(result.created,true);
        assert.equal(fs.readFileSync(result.path,'utf8'),fixture);
        if(process.platform!=='win32'){
            assert.equal(fs.statSync(result.path).mode&0o777,0o600);
            assert.equal(fs.statSync(path.dirname(result.path)).mode&0o777,0o700);
        }
        const updated=JSON.stringify({version:3,guilds:{test:{processedBattles:['123','999']}}});
        fs.writeFileSync(live,updated);
        assert.equal(backupTrackingFile(live).created,false);
        assert.equal(fs.readFileSync(result.path,'utf8'),fixture);
        assert.equal(fs.readFileSync(live,'utf8'),updated);
        assert.deepEqual(fs.readdirSync(path.dirname(result.path)),['tracking-before-zvz-v1.json']);
        fs.writeFileSync(result.path,'broken');
        assert.throws(()=>backupTrackingFile(live));
        assert.equal(fs.readFileSync(live,'utf8'),updated);
    } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
test('existing hydration and persistence checks finish before optional backup and Discord login',()=>{
    const fs=require('node:fs'),path=require('node:path');
    const source=fs.readFileSync(path.join(__dirname,'..','index.js'),'utf8');
    const startup=source.slice(source.lastIndexOf('initializeTrackingPersistence()'));
    assert.ok(startup.indexOf('await restoreReportedBattleRows();')>=0);
    assert.ok(startup.indexOf('await restoreReportedBattleRows();')<startup.indexOf('backupTrackingFile(DATA_FILE)'));
    assert.ok(startup.indexOf('backupTrackingFile(DATA_FILE)')<startup.indexOf('client.login(BOT_TOKEN)'));
    assert.match(startup,/process\.env\.ALBIONZVZ_PRIMARY_ENABLED = 'false'/);
});

test('live-style battle detail without guild rows reconstructs trustworthy guild stats from list',()=>{
    const {row,body}=fixture();
    assert.equal(Object.hasOwn(body.battle,'guilds'),false);
    assert.equal(Object.hasOwn(body.battle,'alliances'),false);
    const detail=parseDetail(body,id,row,'Guild One',now,guildId);
    assert.equal(Object.keys(detail.guilds).length,2);
    assert.equal(detail.guilds[guildId].deaths,1);
    assert.equal(detail.totalFame,300000);
    assert.equal(parseDetail(body,id,{...row,guildMasses:[]},'Guild One',now,guildId),null);
    assert.equal(parseDetail(body,id,{...row,guildMasses:row.guildMasses.map(x=>({...x,kills:9}))},'Guild One',now,guildId),null);
    assert.equal(parseDetail({...body,battle:{...body.battle,totalFame:999}},id,row,'Guild One',now,guildId),null);
    assert.equal(parseDetail({...body,battle:{...body.battle,players:body.battle.players.map((p,i)=>i===0?{...p,guildId:otherId}:p)}},id,row,'Guild One',now,guildId),null);
});

test('accept source-consistent tiny Fame differences without altering individual players; reject material drift',()=>{
    const {row,body}=fixture();
    const slightRow={...row,totalFame:300008};
    const slightBody={...body,battle:{...body.battle,totalFame:300008}};
    const detail=parseDetail(slightBody,id,slightRow,'Guild One',now,guildId);
    assert.ok(detail);
    assert.equal(detail.totalFame,300008);
    assert.equal(detail.players.reduce((s,p)=>s+p.killFame,0),300000);
    const largeRow={...row,totalFame:302000};
    const largeBody={...body,battle:{...body.battle,totalFame:302000}};
    assert.equal(parseDetail(largeBody,id,largeRow,'Guild One',now,guildId),null);
    assert.equal(parseDetail(body,id,{...row,guildMasses:row.guildMasses.map((g,i)=>i?g:{...g,deaths:50})},'Guild One',now,guildId),null);
});

test('one global request lane spaces list and detail calls; cache avoids duplicate calls',async()=>{
    const {row,body}=fixture();
    const called=[],f=sourceFixture(async(url,options)=>{
        called.push({url,requestAt:fTime()});
        return {data:url.endsWith('/api/battles')?{server:'asia',rows:[row]}:body};
    });
    // sourceFixture time is visible in the deterministic accumulated metrics.
    function fTime(){return Date.now();}
    await f.source.discover('Guild One','scope',{guildId});
    await f.source.getDetail(id,'Guild One',guildId);
    const info=f.source.getRequestMetrics();
    assert.equal(info.requests,2);
    assert.equal(info.listRequests,1);
    assert.equal(info.detailRequests,1);
    assert.equal(info.waitMs,3500);
    assert.equal(info.circuit,'ready');
    await f.source.discover('Guild One','scope',{guildId});
    assert.equal(f.source.getRequestMetrics().listCacheHits,1);
    await f.source.getDetail(id,'Guild One',guildId);
    assert.equal(f.source.getRequestMetrics().detailCacheHits,1);
    assert.equal(f.calls.length,2);
});
test('multiple simultaneous detail requests never overlap in shared request lane',async()=>{
    const {row,body}=fixture();
    const {row:row2,body:body2}=fixture('531020001');
    let concurrent=0,maxConcurrent=0;
    const f=sourceFixture(async(url,opts)=>{
        concurrent++;maxConcurrent=Math.max(maxConcurrent,concurrent);
        await Promise.resolve();
        concurrent--;
        return {data:url.endsWith('/api/battles')?{server:'asia',rows:[row,row2]}:
            (opts.params.battleId===id?body:body2)};
    });
    await f.source.discover('Guild One','scope',{guildId});
    const [a,b]=await Promise.all([f.source.getDetail(id,'Guild One',guildId),
        f.source.getDetail('531020001','Guild One',guildId)]);
    assert.equal(maxConcurrent,1);
    assert.ok(f.source.isPrimaryData(a));
    assert.ok(f.source.isPrimaryData(b));
    assert.equal(f.source.getRequestMetrics().requests,3);
    assert.equal(f.source.getRequestMetrics().waitMs,7000);
});
test('500 outages back off exponentially and use Official path without retry bursts',async()=>{
    const f=sourceFixture(()=>{throw {response:{status:500}};});
    assert.equal((await f.source.discover('Guild One','scope',{guildId})).useOfficial,true);
    assert.equal(f.calls.length,1);
    assert.equal(f.source.getRequestMetrics().circuit,'cooldown');
    f.advance(60000);
    await f.source.discover('Guild One','scope',{guildId});
    assert.equal(f.calls.length,2);
    f.advance(60000);
    await f.source.discover('Guild One','scope',{guildId});
    assert.equal(f.calls.length,2);
    f.advance(60001);
    await f.source.discover('Guild One','scope',{guildId});
    assert.equal(f.calls.length,3);
    assert.equal(f.source.getRequestMetrics().transientErrors,3);
});
test('429 Retry-After has priority over backoff and 403 makes all subsequent HTTP ineligible',async()=>{
    const f=sourceFixture(()=>{throw {response:{status:429,headers:{'retry-after':'1800'}}};});
    await f.source.discover('Guild One','scope',{guildId});
    f.advance(15*60_000);
    await f.source.discover('Guild One','scope',{guildId});
    assert.equal(f.calls.length,1);
    assert.equal(f.source.getRequestMetrics().throttled,1);
    assert.equal(f.source.getRequestMetrics().throttledRatePct,100);
    f.advance(15*60_000+1);
    await f.source.discover('Guild One','scope',{guildId});
    assert.equal(f.calls.length,2);
    const blocked=sourceFixture(()=>{throw {response:{status:403}};});
    await blocked.source.discover('Guild One','scope',{guildId});
    blocked.advance(48*60*60_000);
    await blocked.source.discover('Guild One','scope',{guildId});
    assert.equal(blocked.calls.length,1);
    assert.equal(blocked.source.getRequestMetrics().circuit,'denied');
    assert.equal(blocked.source.getRequestMetrics().forbidden,1);
    assert.equal(blocked.source.getRequestMetrics().forbiddenRatePct,100);
});

test('unexpected HTML challenge on JSON API stops requests rather than emulating a browser',async()=>{
    const f=sourceFixture(()=>({status:200,headers:{'content-type':'text/html; charset=utf-8'},data:'<!DOCTYPE html><html><title>Just a moment</title></html>'}));
    const first=await f.source.discover('Guild One','scope',{guildId});
    assert.deepEqual(first,{ids:[],useOfficial:true});
    assert.equal(f.source.getRequestMetrics().challengePages,1);
    assert.equal(f.source.getRequestMetrics().circuit,'denied');
    f.advance(24*60*60*1000);
    await f.source.discover('Guild One','scope',{guildId});
    assert.equal(f.calls.length,1);
});
test('an HTTP-200 JSON error page is not counted as a successful Asia battle list',async()=>{
    const f=sourceFixture(()=>({status:200,headers:{'content-type':'application/json'},data:{error:'Access blocked'}}));
    assert.equal((await f.source.discover('Guild One','scope',{guildId})).useOfficial,true);
    assert.equal(f.source.getRequestMetrics().transientErrors,1);
    assert.equal(f.source.getRequestMetrics().circuit,'cooldown');
});


function smallFightFixture(count=5,battleId='531162052'){
    const original=fixture(battleId),players=original.body.battle.players.slice(0,count);
    const fame=players.reduce((sum,p)=>sum+p.killFame,0);
    const kills=players.reduce((sum,p)=>sum+p.kills,0);
    const deaths=players.reduce((sum,p)=>sum+p.deaths,0);
    const row={...original.row,id:Number(battleId),
        guildNames:['Guild One'],guildMasses:[{guildId,name:'Guild One',mass:count,kills,deaths,
            allianceId:null,allianceName:null}],
        totalParticipants:count,mass:count,totalKills:kills,totalFame:fame};
    const battle={...original.body.battle,totalKills:kills,totalFame:fame,players};
    return {row,body:{server:'asia',battle}};
}
test('a 5-player tracked fight is valid when ZvZ provides a verified roster',()=>{
    const {row,body}=smallFightFixture(5);
    assert.equal(parseList({server:'asia',rows:[row]},now)[0].id,'531162052');
    const parsed=parseDetail(body,'531162052',row,'Guild One',now,guildId);
    assert.ok(parsed);
    assert.equal(parsed.players.length,5);
    assert.equal(parsed.guilds[guildId].kills,1);
    assert.equal(parsed.guilds[guildId].deaths,1);
    assert.equal(parsed.totalFame,200000);
    assert.equal(parseDetail(body,'531162052',row,'Guild One',now,otherId),null);
});
test('even a 1-player tracked fight has no Bot-side minimum mass gate',()=>{
    const {row,body}=smallFightFixture(1,'531162053');
    const parsed=parseDetail(body,'531162053',row,'Guild One',now,guildId);
    assert.ok(parsed);
    assert.equal(parsed.players.length,1);
    assert.equal(parsed.guilds[guildId].kills,1);
});
test('direct ZvZ detail is tried first for an Official-discovered ID missing from the ZvZ list',async()=>{
    const {body}=smallFightFixture(5);
    const f=sourceFixture((url,options)=>{
        assert.match(url,/\/api\/dev\/battle-board\/battle$/);
        assert.equal(options.params.battleId,'531162052');
        return {data:body};
    });
    assert.equal(f.source.hasKnownBattle('531162052'),false);
    const parsed=await f.source.getDetail('531162052','Guild One',guildId);
    assert.ok(parsed);
    assert.ok(f.source.isPrimaryData(parsed));
    assert.equal(f.calls.length,1);
    assert.equal(f.source.getRequestMetrics().detailRequests,1);
    // Strict full-roster check still rejects conflicting tracked guild.
    assert.equal(await f.source.getDetail('531162052','Guild One',otherId),null);
});
test('small fights absent from ZvZ use Official fallback without a global circuit break',async()=>{
    const f=sourceFixture(()=>{throw {response:{status:404}};});
    assert.equal(await f.source.getDetail('531162052','Guild One',guildId),null);
    assert.equal(f.source.getRequestMetrics().circuit,'ready');
    assert.equal(f.calls.length,1);
    assert.equal(await f.source.getDetail('531162052','Guild One',guildId),null);
    assert.equal(f.calls.length,1,'negative cache should avoid repeat 404 calls');
    f.advance(5*60_000+1);
    assert.equal(await f.source.getDetail('531162052','Guild One',guildId),null);
    assert.equal(f.calls.length,2);
});
test('an unindexed API body uses a short negative cache, not a made-up battle',async()=>{
    const f=sourceFixture(()=>({data:{server:'asia',battle:null}}));
    assert.equal(await f.source.getDetail('531162052','Guild One',guildId),null);
    assert.equal(await f.source.getDetail('531162052','Guild One',guildId),null);
    assert.equal(f.calls.length,1);
    assert.equal(f.source.getRequestMetrics().circuit,'ready');
});
test('malformed direct details never bypass source validation',()=>{
    const {body}=smallFightFixture(5);
    assert.equal(parseDetail({...body,server:'europe'},'531162052',null,'Guild One',now,guildId),null);
    assert.equal(parseDetail(body,'531162052',null,'Guild One',now,otherId),null);
    assert.equal(parseDetail({...body,battle:{...body.battle,players:body.battle.players.slice(1)}},
        '531162052',null,'Guild One',now,guildId),null);
    assert.equal(parseDetail({...body,battle:{...body.battle,totalFame:999999}},
        '531162052',null,'Guild One',now,guildId),null);
});
test('the ZvZ public list asks for all sizes without changing the Bot Fame policy',async()=>{
    const {row}=smallFightFixture(5);
    const f=sourceFixture(()=>({data:{server:'asia',rows:[row]}}));
    await f.source.discover('Guild One','scope',{guildId});
    assert.equal(f.calls[0].options.params.minMass,1);
    assert.equal(f.calls[0].options.params.server,'asia');
    assert.equal(f.calls[0].options.params.massMode,'total');
});
