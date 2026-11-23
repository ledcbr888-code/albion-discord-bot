'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {isConfiguredBattleLinkChannel}=require('../battlelink-channel-guard');

const source=fs.readFileSync(path.join(__dirname,'..','index.js'),'utf8');
function cut(start,end){
    const a=source.indexOf(start),b=source.indexOf(end,a+start.length);
    assert.ok(a>=0&&b>a,'missing production code boundaries: '+start);
    return source.slice(a,b);
}
const definitions=[
    cut('function createDefaultGuildConfig() {','function normalizeBanditGlobalVotes('),
    cut('function loadData() {','function saveData(options = {}) {'),
    cut('function saveData(options = {}) {','\nloadData();')
].join('\n');
function makeRuntime(initialFile=null){
    const files=new Map();
    if(initialFile)files.set('/data/tracking.json',initialFile);
    const writes=[];
    const fileIO={
        existsSync:p=>files.has(p),
        readFileSync:p=>files.get(p),
        writeFileSync:(p,v)=>files.set(p,v),
        renameSync:(a,b)=>{files.set(b,files.get(a));files.delete(a);},
        unlinkSync:p=>files.delete(p)
    };
    const env={
        fs:fileIO,DATA_FILE:'/data/tracking.json',ensureDataDirectory:()=>true,
        normalizeBotUsageStats:v=>v,normalizeBanditGlobalVotes:v=>v,
        queueSupabaseTrackingSave:value=>writes.push(['supabase',value]),
        queueGitHubTrackingSave:value=>writes.push(['github',value]),
        compactSupabaseState:v=>v,githubMirrorPolicy:{shouldMirror:()=>true,markQueued:()=>{}},
        SUPABASE_URL:'https://example.invalid',
        SUPABASE_SERVICE_ROLE_KEY:'fake-test-only',supabasePersistenceReady:true,
        GITHUB_DATA_TOKEN:'fake-test-only',GITHUB_DATA_REPO:'private-repo',
        githubPersistenceReady:true,
        botUsageSaveTimer:null,
        console:{log:()=>{},warn:()=>{},error:err=>{throw Error(String(err));}}
    };
    const factory=vm.runInNewContext(
        "let guildConfigs={};let legacyMigration=null;let banditGlobalVotes={};let botUsageStats={};"+ 
        "let botUsageTrackingStartedAt=Date.now();let botUsageDirty=false;"+definitions+
        "\n({loadData,saveData,normalizeGuildConfig,createDefaultGuildConfig,"+
        "getGuildConfigs:()=>guildConfigs,setGuildConfigs:v=>{guildConfigs=v;}})",
        env,{timeout:2000});
    return {...factory,files,writes};
}

test('serialized /battlelink setup channel survives restart and restores per server without setup again',()=>{
    const g1='110000000000000001',g2='110000000000000002';
    const channel='220000000000000001';
    const runtime=makeRuntime();
    runtime.setGuildConfigs({
        [g1]:{...runtime.createDefaultGuildConfig(),battleLinkChannelId:channel,
            players:['Alice'],autoBattles:[{guildId:g1,channelId:'223'}]},
        [g2]:{...runtime.createDefaultGuildConfig(),battleLinkChannelId:null}
    });
    assert.equal(runtime.saveData(),true);
    const saved=runtime.files.get('/data/tracking.json');
    assert.equal(JSON.parse(saved).guilds[g1].battleLinkChannelId,channel);
    assert.equal(runtime.writes.length,2,'saveData mirrors to Supabase and private GitHub when both are ready');
    for(const [_provider,snapshot] of runtime.writes){
        assert.equal(JSON.parse(snapshot).guilds[g1].battleLinkChannelId,channel);
    }
    // Simulate container restart or a move to a new host after the saved
    // Tracking payload has been restored. No slash command is invoked.
    const restarted=makeRuntime(saved);
    restarted.loadData();
    const restored=restarted.getGuildConfigs();
    assert.equal(restored[g1].battleLinkChannelId,channel);
    assert.equal(isConfiguredBattleLinkChannel(g1,channel,restored[g1]),true);
    assert.equal(isConfiguredBattleLinkChannel(g1,'220000000000000999',restored[g1]),false);
    assert.equal(isConfiguredBattleLinkChannel(g2,channel,restored[g2]),false);
    assert.deepEqual(Array.from(restored[g1].players),['Alice']);
    assert.equal(restored[g1].autoBattles.length,1);
});

test('the /battlelink remove setting persists after restart; no accidental all-channel mode',()=>{
    const guild='110000000000000001',channel='220000000000000001';
    const runtime=makeRuntime();
    runtime.setGuildConfigs({[guild]:{...runtime.createDefaultGuildConfig(),battleLinkChannelId:channel}});
    runtime.saveData();
    runtime.getGuildConfigs()[guild].battleLinkChannelId=null;
    runtime.saveData();
    const next=makeRuntime(runtime.files.get('/data/tracking.json'));
    next.loadData();
    assert.equal(next.getGuildConfigs()[guild].battleLinkChannelId,null);
    assert.equal(isConfiguredBattleLinkChannel(guild,channel,next.getGuildConfigs()[guild]),false);
});

test('startup restores Supabase Tracking before Discord login; compact storage retains BattleLink channel',()=>{
    const source=fs.readFileSync(path.join(__dirname,'..','index.js'),'utf8');
    const init=source.slice(source.indexOf('async function initializeTrackingPersistence()'),
        source.indexOf('function parseFameValue('));
    assert.match(init,/await pullSupabaseTrackingData\(\)/);
    const pull=source.slice(source.indexOf('async function pullSupabaseTrackingData()'),
        source.indexOf('function queueSupabaseTrackingSave('));
    assert.match(pull,/JSON\.stringify\(row\.payload, null, 2\)/);
    assert.match(pull,/fs\.renameSync\(tempFile, DATA_FILE\);\s*loadData\(\)/);
    const start=source.slice(source.lastIndexOf('initializeTrackingPersistence()'));
    assert.ok(start.indexOf('await restoreReportedBattleRows();')<start.indexOf('client.login(BOT_TOKEN)'));
    assert.match(source,/function compactSupabaseState\(payload\)[\s\S]*?const copy = JSON\.parse\(payload\)/);
    const compact=source.slice(source.indexOf('function compactSupabaseState('),
        source.indexOf('async function restoreReportedBattleRows('));
    assert.doesNotMatch(compact,/battleLinkChannelId/);
});
