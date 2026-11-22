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

/**
 * Some provider Battle Details contain player rows but no guild summary.
 * Build guild totals only from explicitly matched player Guild IDs/names.
 * No synthetic players, no inferred guild membership or Fame.
 */
function deriveGuildMassesFromPlayers(players){
    const groups=new Map();
    for(const p of players){
        if(!p.guildId)continue;
        const allianceId=String(p.allianceId??'').trim();
        const allianceName=String(p.allianceName??'').trim();
        if(allianceName&&!allianceId)return null;
        const key=p.guildId;
        let g=groups.get(key);
        if(!g){
            g={guildId:key,name:p.guildName,mass:0,kills:0,deaths:0,allianceId,allianceName};
            groups.set(key,g);
        }else if(norm(g.name)!==norm(p.guildName)||g.allianceId!==allianceId||
                 norm(g.allianceName)!==norm(allianceName))return null;
        g.mass++;g.kills+=p.kills;g.deaths+=p.deaths;
    }
    return [...groups.values()];
}

function parseDetail(body,id,listRow,targetGuild,now=Date.now(),targetGuildId=''){
    // The provider's public List may omit small fights. For Battle IDs
    // already discovered by Official Battle List, first try AlbionZvZ Detail
    // even without a list row; validate every returned player and guild ID.
    if(!body||body.server!=='asia'||!body.battle||idOf(body.battle)!==String(id))return null;
    const b=body.battle;
    const start=timeMs(b.startTime ?? b.StartTime),end=timeMs(b.endTime ?? b.EndTime);
    if(start===null||end===null||end<start||end>now||now-end>24*60*60_000)return null;
    if(listRow&&(timeMs(listRow.startTime)!==start||timeMs(listRow.endTime)!==end))return null;
    const players=values(b.players);
    const expected=listRow
        ? integer(field(listRow,['totalParticipants','mass']))
        : integer(field(b,['totalParticipants','TotalParticipants'])??players.length);
    const expectedKills=listRow?integer(field(listRow,['totalKills'])):integer(b.totalKills);
    const expectedFame=listRow?integer(field(listRow,['totalFame'])):integer(b.totalFame);
    if(expected===null||expected<1||expectedKills===null||expectedFame===null)return null;
    if(integer(b.totalKills)!==expectedKills||integer(b.totalFame)!==expectedFame)return null;
    if(players.length!==expected||players.length>1000)return null;
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
    // Prefer Guild IDs in the provider List; for a fight absent there, use
    // only explicit guildId/guildName fields from the complete Detail roster.
    // A list row that advertises no guild summary is incomplete and must
    // not be silently repaired; derive only when that ID is absent from List.
    const guildMasses=listRow ? listRow.guildMasses :
        deriveGuildMassesFromPlayers(normalizedPlayers);
    if(!Array.isArray(guildMasses)||!guildMasses.length)return null;
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
    const details=new Map(),detailFlights=new Map(),knownRows=new Map(),lastOfficial=new Map(),notIndexed=new Map();
    const sourceObjects=new WeakSet();
    // One shared request lane for every tracked guild and both public endpoints.
    // Never rotate identities, send challenge tokens, or circumvent access denial.
    const MIN_REQUEST_GAP_MS=3500;
    let requestLane=Promise.resolve(),lastRequestAt=null,failStreak=0;
    const metrics={requests:0,listRequests:0,detailRequests:0,
        listCacheHits:0,detailCacheHits:0,waitMs:0,
        forbidden:0,throttled:0,transientErrors:0,challengePages:0,lastHttpStatus:null};
    const statusInfo=()=>({ ...metrics,
        forbiddenRatePct:metrics.requests?Number((100*metrics.forbidden/metrics.requests).toFixed(2)):0,
        throttledRatePct:metrics.requests?Number((100*metrics.throttled/metrics.requests).toFixed(2)):0,
        accessDenied,backoffUntil:blockedUntil,
        circuit:accessDenied?'denied':now()<blockedUntil?'cooldown':'ready' });
    function markHealthy(){failStreak=0;metrics.lastHttpStatus=200;}
    function isUnexpectedHtmlResponse(response){
        const type=String(response?.headers?.['content-type']||'').toLowerCase();
        return type.includes('text/html')||type.includes('application/xhtml')||
            (typeof response?.data==='string' && /^\\s*(?:<!doctype\\s+html|<html[\\s>])/i.test(response.data));
    }
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
            const response=await http.get(url,{timeout:5000,maxRedirects:0,
                headers:{Accept:'application/json','User-Agent':'BossBot-AlbionZvZ/1.0'},
                params});
            if(isUnexpectedHtmlResponse(response)){
                // JSON endpoints must not silently become browser challenge
                // pages. Do not retry a challenge or attempt to solve it.
                accessDenied=true;
                metrics.challengePages=(metrics.challengePages||0)+1;
                metrics.lastHttpStatus=Number(response?.status)||200;
                log('🛑 [AlbionZvZ] API ตอบ HTML แทน JSON อาจเป็นหน้า Challenge | หยุดเรียกเว็บไซต์และใช้ Official API');
                return null;
            }
            return response;
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
                    {server:'asia',from,to,minMass:1,massMode:'total',offset:0,limit:25},'list');
                if(!r)return null;
                const rows=parseList(r.data,now());
                if(rows===null)throw Error('List schema incomplete');
                markHealthy();
                list=rows;listExpires=now()+60_000;
                for(const row of rows){
                    // Refresh insertion order so the bounded cache holds the most
                    // recently observed IDs, not just the first 100 ever observed.
                    knownRows.delete(row.id);
                    knownRows.set(row.id,row);
                }
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
        // Reuse the already-fetched recent List rows for a moving coverage
        // window (max 100 IDs). No extra pages, requests, or shorter polling.
        // Do not report from stale list cache when the current List is unavailable.
        const recentRows=rows===null?[]:[...knownRows.values()].reverse().filter(r=>{
            const end=timeMs(r.endTime);
            return end!==null && now()-end<=30*60_000;
        });
        // Keep every current page row eligible, even if the fight ended over
        // 30 minutes ago; the existing scanner still applies its age policy.
        const candidates=rows===null?[]:[...new Map([...recentRows,...rows].map(r=>[r.id,r])).values()];
        const ids=candidates.filter(r=>r.guildNames.some(g=>norm(g)===norm(guild)) &&
            (!guildId || (Array.isArray(r.guildMasses)&&r.guildMasses.some(g=>String(g?.guildId||'')===String(guildId)&&norm(g?.name)===norm(guild))))).map(r=>r.id);
        // Public board is capped at 25/10-player fights. Preserve periodic
        // reconciliation even with a healthy source and fallback on no new match.
        const due=now()-(lastOfficial.get(scope)??-Infinity)>=5*60_000;
        return {ids:[...new Set(ids)],useOfficial:rows===null||!ids.some(id=>!processed.has(id))||due};
    }
    function noteOfficial(scope){lastOfficial.set(scope,now());while(lastOfficial.size>512)lastOfficial.delete(lastOfficial.keys().next().value);}
    // Diagnostic metadata is output-only. It must never influence provider
    // selection, retry budgets, report thresholds, or persistent tracking.
    async function getDetail(id,guild,guildId='',diagnostic=null){
        id=String(id);
        const note=reason=>{if(diagnostic&&typeof diagnostic==='object')diagnostic.reason=reason;};
        if(!enabled()){note('PRIMARY_DISABLED');return null;}
        if(accessDenied){note('CIRCUIT_DENIED');return null;}
        if(now()<blockedUntil){note('CIRCUIT_COOLDOWN');return null;}
        if(!validId(id)){note('INVALID_BATTLE_ID');return null;}
        if((notIndexed.get(id)||0)>now()){note('NOT_INDEXED_CACHED');return null;}
        notIndexed.delete(id);
        const row=knownRows.get(id)||null;
        const hit=details.get(id);
        const parseResult=(body,successReason,missReason)=>{
            // Only numeric counts; never copy raw player names/equipment/response.
            if (body?.battle && diagnostic && typeof diagnostic === 'object') {
                const b=body.battle;
                diagnostic.providerPlayers=values(b.players).length;
                diagnostic.providerExpected=integer(field(b,['totalParticipants','TotalParticipants']));
                diagnostic.listExpected=row?integer(field(row,['totalParticipants','mass'])):null;
            }
            const data=body?parseDetail(body,id,row,guild,now(),guildId):null;
            if (!data && body && diagnostic && typeof diagnostic === 'object') {
                const actual=diagnostic.providerPlayers;
                const fromList=diagnostic.listExpected;
                const fromDetail=diagnostic.providerExpected;
                diagnostic.validationIssue=fromList!==null && fromList!==undefined && actual!==fromList
                    ? 'LIST_PLAYER_COUNT_MISMATCH'
                    : fromDetail!==null && fromDetail!==undefined && actual!==fromDetail
                        ? 'DETAIL_PLAYER_COUNT_MISMATCH'
                        : 'OTHER_VALIDATION';
            }
            note(data?successReason:missReason);
            if(data)sourceObjects.add(data);
            return data;
        };
        if(hit&&hit.expiresAt>now()){
            metrics.detailCacheHits++;
            return parseResult(hit.body,'PRIMARY_CACHE_OK','INVALID_DETAIL');
        }
        if(detailFlights.has(id)){
            const pending=await detailFlights.get(id);
            return parseResult(pending.body,'PRIMARY_SHARED_OK',pending.body?'INVALID_DETAIL':pending.reason);
        }
        if(now()-detailWindow>=60_000){detailWindow=now();detailCount=0;}
        if(detailCount>=3){note('DETAIL_REQUEST_BUDGET');return null;}
        detailCount++;
        const task=(async()=>{
            try{
                const r=await guardedGet(BASE+'/api/dev/battle-board/battle',
                    {battleId:id,server:'asia'},'detail');
                if(!r)return {body:null,reason:accessDenied?'CIRCUIT_DENIED':now()<blockedUntil?'CIRCUIT_COOLDOWN':'REQUEST_UNAVAILABLE'};
                if(!r.data?.battle){
                    // Not indexed by AlbionZvZ yet: no repeated requests for the
                    // same missing Battle ID, no site-wide circuit breaker.
                    notIndexed.set(id,now()+5*60_000);
                    while(notIndexed.size>150)notIndexed.delete(notIndexed.keys().next().value);
                    return {body:null,reason:'NO_BATTLE_DETAIL'};
                }
                if(r.data.server!=='asia'||idOf(r.data.battle)!==id)
                    throw Error('Detail schema invalid');
                markHealthy();
                details.set(id,{body:r.data,expiresAt:now()+120_000});
                while(details.size>100)details.delete(details.keys().next().value);
                return {body:r.data,reason:'PRIMARY_HTTP_200'};
            }catch(e){
                const status=Number(e?.response?.status)||0;
                if(status===404){
                    notIndexed.set(id,now()+5*60_000);
                    while(notIndexed.size>150)notIndexed.delete(notIndexed.keys().next().value);
                    return {body:null,reason:'HTTP_404'};
                }
                block(e);
                const errorCode=String(e?.code||'').toUpperCase();
                const reason=status>=400&&status<600?'HTTP_'+status:
                    ['ECONNABORTED','ETIMEDOUT'].includes(errorCode)?'TIMEOUT':'NETWORK_OR_SCHEMA_ERROR';
                return {body:null,reason};
            }finally{detailFlights.delete(id);}
        })();
        detailFlights.set(id,task);
        const pending=await task;
        return parseResult(pending.body,'PRIMARY_HTTP_200',pending.body?'INVALID_DETAIL':pending.reason);
    }
    function isPrimaryData(b){return Boolean(b&&sourceObjects.has(b));}
    function reportLink(id,detail){
        id=String(id||'').trim();
        if(!validId(id))return id;
        return isPrimaryData(detail)&&idOf(detail)===id
            ? battleLink(id)
            : '['+id+'](https://albiononline.com/en/killboard/battles/'+id+')';
    }
    return {enabled,discover,noteOfficial,getDetail,getRequestMetrics:statusInfo,reportLink,
        hasKnownBattle:id=>knownRows.has(String(id)),isPrimaryData};
}
module.exports={createAlbionZvZSource,parseList,parseDetail,formatEndDelay,battleLink,SOURCE};
