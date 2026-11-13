'use strict';

// Strictly observational Asia Official Events polling. Never calls Discord,
// Battleboard delivery endpoints, processedBattle markers, or source handoff.
const ENDPOINT = 'https://gameinfo-sgp.albiononline.com/api/gameinfo/events';
const GUILD_ID = /^[A-Za-z0-9_-]{16,80}$/;
const BATTLE_ID = /^[1-9][0-9]{0,19}$/;
const MIN_INTERVAL_MS = 60000;
const MAX_GUILDS_PER_TICK = 2;
const MAX_KNOWN_IDS = 1000;

function guildIdsFromConfigs(configs) {
  const ids = new Set();
  for (const entry of Array.isArray(configs) ? configs : []) {
    const config = entry?.config || entry;
    const guilds = [
      ...(Array.isArray(config?.autoBattles) ? config.autoBattles : []),
      ...(Array.isArray(config?.guilds) ? config.guilds : []),
    ];
    for (const guild of guilds) {
      const value = String(
        (typeof guild === 'string' ? guild : guild?.targetGuildId || guild?.id || guild?.guildId || '')
      ).trim();
      if (GUILD_ID.test(value)) ids.add(value);
    }
  }
  return [...ids].sort().slice(0,24);
}

function extractBattleIds(payload) {
  if (!Array.isArray(payload)) return [];
  return [...new Set(payload
    .map(item=>String(item?.BattleId ?? item?.battleId ?? '').trim())
    .filter(value=>BATTLE_ID.test(value)))];
}

function createOfficialEventsShadow({
  getGuildConfigs, fetchImpl=globalThis.fetch, logger=console,
  onFirstObserved=async()=>{},
  now=()=>Date.now(), intervalMs=MIN_INTERVAL_MS,
}={}) {
  if (typeof getGuildConfigs !== 'function') throw new Error('getGuildConfigs is required');
  if (typeof fetchImpl !== 'function') throw new Error('fetch is required');
  const safeInterval=Math.max(MIN_INTERVAL_MS, Number(intervalMs)||MIN_INTERVAL_MS);
  const known=new Map();
  const nextByGuild=new Map();
  const initializedGuilds=new Set();
  let timer=null,started=false,running=false,cursor=0,backoffUntil=0,successes=0;
  const enabled=()=>process.env.OFFICIAL_EVENTS_SHADOW_ENABLED==='true';
  function remember(id,time) {
    known.set(id,time);
    while(known.size>MAX_KNOWN_IDS) known.delete(known.keys().next().value);
  }
  async function tick(){
    if(!started||!enabled()||running||now()<backoffUntil)return;
    running=true;
    try {
      const guilds=guildIdsFromConfigs(getGuildConfigs());
      if(!guilds.length)return;
      let fetched=0;
      for(let scan=0;scan<guilds.length && fetched<MAX_GUILDS_PER_TICK;scan++){
        const guildId=guilds[(cursor+scan)%guilds.length];
        if(now() < (nextByGuild.get(guildId)||0))continue;
        nextByGuild.set(guildId,now()+safeInterval);
        fetched++;
        const startedAt=now();
        try{
          const url=new URL(ENDPOINT);
          url.searchParams.set('limit','51');
          url.searchParams.set('offset','0');
          url.searchParams.set('guildId',guildId);
          const response=await fetchImpl(url.toString(),{
            headers:{Accept:'application/json'},signal:AbortSignal.timeout(7000),
          });
          if(!response.ok){
            const retryHeader=response.headers?.get?.('retry-after');
            const seconds=Number(retryHeader);
            const retryMs=Number.isFinite(seconds)&&seconds>=0?seconds*1000:0;
            if([429,403,503].includes(response.status)){
              backoffUntil=Math.max(backoffUntil,now()+Math.max(retryMs,response.status===403?300000:60000));
            }
            logger.warn('[Official Events Shadow] HTTP '+response.status+
              ' | server=asia | guildId='+guildId+' | cooldownMs='+Math.max(0,backoffUntil-now()));
            continue;
          }
          const payload=await response.json();
          if(!Array.isArray(payload)){
            logger.warn('[Official Events Shadow] Invalid events payload | guildId='+guildId);
            continue;
          }
          const seenAt=new Date(now()).toISOString();
          const ids=extractBattleIds(payload);
          const newIds=[];
          if(initializedGuilds.has(guildId)){
            for(const id of ids){
              if(!known.has(id)){
                newIds.push(id);
                logger.log('[Official Events Shadow] first_observed | battleId='+id+
                  ' | source=official_events_shadow | observedAt='+seenAt+
                  ' | guildId='+guildId);
              }
            }
          }
          // Observation persistence is independent from delivery and must not block the next Guild.
          if(newIds.length){
            try{
              await onFirstObserved(newIds.map(battleId=>({
                source:'official_events_shadow',battleId,guildId,observedAt:seenAt,
              })));
            }catch(error){
              logger.warn('[Official Events Shadow] observation persistence failed | guildId='+
                guildId+' | reason='+String(error?.name||'Error').slice(0,40));
            }
          }
          for(const id of ids) remember(id,seenAt);
          const firstGuildPoll=!initializedGuilds.has(guildId);
          initializedGuilds.add(guildId);
          successes++;
          logger.log('[Official Events Shadow] poll | guildId='+guildId+
            ' | events='+payload.length+' | uniqueBattleIds='+ids.length+
            ' | newBattleIds='+newIds.length+' | durationMs='+(now()-startedAt)+
            ' | baseline='+String(firstGuildPoll));
        }catch(error){
          const reason=String(error?.name||error?.code||'network-error').slice(0,60);
          nextByGuild.set(guildId,now()+Math.max(safeInterval,120000));
          logger.warn('[Official Events Shadow] request failed | guildId='+guildId+' | reason='+reason);
        }
      }
      cursor=(cursor+fetched)%guilds.length;
    }finally{running=false;}
  }
  function schedule(){
    if(!started)return;
    timer=setTimeout(async()=>{
      try{await tick();}
      catch(error){logger.warn('[Official Events Shadow] tick error | reason='+String(error?.name||'error').slice(0,60));}
      finally{schedule();}
    },safeInterval);
    timer.unref?.();
  }
  function start(){
    if(started||!enabled())return false;
    started=true;
    logger.log('[Official Events Shadow] enabled | server=asia | mode=observe-only | intervalMs='+safeInterval+
      ' | maxGuildsPerTick='+MAX_GUILDS_PER_TICK+
      ' | primaryDelivery=unchanged | discordSend=disabled');
    // First call after startup is deliberately baseline-only, never emits a "new Battle" lead.
    timer=setTimeout(async()=>{
      try{await tick();}
      finally{schedule();}
    },safeInterval);
    timer.unref?.();
    return true;
  }
  function stop(){started=false;if(timer)clearTimeout(timer);timer=null;}
  function stats(){return{enabled:started,known:known.size,successes,backoffUntil};}
  return{start,stop,tick,stats};
}
module.exports={createOfficialEventsShadow,guildIdsFromConfigs,extractBattleIds};
