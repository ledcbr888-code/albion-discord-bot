'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { buildAutoBattleLinkComponents } = require('../auto-battle-discord-ui');
const index = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const integration = fs.readFileSync(path.join(__dirname, '..', 'battleboard-integration.js'), 'utf8');
const link = buildAutoBattleLinkComponents('[1](https://www.albionzvz.com/battles/1?server=asia)');
const files = [{ name: 'weapons.png' }, { name: 'guild-summary.png' }];
const alertText = 'Battle ID: 1\n⏱️ Delay (Battle จบ → ส่งรายงาน): 1 นาที';
const start = index.indexOf('if (reportFiles.length > 0) {');
const fallbackCode = index.slice(start, index.indexOf('const reportSentAtMs', start));
const begin = integration.indexOf('if (splitHeader) {', integration.indexOf('async function deliver('));
const primaryCode = integration.slice(begin, integration.indexOf("record.status = 'sent'", begin));
assert.ok(start >= 0 && begin >= 0);
function runFallback(reportFiles, sendReportPart) {
    return vm.runInNewContext('(async()=>{' + fallbackCode + '})()', {
        reportFiles, firstPartComponents: link, alertText,
        result: { payload: { content: 'fallback statistics' } }, sendReportPart
    });
}
function runPrimary(record, splitHeader, sendPart, reportFiles = files) {
    return vm.runInNewContext('(async()=>{' + primaryCode + '})()', {
        record, splitHeader, files: reportFiles, alertText,
        report: { payload: { components: link, content: 'fallback statistics' } },
        partsTotal: splitHeader ? reportFiles.length + 1 : Math.max(1, reportFiles.length),
        console: { log() {} }, battleId: '1', sendPart
    });
}
test('fallback sender delivers header before images, counts and labels parts in order', async () => {
    for (const list of [[], files.slice(0, 1), files]) {
        const sent = [];
        await runFallback(list, async (payload, label, number) => sent.push({ payload, label, number }));
        assert.equal(sent.length, list.length + 1);
        assert.equal(sent[0].payload.files, undefined);
        assert.equal(sent[0].payload.components, link);
        assert.equal(sent[0].payload.flags, 4);
        assert.equal(sent[0].payload.content, list.length ? alertText : alertText + '\n' + 'fallback statistics');
        assert.deepEqual(sent.map(x => x.number), Array.from({length: list.length + 1}, (_,i) => i+1));
        assert.deepEqual(sent.slice(1).map(x => x.payload.files[0]), list);
        assert.ok(sent.slice(1).every(x => !x.payload.components && !x.payload.content));
    }
    assert.match(index, /const totalDeliveryParts = 1 \+ reportFiles\.length/);
});
test('fallback stops at failed part without sending later images', async () => {
    for (const failAt of [1, 2]) {
        const attempted = [];
        await assert.rejects(runFallback(files, async (_, label, number) => {
            attempted.push(number);
            if (number === failAt) throw new Error('simulated failure');
        }), /simulated failure/);
        assert.deepEqual(attempted, failAt === 1 ? [1] : [1, 2]);
    }
});
test('primary new-layout retries retain header and image numbering without resending successful parts', async () => {
    const record = { auditVersion: 3, partsSent: 0 };
    const attempted = [];
    const send = async (number, payload) => {
        attempted.push(number);
        if (number === 2 && attempted.length === 2) throw new Error('simulated failure');
        if (number === 1) assert.equal(payload.files, undefined);
        else assert.equal(payload.files[0], files[number - 2]);
        record.partsSent = number;
    };
    await assert.rejects(runPrimary(record, true, send), /simulated failure/);
    assert.equal(record.partsSent, 1);
    await runPrimary(record, true, send);
    assert.deepEqual(attempted, [1, 2, 2, 3]);
    assert.equal(record.partsSent, 3);
});
test('primary pre-upgrade partial report preserves legacy numbering and first image already sent', async () => {
    const record = { auditVersion: 2, partsSent: 1 };
    const sent = [];
    await runPrimary(record, false, async (number, payload) => sent.push({number, payload}));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].number, 2);
    assert.equal(sent[0].payload.files[0], files[1]);
    assert.equal(sent[0].payload.components, undefined);
    assert.match(integration, /const splitHeader = record\.auditVersion === 3/);
    assert.match(integration, /record\.auditVersion = splitHeader \? 3 : 2/);
    assert.match(integration, /const partsTotal = splitHeader \? 1 \+ files\.length : Math\.max\(1, files\.length\)/);
});
