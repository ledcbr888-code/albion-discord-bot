'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {createDiagnosticRecord,createAlbionZvZDiagnosticLog,
    MAX_FILE_BYTES,MAX_RECORD_BYTES,RETENTION_MS}=require('../albionzvz-diagnostic-log');
const {createAlbionZvZSource}=require('../albionzvz-source');

test('allowlist excludes secrets, player rows and raw HTTP responses',()=>{
    const line=createDiagnosticRecord({
        event:'FALLBACK',battleId:'531552720',guild:'Boar Army',
        reason:'INVALID_DETAIL',issue:'LIST_PLAYER_COUNT_MISMATCH',
        result:'FALLBACK_OK',providerPlayers:144,listExpected:156,officialPlayers:156,
        accessToken:'MY_SECRET_TOKEN',rawResponse:{players:[{name:'PLAYER_SECRET'}]}
    });
    assert.match(line,/"providerPlayers":144/);
    assert.match(line,/"officialPlayers":156/);
    assert.ok(Buffer.byteLength(line)<=MAX_RECORD_BYTES);
    assert.doesNotMatch(line,/MY_SECRET_TOKEN|PLAYER_SECRET|rawResponse|accessToken/);
    assert.equal(createDiagnosticRecord({event:'ARBITRARY',battleId:'531552720'}),null);
    assert.equal(createDiagnosticRecord({event:'FALLBACK',battleId:'BAD'}),null);
});

test('writer accepts max 30 events/min, <=128 memory entries, two files <=512KiB total',async()=>{
    const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'bossbot-diagnostic-'));
    let at=Date.now();
    try{
        const log=createAlbionZvZDiagnosticLog({directory:dir,now:()=>at,delayMs:10000});
        for(let minute=0;minute<240;minute++){
            let accepted=0;
            for(let i=0;i<60;i++){
                const recorded=log.record({
                    event:'FALLBACK',battleId:String(531000000+minute*60+i),
                    guild:'Boar Army',reason:'INVALID_DETAIL',result:'FALLBACK_OK',
                    providerPlayers:144,listExpected:156,officialPlayers:156,
                    issue:'LIST_PLAYER_COUNT_MISMATCH'
                });
                if(recorded)accepted++;
            }
            assert.equal(accepted,30);
            assert.equal(await log.flush(),true);
            at+=60000;
        }
        await log.close();
        const files=await fsp.readdir(dir);
        assert.ok(files.length<=2);
        let bytes=0;
        for(const file of files){
            const st=await fsp.stat(path.join(dir,file));
            assert.ok(st.size<=MAX_FILE_BYTES,file);
            bytes+=st.size;
            const rows=(await fsp.readFile(path.join(dir,file),'utf8')).trim().split('\n');
            assert.ok(rows.every(row=>{try{return Boolean(JSON.parse(row).battleId);}catch{return false;}}));
        }
        assert.ok(bytes>0 && bytes<=2*MAX_FILE_BYTES);
    }finally{await fsp.rm(dir,{recursive:true,force:true});}
});

test('duplicate failures in same minute are suppressed',async()=>{
    const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'bossbot-diagnostic-'));
    let at=Date.now();
    try{
        const log=createAlbionZvZDiagnosticLog({directory:dir,now:()=>at});
        const obj={event:'FALLBACK',battleId:'531552720',guild:'Boar Army',reason:'INVALID_DETAIL',result:'FALLBACK_OK'};
        assert.equal(log.record(obj),true);
        assert.equal(log.record(obj),false);
        at+=60000;
        assert.equal(log.record(obj),true);
        await log.close();
        const rows=(await fsp.readFile(path.join(dir,'albionzvz-detail.jsonl'),'utf8')).trim().split('\n');
        assert.equal(rows.length,2);
    }finally{await fsp.rm(dir,{recursive:true,force:true});}
});

