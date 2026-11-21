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
function parseDetail(body,id,listRow,targetGuild,now=Date.now()){
    // Require an actual Asia envelope and a complete, self-consistent roster.
    // Never turn absent statistics into zero or infer faction/guild membership.
    if(!body||body.server!=='asia'||!body.battle||idOf(body.battle)!==String(id))return null;
    const b=body.battle;
    const start=timeMs(b.startTime ?? b.StartTime),end=timeMs(b.endTime ?? b.EndTime);
    if(start===null||end===null||end<start||end>now)return null;
    const expected=integer(field(listRow,['totalParticipants','mass']));
    const expectedKills=integer(field(listRow,['totalKills']));
    const expectedFame=integer(field(listRow,['totalFame']));
    if(expected===null||expected<10||expectedKills===null||expectedFame===null)return null;
    const players=values(b.players),guilds=values(b.guilds);
    if(players.length!==expected||!guilds.length)return null;
    const names=new Set(),normalizedPlayers=[];
    for(const p of players){
        const name=field(p,['name','Name','playerName','PlayerName']);
        const guild=field(p,['guildName','GuildName','guild','Guild']);
        // Empty guild name is valid only if explicitly present.
        const rawGuild=guild ?? (['guildName','GuildName','guild','Guild'].some(k=>p?.[k]==='')?'':null);
        const st=stats(p);
        if(!norm(name)||names.has(norm(name))||typeof rawGuild!=='string'||!st)return null;
        names.add(norm(name));normalizedPlayers.push({...p,name,guildName:rawGuild,...st});
    }
    const guildNames=new Set();
    const normalizedGuilds={};
    for(const [i,g] of guilds.entries()){
        const name=field(g,['name','Name','guildName','GuildName']),st=stats(g);
        if(!norm(name)||guildNames.has(norm(name))||!st)return null;
        guildNames.add(norm(name));normalizedGuilds[String(g.id??g.Id??i)]={...g,name,...st};
    }
    if(!guildNames.has(norm(targetGuild))||normalizedPlayers.some(p=>norm(p.guildName)&&!guildNames.has(norm(p.guildName))))return null;
    if(normalizedPlayers.reduce((s,p)=>s+p.kills,0)!==expectedKills||
       normalizedPlayers.reduce((s,p)=>s+p.killFame,0)!==expectedFame)return null;
    for(const g of Object.values(normalizedGuilds)){
        const members=normalizedPlayers.filter(p=>norm(p.guildName)===norm(g.name));
        if(!members.length||['kills','deaths','killFame'].some(k=>members.reduce((s,p)=>s+p[k],0)!==g[k]))return null;
        if(g.allianceId&&!b.alliances)return null;
    }
    return {...b,id:String(id),startTime:new Date(start).toISOString(),endTime:new Date(end).toISOString(),
        players:normalizedPlayers,guilds:normalizedGuilds,totalKills:expectedKills,totalFame:expectedFame};
}

