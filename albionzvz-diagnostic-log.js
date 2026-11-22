'use strict';
// Local, best-effort evidence only. Never uploaded to Supabase / GitHub.
const fs=require('node:fs/promises');
const path=require('node:path');
const MAX_FILE_BYTES=256*1024, MAX_RECORD_BYTES=512, MAX_QUEUE=128;
const RETENTION_MS=7*24*60*60*1000, MAX_PER_MINUTE=30;
const FILE_NAMES=['albionzvz-detail.jsonl','albionzvz-detail.previous.jsonl'];
const EVENTS=new Set(['BUDGET_WAIT','CAPACITY_EXPIRED','FALLBACK']);
const RESULTS=new Set(['DEFERRED','FALLBACK_OK','FALLBACK_UNAVAILABLE']);

function clean(v,max=48){
    return String(v??'').replace(/[^\p{L}\p{N} _.:\-]/gu,'').slice(0,max);
}
function count(v){
    if(v===null||v===undefined||v==='')return null;
    const n=Number(v);
    return Number.isSafeInteger(n)&&n>=0&&n<=100000?n:null;
}
function createDiagnosticRecord(data,at=Date.now()){
    try{
        if(!EVENTS.has(data?.event)||!/^\d{1,20}$/.test(String(data.battleId))||String(data.battleId)==='0')return null;
        const record={
            at:new Date(at).toISOString(),event:data.event,battleId:String(data.battleId),
            guild:clean(data.guild),reason:clean(data.reason)||'UNKNOWN',
            result:RESULTS.has(data.result)?data.result:'FALLBACK_UNAVAILABLE',
            candidate:data.eventOnly===true?'EVENT_ONLY':'BATTLE_LIST'
        };
        for(const [key,value] of Object.entries({
            providerPlayers:data.providerPlayers,providerExpected:data.providerExpected,
            listExpected:data.listExpected,officialPlayers:data.officialPlayers,waitMs:data.waitMs
        })){
            const n=count(value);
            if(n!==null)record[key]=n;
        }
        const issue=clean(data.issue,40);
        if(issue)record.issue=issue;
        const line=JSON.stringify(record)+'\n';
        return Buffer.byteLength(line,'utf8')<=MAX_RECORD_BYTES?line:null;
    }catch(_){return null;}
}
function createAlbionZvZDiagnosticLog({directory,now=Date.now,onError=()=>{},delayMs=1000}={}){
    if(!directory||!path.isAbsolute(directory))throw new TypeError('Absolute diagnostic directory required');
    const paths=FILE_NAMES.map(n=>path.join(directory,n));
    const pending=[],duplicates=new Map();
    let minute=Math.floor(now()/60000),accepted=0,timer=null,active=null;
    let closed=false,lastPrune=-Infinity,lastError=-Infinity;
    async function prune(){
        if(now()-lastPrune<3600000)return;
        for(const file of paths){
            let st;
            try{st=await fs.lstat(file);}
            catch(e){if(e.code==='ENOENT')continue;throw e;}
            if(!st.isFile()||st.isSymbolicLink())throw Error('NON_REGULAR_LOG');
            if(now()-st.mtimeMs>=RETENTION_MS)await fs.unlink(file);
            else if(st.size>MAX_FILE_BYTES)await fs.truncate(file,0);
        }
        lastPrune=now();
    }
    async function write(batch){
        const data=batch.join(''),length=Buffer.byteLength(data,'utf8');
        if(!data||length>MAX_FILE_BYTES)return;
        await fs.mkdir(directory,{recursive:true,mode:0o700});
        await prune();
        let st;
        try{st=await fs.lstat(paths[0]);}
        catch(e){if(e.code!=='ENOENT')throw e;}
        if(st&&(!st.isFile()||st.isSymbolicLink()))throw Error('NON_REGULAR_LOG');
        if((st?.size||0)+length>MAX_FILE_BYTES){
            try{await fs.unlink(paths[1]);}
            catch(e){if(e.code!=='ENOENT')throw e;}
            try{await fs.rename(paths[0],paths[1]);}
            catch(e){if(e.code!=='ENOENT')throw e;}
        }
        const h=await fs.open(paths[0],'a',0o600);
        try{await h.writeFile(data,'utf8');}
        finally{await h.close();}
    }
    function reportError(err){
        if(now()-lastError<600000)return;
        lastError=now();
        try{onError(String(err?.code||'DIAGNOSTIC_IO_ERROR').slice(0,40));}catch(_){}
    }
    function schedule(){
        if(timer||active||closed)return;
        timer=setTimeout(()=>{timer=null;void flush();},Math.max(0,delayMs));
        timer.unref?.();
    }
    async function flush(){
        if(active)return active;
        if(timer){clearTimeout(timer);timer=null;}
        if(!pending.length)return true;
        const batch=pending.splice(0,MAX_QUEUE);
        active=(async()=>{
            try{await write(batch);return true;}
            catch(e){reportError(e);return false;}
            finally{active=null;if(pending.length&&!closed)schedule();}
        })();
        return active;
    }
    function record(data){
        try{
            if(closed)return false;
            const at=now(),slot=Math.floor(at/60000);
            if(slot!==minute){minute=slot;accepted=0;}
            if(accepted>=MAX_PER_MINUTE)return false;
            const line=createDiagnosticRecord(data,at);
            if(!line)return false;
            const r=JSON.parse(line);
            const key=[r.battleId,r.guild,r.event,r.reason,r.result].join(':');
            if((duplicates.get(key)||0)>at)return false;
            duplicates.delete(key);duplicates.set(key,at+60000);
            while(duplicates.size>256)duplicates.delete(duplicates.keys().next().value);
            accepted++;
            if(pending.length>=MAX_QUEUE)pending.shift();
            pending.push(line);
            schedule();
            return true;
        }catch(_){return false;}
    }
    async function close(){
        closed=true;
        if(timer){clearTimeout(timer);timer=null;}
        if(active)await active;
        return flush();
    }
    return {record,flush,close,paths};
}
module.exports={createAlbionZvZDiagnosticLog,createDiagnosticRecord,
    MAX_FILE_BYTES,MAX_RECORD_BYTES,MAX_QUEUE,RETENTION_MS};
