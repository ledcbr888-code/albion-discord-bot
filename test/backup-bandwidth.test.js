'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { configFingerprint, createGitHubMirrorPolicy, createTrafficMeter } = require('../backup-traffic-policy');
const { createReportedBattlesStore, mergeDeliveredRecords } = require('../reported-battles-store');

const serverId = '1165745441120452638';
const channelId = '1165745442026422396';
const fixture = () => ({
  version: 3, updatedAt: '2026-11-15T11:00:00Z',
  guilds: {
    [serverId]: {
      guilds: [{ name: 'PLAC' }],
      autoBattles: [{ targetGuild: 'PLAC', channelId }],
      battleboardState: {
        delivered: [{ key: '1:' + channelId, battleId: '1', channelId, status: 'sent' }],
        eventCursor: { after: '2026-11-15T11:00:00Z' },
        lastEventsPollSuccessLogAt: '2026-11-15T11:00:00Z',
      },
      processedBattles: ['1'],
      avaProcessedMessages: ['1571500616818229291'],
      banditAuto: [{ channelId, lastEventKey: '2026-11-15T10:00:00Z' }],
    },
  },
});
test('heartbeat, event cursor and delivered history do not trigger GitHub mirror', () => {
  const original = fixture(), updated = fixture();
  updated.updatedAt = '2026-11-15T11:55:00Z';
  updated.guilds[serverId].battleboardState.eventCursor.after = '2026-11-15T11:55:00Z';
  updated.guilds[serverId].battleboardState.delivered.push({ key: '2:' + channelId, status: 'sent' });
  updated.guilds[serverId].processedBattles.push('2');
  updated.guilds[serverId].avaProcessedMessages.push('2');
  assert.equal(configFingerprint(original), configFingerprint(updated));
});
test('config changes require a new emergency mirror', () => {
  let current = 0;
  const policy = createGitHubMirrorPolicy({ now: () => current, dailyIntervalMs: 24 * 60 * 60 * 1000 });
  const p = fixture();
  assert.equal(policy.shouldMirror(p), true);
  policy.markQueued(p);
  assert.equal(policy.shouldMirror(p), false);
  p.guilds[serverId].battleboardState.delivered.push({ key: '2:' + channelId, status: 'sent' });
  assert.equal(policy.shouldMirror(p), false);
  p.guilds[serverId].autoBattles[0].minFrames = 100000;
  assert.equal(policy.shouldMirror(p), true);
  policy.markQueued(p);
  current += 24 * 60 * 60 * 1000;
  assert.equal(policy.dueDaily(), true);
  assert.equal(policy.shouldMirror(p), true);
});
test('outbound request counters measure by destination without leaking request bodies', () => {
  let clock = 0;
  const lines = [];
  const meter = createTrafficMeter({ now: () => clock, log: x => lines.push(x), intervalMs: 1000 });
  meter.record('github','mirror-put', 2000000, 100, true);
  meter.record('supabase','full-snapshot-post', 500000, 100, false);
  clock = 1000;
  meter.flush();
  assert.ok(lines.some(x => x.includes('github/mirror-put') && x.includes('outgoingBytes=2000000')));
  assert.ok(lines.some(x => x.includes('supabase/full-snapshot-post') && x.includes('failures=1')));
  assert.ok(lines.every(x => !x.includes('TOKEN')));
});
test('per-channel composite identity does not collapse the same battle into one report', () => {
  const writes = [];
  const client = {
    async post(url, row) { writes.push(row); return { status: 201 }; },
    async get() { return { data: [] }; },
  };
  const store = createReportedBattlesStore({ axios: client, baseUrl: 'https://example.supabase.co', headers: () => ({}) });
  const r1 = { key: '102:' + channelId, battleId: '102', channelId, status: 'sent' };
  const r2 = { ...r1, key: '102:222222222222222222', channelId: '222222222222222222' };
  return Promise.all([store.save(serverId,r1),store.save(serverId,r2)]).then(() => {
    assert.equal(writes.length, 2);
    assert.notEqual(writes[0].channel_id, writes[1].channel_id);
  });
});
test('queued sending/sent updates are written in the original order', async () => {
  const statuses = [];
  const client = {
    async post(_url, row) {
      if (row.status === 'sending') await new Promise(resolve => setTimeout(resolve, 15));
      statuses.push(row.status);
      return { status: 201 };
    },
    async get() { return { data: [] }; },
  };
  const store = createReportedBattlesStore({ axios: client, baseUrl: 'https://example.supabase.co' });
  const record = { key: '100:' + channelId, battleId:'100', channelId, status:'sending' };
  const a = store.save(serverId, record);
  record.status = 'sent';
  const b = store.save(serverId, record);
  await Promise.all([a,b]);
  assert.deepEqual(statuses, ['sending','sent']);
});
test('row-load paginates and preserves original dedupe evidence', async () => {
  const rows = [1,2,3,4,5].map(id => ({ record: { key: id+':'+channelId, battleId:String(id), channelId,status:'sent' } }));
  const client = {
    async post() {},
    async get(_url, opts) {
      const off = opts.params.offset, count = opts.params.limit;
      return { data: rows.slice(off,off+count) };
    }
  };
  const store = createReportedBattlesStore({ axios: client, baseUrl: 'https://example.supabase.co', pageSize: 2 });
  const records = await store.loadServer(serverId);
  assert.equal(records.length, 5);
  assert.equal(new Set(records.map(x=>x.key)).size,5);
});
test('sent evidence wins over an older or interrupted sending record after restart', () => {
  const old = [{key:'100:'+channelId,battleId:'100',channelId,status:'sent',partsSent:2}];
  const newer = [{key:'100:'+channelId,battleId:'100',channelId,status:'sending',partsSent:0}];
  assert.equal(mergeDeliveredRecords(old,newer)[0].status,'sent');
});
test('Supabase failure does not accidentally mark a row as stored', async () => {
  let calls=0;
  const store=createReportedBattlesStore({
    axios:{get:async()=>({data:[]}), post:async()=>{calls++;throw Error('503')}},
    baseUrl:'https://example.supabase.co',
  });
  await assert.rejects(store.save(serverId,{key:'3:'+channelId,battleId:'3',channelId,status:'sent'}),/503/);
  assert.equal(calls,1);
});
