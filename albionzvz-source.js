'use strict';

// Public browser routes observed in the user's sanitized network comparison.
// Opt in ONLY after permission/usage limits have been confirmed with provider.
// No authentication bypass, retries against a blocked host, or hidden endpoints.
const BASE='https://www.albionzvz.com';
const SOURCE='AlbionZvZ Asia';
const idOf=x=>String(x?.id ?? x?.Id ?? x?.battleId ?? x?.BattleId ?? '').trim();
const validId=x=>/^\d{1,20}$/.test(String(x)) && String(x)!=='0';
const norm=x=>typeof x==='string'?x.trim().toLowerCase():'';
const values=x=>Array.isArray(x)?x:x && typeof x==='object'?Object.values(x):[];
function timeMs(value){
    if(value==null||value==='')return null;
    const s=String(value).trim();
    const n=/^\d{10,13}$/.test(s)?Number(s)*(s.length===10?1000:1):Date.parse(s);
    return Number.isFinite(n)&&n>0?n:null;
}
function formatEndDelay(battle,at=Date.now()){
    const start=timeMs(battle?.startTime ?? battle?.StartTime ?? battle?.start_time);
    const end=timeMs(battle?.endTime ?? battle?.EndTime ?? battle?.end_time);
    if(end===null||!Number.isFinite(at)||at<end||(start!==null&&end<start))
        return '⏱️ Delay (Battle จบ → ส่งรายงาน): ไม่มีข้อมูลเวลาจบ Battle ที่ใช้คำนวณได้';
    const seconds=Math.floor((at-end)/1000);
    return '⏱️ Delay (Battle จบ → ส่งรายงาน): '+Math.floor(seconds/60)+' นาที '+seconds%60+' วินาที';
}
function battleLink(id){
    return validId(id)?'['+id+']('+BASE+'/battles/'+id+'?server=asia)':String(id);
}
const field=(obj,keys)=>keys.map(k=>obj?.[k]).find(v=>v!==null&&v!==undefined&&v!=='');
function integer(value){
    if(value===undefined||value===null||value===''||typeof value==='boolean')return null;
    const n=Number(value);return Number.isSafeInteger(n)&&n>=0?n:null;
}
function stats(row){
    const kills=integer(field(row,['kills','Kills']));
    const deaths=integer(field(row,['deaths','Deaths']));
    const killFame=integer(field(row,['killFame','killfame','KillFame','fame','Fame']));
    return [kills,deaths,killFame].includes(null)?null:{kills,deaths,killFame};
}
function parseList(body,now=Date.now()){
    if(!body||!Array.isArray(body.rows)||body.rows.length>25|| (body.server!=null&&body.server!=='asia'))return null;
    const result=[];
    for(const row of body.rows){
        const id=idOf(row),end=timeMs(row?.endTime);
        if(!validId(id)||end===null||!Array.isArray(row.guildNames)||row.guildNames.some(n=>typeof n!=='string'))return null;
        if(end>now+60000||now-end>24*60*60*1000)continue;
        result.push({...row,id});
    }
    return result;
}
function parseDetail(body,id,listRow,targetGuild,now=Date.now(),targetGuildId=''){
    // Live AlbionZvZ response (Nov 21) has battle.players but *no*
    // battle.guilds/alliances. Reconstruct a verified guild summary using
    // exact guild IDs and names from that same List row, not guesses.
    if(!body||body.server!=='asia'||!body.battle||idOf(body.battle)!==String(id))return null;
    const b=body.battle;
    const start=timeMs(b.startTime ?? b.StartTime),end=timeMs(b.endTime ?? b.EndTime);
    if(start===null||end===null||end<start||end>now||now-end>24*60*60_000)return null;
    if(timeMs(listRow?.startTime)!==start||timeMs(listRow?.endTime)!==end)return null;
    const expected=integer(field(listRow,['totalParticipants','mass']));
    const expectedKills=integer(field(listRow,['totalKills']));
    const expectedFame=integer(field(listRow,['totalFame']));
    if(expected===null||expected<10||expectedKills===null||expectedFame===null)return null;
    if(integer(b.totalKills)!==expectedKills||integer(b.totalFame)!==expectedFame)return null;
    const players=values(b.players);
    const guildMasses=listRow?.guildMasses;
    if(players.length!==expected||!Array.isArray(guildMasses)||!guildMasses.length)return null;
    const names=new Set(),normalizedPlayers=[];
    for(const p of players){
        const name=field(p,['name','Name','playerName','PlayerName']);
        const guild=field(p,['guildName','GuildName','guild','Guild']);
        // Unguilded players are valid; don't manufacture guild membership.
        const rawGuild=guild ?? (['guildName','GuildName','guild','Guild'].some(k=>p?.[k]==='')?'':null);
        const guildId=String(p?.guildId??p?.GuildId??'').trim();
        const st=stats(p);
        if(!norm(name)||names.has(norm(name))||typeof rawGuild!=='string'||!st)return null;
        if(Boolean(norm(rawGuild))!==Boolean(guildId))return null;
        names.add(norm(name));normalizedPlayers.push({...p,name,guildName:rawGuild,guildId,...st});
    }
    // Albion GameInfo can expose a tiny source-level totalFame vs
    // per-player killFame discrepancy (observed +8 on both AlbionZvZ
    // and Official for the *same* Asia fight). Preserve each player's
    // exact Fame; never manufacture or redistribute the difference.
    // Strictly reject material inconsistencies instead of assuming a
    // missing player's Fame is zero.
    const playerKills=normalizedPlayers.reduce((s,p)=>s+p.kills,0);
    const playerFame=normalizedPlayers.reduce((s,p)=>s+p.killFame,0);
    const fameVarianceCap=Math.max(10,Math.min(100,Math.floor(expectedFame*0.00005)));
    if(playerKills!==expectedKills||Math.abs(playerFame-expectedFame)>fameVarianceCap)return null;
    const normalizedGuilds=Object.create(null),normalizedAlliances=Object.create(null);
    const seenGuildNames=new Set();
    let targetVerified=false;
    for(const record of guildMasses){
        const gid=String(record?.guildId??'').trim(),name=String(record?.name??'').trim();
        if(!gid||!norm(name)||Object.hasOwn(normalizedGuilds,gid)||seenGuildNames.has(norm(name)))return null;
        seenGuildNames.add(norm(name));
        const members=normalizedPlayers.filter(p=>p.guildId===gid);
        const expectedMass=integer(record.mass);
        const expectedGuildKills=integer(record.kills);
        if(!members.length||expectedMass!==members.length||expectedGuildKills===null)return null;
        if(members.some(p=>norm(p.guildName)!==norm(name)))return null;
        const kills=members.reduce((s,p)=>s+p.kills,0);
        const deaths=members.reduce((s,p)=>s+p.deaths,0);
        const killFame=members.reduce((s,p)=>s+p.killFame,0);
        if(kills!==expectedGuildKills)return null;
        const expectedGuildDeaths=record.deaths===null||record.deaths===undefined?null:integer(record.deaths);
        if(expectedGuildDeaths!==null&&expectedGuildDeaths!==deaths)return null;
        const allianceId=String(record.allianceId??'').trim();
        const allianceName=String(record.allianceName??'').trim();
        if(allianceName&&!allianceId)return null;
        if(allianceId){
            const previous=normalizedAlliances[allianceId];
            if(previous&&norm(previous.name)!==norm(allianceName))return null;
            normalizedAlliances[allianceId]={id:allianceId,name:allianceName};
        }
        normalizedGuilds[gid]={id:gid,name,kills,deaths,killFame,allianceId};
        if(norm(name)===norm(targetGuild)&&(!targetGuildId||gid===String(targetGuildId)))targetVerified=true;
    }
    if(!targetVerified||normalizedPlayers.some(p=>p.guildId&&!Object.hasOwn(normalizedGuilds,p.guildId)))return null;
    // A cached Detail that comes from another fight with the same nominal
    // time or a partial player roster must not be treated as complete.
    for(const p of normalizedPlayers){
        if(p.guildId&&norm(normalizedGuilds[p.guildId].name)!==norm(p.guildName))return null;
    }
    return {...b,id:String(id),startTime:new Date(start).toISOString(),endTime:new Date(end).toISOString(),
        players:normalizedPlayers,guilds:normalizedGuilds,alliances:normalizedAlliances,
        totalKills:expectedKills,totalFame:expectedFame};
}
function createAlbionZvZSource({
    http,env=process.env,now=Date.now,log=console.warn,
    sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),random=Math.random
}={}){
    const enabled=()=>String(env.ALBIONZVZ_PRIMARY_ENABLED||'').toLowerCase()==='true';
    let blockedUntil=0, accessDenied=false, listExpires=0,list=null,listFlight=null,detailWindow=0,detailCount=0;
    const details=new Map(),detailFlights=new Map(),knownRows=new Map(),lastOfficial=new Map();
    const sourceObjects=new WeakSet();
    // One shared request lane for every tracked guild and both public endpoints.
    // Never rotate identities, send challenge tokens, or circumvent access denial.
    const MIN_REQUEST_GAP_MS=3500;
    let requestLane=Promise.resolve(),lastRequestAt=null,failStreak=0;
    const metrics={requests:0,listRequests:0,detailRequests:0,
        listCacheHits:0,detailCacheHits:0,waitMs:0,
        forbidden:0,throttled:0,transientErrors:0,lastHttpStatus:null};
    const statusInfo=()=>({ ...metrics,
        accessDenied,backoffUntil:blockedUntil,
        circuit:accessDenied?'denied':now()<blockedUntil?'cooldown':'ready' });
    function markHealthy(){failStreak=0;metrics.lastHttpStatus=200;}
    async function guardedGet(url,params,kind){
        const previous=requestLane;
        let release;
        requestLane=new Promise(resolve=>{release=resolve;});
        await previous;
        try{
            if(!enabled()||accessDenied||now()<blockedUntil)return null;
            if(lastRequestAt!==null){
                const pause=Math.max(0,MIN_REQUEST_GAP_MS-(now()-lastRequestAt));
                if(pause>0){metrics.waitMs+=pause;await sleep(pause);}
            }
            if(!enabled()||accessDenied||now()<blockedUntil)return null;
            lastRequestAt=now();
            metrics.requests++;
            if(kind==='list')metrics.listRequests++;else metrics.detailRequests++;
            return await http.get(url,{timeout:5000,maxRedirects:0,
                headers:{Accept:'application/json','User-Agent':'BossBot-AlbionZvZ/1.0'},
                params});
        }finally{release();}
    }
    function block(error){
        const status=Number(error?.response?.status)||0;
        metrics.lastHttpStatus=status||null;
        if(status===401||status===403){
            metrics.forbidden++;
            accessDenied=true;
            log('🛑 [AlbionZvZ] HTTP '+status+' ปฏิเสธการเข้าถึง | หยุดเรียกใน Process นี้ และใช้ Official API ทันที');
            return;
        }
        failStreak=Math.min(failStreak+1,8);
        const raw=error?.response?.headers?.['retry-after'];
        const retrySeconds=raw!=null&&/^\d+$/.test(String(raw))?Number(raw):null;
        const retryDate=retrySeconds===null?timeMs(raw):null;
        const retryMs=retrySeconds!==null?retrySeconds*1000:retryDate!==null?Math.max(0,retryDate-now()):0;
        if(status===429)metrics.throttled++;else metrics.transientErrors++;
        const base=status===429?10*60_000:60_000;
        const backoff=Math.min(60*60_000,base*2**Math.min(failStreak-1,6));
        // Bounded jitter reduces synchronized retry waves; never shorten Retry-After.
        const boundedRandom=Math.max(0,Math.min(1,Number(random())||0));
        const cooldown=Math.max(retryMs,backoff+Math.floor(backoff*boundedRandom*0.1));
        blockedUntil=Math.max(blockedUntil,now()+cooldown);
        log('⏳ [AlbionZvZ] ใช้ Official API สำรอง | HTTP='+
            (status||'network/schema')+' | ล้มเหลวต่อเนื่อง='+failStreak+
            ' | งดเรียกถึง='+new Date(blockedUntil).toISOString()+
            ' | คำขอสะสม='+metrics.requests+' | Cache List='+
            metrics.listCacheHits+' Detail='+metrics.detailCacheHits);
    }
    async function getList(){
        if(!enabled()||accessDenied||now()<blockedUntil)return null;
        if(listExpires>now()){metrics.listCacheHits++;return list;}
        if(listFlight)return listFlight;
        listFlight=(async()=>{
            try{
                const to=new Date(now()).toISOString().slice(0,10);
                const from=new Date(now()-86400000).toISOString().slice(0,10);
                const r=await guardedGet(BASE+'/api/battles',
                    {server:'asia',from,to,minMass:10,massMode:'total',offset:0,limit:25},'list');
                if(!r)return null;
                const rows=parseList(r.data,now());
                if(rows===null)throw Error('List schema incomplete');
                markHealthy();
                list=rows;listExpires=now()+60_000;
                for(const row of rows)knownRows.set(row.id,row);
                while(knownRows.size>100)knownRows.delete(knownRows.keys().next().value);
                return rows;
            }catch(e){block(e);list=null;return null;}
            finally{listFlight=null;}
        })();
        return listFlight;
    }
    async function discover(guild,scope,{processed=new Set(),baselineOnly=false,guildId=''}={}){
        if(!enabled()||baselineOnly)return {ids:[],useOfficial:true};
        const rows=await getList();
        const ids=rows===null?[]:rows.filter(r=>r.guildNames.some(g=>norm(g)===norm(guild)) &&
            (!guildId || (Array.isArray(r.guildMasses)&&r.guildMasses.some(g=>String(g?.guildId||'')===String(guildId)&&norm(g?.name)===norm(guild))))).map(r=>r.id);
        // Public board is capped at 25/10-player fights. Preserve periodic
        // reconciliation even with a healthy source and fallback on no new match.
        const due=now()-(lastOfficial.get(scope)??-Infinity)>=5*60_000;
        return {ids:[...new Set(ids)],useOfficial:rows===null||!ids.some(id=>!processed.has(id))||due};
    }
    function noteOfficial(scope){lastOfficial.set(scope,now());while(lastOfficial.size>512)lastOfficial.delete(lastOfficial.keys().next().value);}
    async function getDetail(id,guild,guildId=''){
        id=String(id);
        if(!enabled()||accessDenied||now()<blockedUntil||!validId(id)||!knownRows.has(id))return null;
        const row=knownRows.get(id);
        const hit=details.get(id);
        if(hit&&hit.expiresAt>now()){
            metrics.detailCacheHits++;
            const data=parseDetail(hit.body,id,row,guild,now(),guildId);if(data)sourceObjects.add(data);return data;
        }
        if(detailFlights.has(id))return detailFlights.get(id).then(body=>{
            const data=parseDetail(body,id,row,guild,now(),guildId);if(data)sourceObjects.add(data);return data;
        });
        if(now()-detailWindow>=60_000){detailWindow=now();detailCount=0;}
        if(detailCount>=3)return null;
        detailCount++;
        const task=(async()=>{
            try{
                const r=await guardedGet(BASE+'/api/dev/battle-board/battle',
                    {battleId:id,server:'asia'},'detail');
                if(!r)return null;
                if(!r.data||r.data.server!=='asia'||!r.data.battle||
                   idOf(r.data.battle)!==id)throw Error('Detail schema invalid');
                markHealthy();
                details.set(id,{body:r.data,expiresAt:now()+120_000});
                while(details.size>100)details.delete(details.keys().next().value);
                return r.data;
            }catch(e){block(e);return null;}finally{detailFlights.delete(id);}
        })();
        detailFlights.set(id,task);
        const data=parseDetail(await task,id,row,guild,now(),guildId);
        if(data)sourceObjects.add(data);
        return data;
    }
    return {enabled,discover,noteOfficial,getDetail,getRequestMetrics:statusInfo,
        hasKnownBattle:id=>knownRows.has(String(id)),isPrimaryData:b=>Boolean(b&&sourceObjects.has(b))};
}
module.exports={createAlbionZvZSource,parseList,parseDetail,formatEndDelay,battleLink,SOURCE};