function createAlbionZvZSource({http,env=process.env,now=Date.now,log=console.warn}={}){
    const enabled=()=>String(env.ALBIONZVZ_PRIMARY_ENABLED||'').toLowerCase()==='true';
    let blockedUntil=0, listExpires=0,list=null,listFlight=null,detailWindow=0,detailCount=0;
    const details=new Map(),detailFlights=new Map(),knownRows=new Map(),lastOfficial=new Map();
    const sourceObjects=new WeakSet();
    function block(error){
        const status=Number(error?.response?.status)||0;
        const raw=error?.response?.headers?.['retry-after'];
        const retrySeconds=raw!=null&&/^\d+$/.test(String(raw))?Number(raw):null;
        const retryDate=retrySeconds===null?timeMs(raw):null;
        const retryMs=retrySeconds!==null?retrySeconds*1000:retryDate!==null?Math.max(0,retryDate-now()):0;
        const delay=status===403||status===401?30*60_000:status===429?10*60_000:60_000;
        blockedUntil=Math.max(blockedUntil,now()+Math.max(delay,retryMs));
        log('⚠️ [AlbionZvZ] ใช้ Official API สำรอง | HTTP='+ (status||'unavailable')+' | พักจน '+new Date(blockedUntil).toISOString());
    }
    async function getList(){
        if(!enabled()||now()<blockedUntil)return null;
        if(listExpires>now())return list;
        if(listFlight)return listFlight;
        listFlight=(async()=>{
            try{
                const to=new Date(now()).toISOString().slice(0,10);
                const from=new Date(now()-86400000).toISOString().slice(0,10);
                const r=await http.get(BASE+'/api/battles',{timeout:5000,maxRedirects:0,
                    headers:{Accept:'application/json','User-Agent':'BossBot-AlbionZvZ/1.0'},
                    params:{server:'asia',from,to,minMass:10,massMode:'total',offset:0,limit:25}});
                const rows=parseList(r.data,now());
                if(rows===null)throw Error('List schema incomplete');
                list=rows;listExpires=now()+60_000;
                for(const row of rows)knownRows.set(row.id,row);
                while(knownRows.size>100)knownRows.delete(knownRows.keys().next().value);
                return rows;
            }catch(e){block(e);list=null;return null;}
            finally{listFlight=null;}
        })();
        return listFlight;
    }
    async function discover(guild,scope,{processed=new Set(),baselineOnly=false}={}){
        if(!enabled()||baselineOnly)return {ids:[],useOfficial:true};
        const rows=await getList();
        const ids=rows===null?[]:rows.filter(r=>r.guildNames.some(g=>norm(g)===norm(guild))).map(r=>r.id);
        // Public board is capped at 25/10-player fights. Preserve periodic
        // reconciliation even with a healthy source and fallback on no new match.
        const due=now()-(lastOfficial.get(scope)??-Infinity)>=5*60_000;
        return {ids:[...new Set(ids)],useOfficial:rows===null||!ids.some(id=>!processed.has(id))||due};
    }
    function noteOfficial(scope){lastOfficial.set(scope,now());while(lastOfficial.size>512)lastOfficial.delete(lastOfficial.keys().next().value);}
    async function getDetail(id,guild){
        id=String(id);
        if(!enabled()||now()<blockedUntil||!validId(id)||!knownRows.has(id))return null;
        const row=knownRows.get(id);
        const hit=details.get(id);
        if(hit&&hit.expiresAt>now()){
            const data=parseDetail(hit.body,id,row,guild,now());if(data)sourceObjects.add(data);return data;
        }
        if(detailFlights.has(id))return detailFlights.get(id).then(body=>{
            const data=parseDetail(body,id,row,guild,now());if(data)sourceObjects.add(data);return data;
        });
        if(now()-detailWindow>=60_000){detailWindow=now();detailCount=0;}
        if(detailCount>=3)return null;
        detailCount++;
        const task=(async()=>{
            try{
                const r=await http.get(BASE+'/api/dev/battle-board/battle',{timeout:5000,maxRedirects:0,
                    headers:{Accept:'application/json','User-Agent':'BossBot-AlbionZvZ/1.0'},
                    params:{battleId:id,server:'asia'}});
                details.set(id,{body:r.data,expiresAt:now()+120_000});
                while(details.size>100)details.delete(details.keys().next().value);
                return r.data;
            }catch(e){block(e);return null;}finally{detailFlights.delete(id);}
        })();
        detailFlights.set(id,task);
        const data=parseDetail(await task,id,row,guild,now());
        if(data)sourceObjects.add(data);
        return data;
    }
    return {enabled,discover,noteOfficial,getDetail,isPrimaryData:b=>Boolean(b&&sourceObjects.has(b))};
}
module.exports={createAlbionZvZSource,parseList,parseDetail,formatEndDelay,battleLink,SOURCE};