test('expire 7-day files and truncate previous oversized data during the next write',async()=>{
    const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'bossbot-diagnostic-'));
    const at=Date.now();
    try{
        const recent=path.join(dir,'albionzvz-detail.jsonl');
        const old=path.join(dir,'albionzvz-detail.previous.jsonl');
        await fsp.writeFile(recent,Buffer.alloc(MAX_FILE_BYTES+200));
        await fsp.writeFile(old,'OLD\n');
        const date=new Date(at-RETENTION_MS-60000);
        await fsp.utimes(old,date,date);
        const log=createAlbionZvZDiagnosticLog({directory:dir,now:()=>at});
        log.record({event:'FALLBACK',battleId:'531552720',guild:'Boar Army',reason:'HTTP_404',result:'FALLBACK_OK'});
        assert.equal(await log.close(),true);
        const files=await fsp.readdir(dir);
        assert.deepEqual(files,['albionzvz-detail.jsonl']);
        const content=await fsp.readFile(recent,'utf8');
        assert.ok(content.length>0 && !content.includes('OLD'));
        assert.ok((await fsp.stat(recent)).size<=MAX_FILE_BYTES);
    }finally{await fsp.rm(dir,{recursive:true,force:true});}
});

test('diagnostic disk error is best-effort and does not crash or throw into reporting',async()=>{
    const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'bossbot-diagnostic-'));
    try{
        const blocker=path.join(dir,'not-a-folder');
        await fsp.writeFile(blocker,'blocked');
        let errors=0;
        const log=createAlbionZvZDiagnosticLog({
            directory:path.join(blocker,'logs'),
            onError:()=>{errors++;}
        });
        assert.equal(log.record({event:'FALLBACK',battleId:'531552720',reason:'INVALID_DETAIL'}),true);
        assert.equal(await log.close(),false);
        assert.equal(errors,1);
    }finally{await fsp.rm(dir,{recursive:true,force:true});}
});

test('source diagnostic exposes count mismatch without changing strict rejection or API cap',async()=>{
    let at=Date.now();
    const id='531552720';
    const row={id:Number(id),endTime:new Date(at-60000).toISOString(),
        startTime:new Date(at-150000).toISOString(),guildNames:['Boar Army'],
        totalParticipants:156,totalKills:4,totalFame:300000,
        guildMasses:[{guildId:'GID',name:'Boar Army',mass:156,kills:4}]};
    const battle={id:Number(id),startTime:row.startTime,endTime:row.endTime,
        totalParticipants:156,totalKills:4,totalFame:300000,
        players:Array.from({length:144},(_,i)=>({
            name:'Player '+i,guildName:'Boar Army',guildId:'GID',
            kills:0,deaths:0,killFame:0
        }))};
    let getRequests=0;
    const source=createAlbionZvZSource({
        env:{ALBIONZVZ_PRIMARY_ENABLED:'true'},now:()=>at,random:()=>0,log:()=>{},
        sleep:async ms=>{at+=ms;},
        http:{get:async url=>{
            getRequests++;
            return {data:url.endsWith('/api/battles')?{server:'asia',rows:[row]}:{server:'asia',battle}};
        }}
    });
    await source.discover('Boar Army','test',{guildId:'GID'});
    const diag={};
    assert.equal(await source.getDetail(id,'Boar Army','GID',diag),null);
    assert.equal(diag.reason,'INVALID_DETAIL');
    assert.equal(diag.providerPlayers,144);
    assert.equal(diag.providerExpected,156);
    assert.equal(diag.listExpected,156);
    assert.equal(diag.validationIssue,'LIST_PLAYER_COUNT_MISMATCH');
    assert.equal(getRequests,2);
    assert.equal(source.isPrimaryData(null),false);
});

test('only primary failure and capacity path record data; no DB/HTTP writes added',()=>{
    const index=fs.readFileSync(path.join(__dirname,'..','index.js'),'utf8');
    const mod=fs.readFileSync(path.join(__dirname,'..','albionzvz-diagnostic-log.js'),'utf8');
    const selector=index.slice(index.indexOf('async function fetchAutoBattlePreferredDetail('),
        index.indexOf('// Global safety net'));
    assert.match(selector,/event:'BUDGET_WAIT'/);
    assert.match(selector,/event:'CAPACITY_EXPIRED'/);
    assert.match(selector,/event:'FALLBACK'/);
    assert.ok(selector.indexOf("if (preferred) {")<selector.indexOf("event:'FALLBACK'"));
    assert.match(index,/\.bossbot-diagnostics/);
    assert.doesNotMatch(mod,/axios|fetch\(|https:|supabase|githubRequest/);
    assert.match(fs.readFileSync(path.join(__dirname,'..','.gitignore'),'utf8'),/\.bossbot-diagnostics\//);
});
