'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {battleLink, createAlbionZvZSource}=require('../albionzvz-source');
const {buildAutoBattleLinkComponents}=require('../auto-battle-discord-ui');

const index=fs.readFileSync(path.join(__dirname,'..','index.js'),'utf8');
const start=index.indexOf('function autoBattleViewerLink(matchId) {');
const end=index.indexOf('// Source logging is observational:',start);
assert.ok(start>=0&&end>start,'Missing Auto-Battle viewer link helper');
const script=index.slice(start,end);
const makeViewerLink=vm.runInNewContext(script+'\nautoBattleViewerLink',{battleLink});

const id='531865730';
const expected='https://www.albionzvz.com/battles/'+id+'?server=asia';

test('all Auto-Battle viewer buttons target AlbionZvZ Asia, including Official fallback reports',()=>{
    const zvz=createAlbionZvZSource({env:{ALBIONZVZ_PRIMARY_ENABLED:'true'},http:{get:async()=>{throw Error('unexpected');}}});
    const simulatedOfficial={id,players:[{name:'One'}]};
    assert.equal(zvz.isPrimaryData(simulatedOfficial),false);
    // Viewer choice is independent of source identity: neither object is read.
    for(const detail of [simulatedOfficial,null,undefined]){
        const link=makeViewerLink(id,detail);
        assert.equal(link,'['+id+']('+expected+')');
        const component=buildAutoBattleLinkComponents(link)[0].components[0];
        assert.equal(component.url,expected);
        assert.equal(component.label,'🔗 เปิด Battle บน AlbionZvZ Asia');
        assert.equal(component.style,5);
    }
});

test('both Auto-Battle sending paths use the viewer link rather than source-dependent reportLink',()=>{
    assert.match(index,/buildAutoBattleLinkComponents\(autoBattleViewerLink\(matchId\)\)/);
    assert.match(index,/buildAutoBattleLinkComponents\(autoBattleViewerLink\(latestMatchId\)\)/);
    assert.doesNotMatch(index,/safeAutoBattleLink/);
    assert.doesNotMatch(index,/zvzSource\.reportLink\(/);
});

test('link-only change preserves true Primary/Official source reporting and fallback policy',()=>{
    assert.match(index,/zvzSource\.isPrimaryData\(officialBattle\) \? zvzSourceName : 'Official Albion API Asia'/);
    assert.match(index,/Source=AlbionZvZ Asia \| PrimaryReason=/);
    assert.match(index,/fallback = await fetchOfficialBattle\(matchId, options\)/);
    assert.match(index,/event:'FALLBACK'/);
    assert.match(index,/const apiData = options\.apiData \|\|/);
});

test('invalid viewer battle IDs cannot create a bogus Discord link; official URLs are still validated by button helper',()=>{
    assert.equal(makeViewerLink('not-an-id'),'not-an-id');
    assert.throws(()=>buildAutoBattleLinkComponents(makeViewerLink('not-an-id')));
    const original='https://albiononline.com/en/killboard/battles/'+id;
    const historical=buildAutoBattleLinkComponents('['+id+']('+original+')')[0].components[0];
    assert.equal(historical.label,'Battle · Official Albion');
    assert.equal(historical.url,original);
    assert.throws(()=>buildAutoBattleLinkComponents('['+id+'](https://example.invalid/battles/'+id+')'));
});
