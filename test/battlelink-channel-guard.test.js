'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {isConfiguredBattleLinkChannel}=require('../battlelink-channel-guard');

const g1='100000000000000001',g2='100000000000000002';
const c1='200000000000000001',c2='200000000000000002';

test('BattleLink only automatically detects links in the explicitly set channel',()=>{
    const config={battleLinkChannelId:c1};
    assert.equal(isConfiguredBattleLinkChannel(g1,c1,config),true);
    assert.equal(isConfiguredBattleLinkChannel(g1,c2,config),false);
    assert.equal(isConfiguredBattleLinkChannel(g1,c1,{battleLinkChannelId:null}),false);
    assert.equal(isConfiguredBattleLinkChannel(g1,c1,{}),false);
    assert.equal(isConfiguredBattleLinkChannel(g1,c1,null),false);
    assert.equal(isConfiguredBattleLinkChannel('',c1,config),false);
    assert.equal(isConfiguredBattleLinkChannel(null,c1,config),false);
    assert.equal(isConfiguredBattleLinkChannel(g1,null,config),false);
    assert.equal(isConfiguredBattleLinkChannel(g1,c1,{battleLinkChannelId:c2}),false);
});

test('multi-server settings are isolated; /battlelink remove disables all automatic detection',()=>{
    const perGuild=new Map([[g1,{battleLinkChannelId:c1}],[g2,{battleLinkChannelId:c2}]]);
    const check=(guildId,channelId)=>isConfiguredBattleLinkChannel(guildId,channelId,perGuild.get(guildId));
    assert.equal(check(g1,c1),true);
    assert.equal(check(g1,c2),false);
    assert.equal(check(g2,c2),true);
    assert.equal(check(g2,c1),false);
    perGuild.get(g1).battleLinkChannelId=null;
    assert.equal(check(g1,c1),false);
    assert.equal(check(g2,c2),true);
    perGuild.get(g1).battleLinkChannelId=c2;
    assert.equal(check(g1,c1),false);
    assert.equal(check(g1,c2),true);
});

test('real messageCreate BattleLink branch has no reply/API/embeds without setup or in wrong room',async()=>{
    const source=fs.readFileSync(path.join(__dirname,'..','index.js'),'utf8');
    const listener=source.slice(source.indexOf("client.on('messageCreate', async message => {"),
        source.indexOf("client.on('error', err =>",source.indexOf("client.on('messageCreate', async message => {")));
    assert.match(listener,/isConfiguredBattleLinkChannel\(/);
    assert.ok(listener.indexOf('isConfiguredBattleLinkChannel(')<listener.indexOf('message.content'));
    assert.ok(listener.indexOf('isConfiguredBattleLinkChannel(')<listener.indexOf('message.suppressEmbeds'));
    const invocations=[];
    const configByGuild=new Map([[g1,{battleLinkChannelId:c1}]]);
    const context={
        client:{on:(event,fn)=>{if(event==='messageCreate')context.handle=fn;}},
        guildContext:{run:async(_ctx,fn)=>fn()},
        console:{log:()=>{},warn:()=>{},error:e=>{throw e;}},
        processAvaImageMessage:async()=>false,
        getGuildConfig:(id)=>configByGuild.get(id)||null,
        isConfiguredBattleLinkChannel,
        battleUrlRateLimit:new Map(),
        BATTLE_URL_COOLDOWN_MS:12000,
        recordBotUsage:()=>invocations.push('usage'),
        processBattleReport:async()=>invocations.push('report')
    };
    vm.runInNewContext(listener,context,{timeout:2000});
    const deliver=async (guildId,channelId,content)=>{
        const message={
            guildId,channelId,channel:{id:channelId},id:'99',
            author:{bot:false},attachments:{size:0},content,
            suppressEmbeds:async()=>{invocations.push('suppress');},
            reply:async()=>{invocations.push('reply');return {channel:{id:channelId}};}
        };
        await context.handle(message);
    };
    const link='https://east.albionbb.com/battles/531812580';
    await deliver(g2,c2,link);
    await deliver(g1,c2,link);
    await deliver(g1,c1,'unrelated text');
    assert.deepEqual(invocations,[]);
    await deliver(g1,c1,link);
    assert.deepEqual(invocations,['suppress','usage','reply','report']);
    invocations.length=0;
    configByGuild.get(g1).battleLinkChannelId=null;
    await deliver(g1,c1,link);
    assert.deepEqual(invocations,[]);
});

test('slash setup/status/remove and manual /check battles stay available',()=>{
    const source=fs.readFileSync(path.join(__dirname,'..','index.js'),'utf8');
    assert.match(source,/if \(commandName === 'battlelink'\)[\s\S]*?if \(sub === 'setup'\)[\s\S]*?config\.battleLinkChannelId = channel\.id;/);
    assert.match(source,/if \(commandName === 'battlelink'\)[\s\S]*?if \(sub === 'remove'\)[\s\S]*?config\.battleLinkChannelId = null;/);
    assert.match(source,/if \(sub === 'battles'\)[\s\S]*?processBattleReport\(interaction\.options\.getString\('link_or_id'\), interaction\)/);
});
