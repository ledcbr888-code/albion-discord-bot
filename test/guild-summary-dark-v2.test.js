'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { MessagePayload, ButtonBuilder, Client } = require('discord.js');
const { renderGuildSummary, fitText, FONT_FAMILY, COLORS, COLUMNS } = require('../guild-summary-theme');
const { buildAutoBattleLinkComponents } = require('../auto-battle-discord-ui');
const { selectAutoBattleGuildSummaryRows } = require('../battle-report-layout');
const { loadRenderer } = require('./helpers/guild-summary-renderer');
const fixture = require('./fixtures/guild-summary-v2.json');
const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const integration = fs.readFileSync(path.join(__dirname, '..', 'battleboard-integration.js'), 'utf8');
const renderer = loadRenderer(source);

for (const [index, scenario] of fixture.scenarios.entries()) {
    test('real PNG, unchanged selection and data: ' + scenario.name, async () => {
        const original = structuredClone(fixture.guilds);
        const rows = selectAutoBattleGuildSummaryRows(fixture.guilds.slice(0, scenario.take), scenario.tracked);
        assert.equal(rows.length, [1, 4, 5, 6][index]);
        assert.ok(rows.every(r => fixture.guilds.includes(r)), 'keep original statistics objects');
        if (index === 1) assert.equal(rows.filter(r => r.name === 'KPA').length, 1);
        if (index >= 2) assert.equal(rows[4].name, 'PLAC');
        const selected = structuredClone(rows);
        const attachment = await renderer.generateGuildSummaryImage(rows, { includeAlliance: true, includeAll: true });
        assert.equal(attachment.name, 'guild-summary.png');
        const image = await loadImage(attachment.attachment);
        assert.equal(image.width, 1000);
        assert.equal(image.height, 48 + 76 + rows.length * 66, 'no blank or clipped final row');
        const canvas = createCanvas(image.width, image.height), ctx = canvas.getContext('2d');
        ctx.drawImage(image, 0, 0);
        const pixel = (x, y) => '#' + [...ctx.getImageData(x, y, 1, 1).data].slice(0, 3)
            .map(n => n.toString(16).padStart(2, '0')).join('').toUpperCase();
        assert.equal(pixel(0, 0), COLORS.background);
        assert.equal(pixel(30, 110), COLORS.table);
        if (rows.length > 1) assert.equal(pixel(30, 180), COLORS.alternate);
        assert.deepEqual(rows, selected);
        assert.deepEqual(fixture.guilds, original);
    });
}

test('installed sans font, exact six-column widths and measured ellipsis', () => {
    assert.ok(FONT_FAMILY);
    assert.deepEqual(COLUMNS.map(c => c.title), ['ALLIANCE', 'NAME', 'PLAYERS', 'KILLS', 'DEATHS', 'FAME']);
    assert.equal(COLUMNS.reduce((sum, c) => sum + c.width, 0), 936);
    const ctx = createCanvas(1000, 200).getContext('2d');
    for (const col of COLUMNS.slice(0, 2)) {
        ctx.font = `${col.weight} ${col.size}px "${FONT_FAMILY}"`;
        const value = col.key === 'name' ? fixture.guilds[5].name : fixture.guilds[5].alliance;
        const text = fitText(ctx, value, col.width - 24);
        assert.ok(text.endsWith('…'));
        assert.ok(ctx.measureText(text).width <= col.width - 24);
        assert.equal(fitText(ctx, 'PLAC', col.width - 24), 'PLAC');
    }
    assert.equal(renderer.formatFame(9876543210123), '9876.5B', 'use existing Fame formatting');
});

test('empty input and legacy manual row cap remain unchanged', async () => {
    assert.equal(await renderer.generateGuildSummaryImage([]), null);
    const image = await loadImage((await renderer.generateGuildSummaryImage(fixture.guilds)).attachment);
    assert.equal(image.height, 48 + 76 + 4 * 66);
});

test('existing Fame/Kills/Deaths tie breaks and tracked deduplication stay intact', () => {
    const rows = [
        { name: 'A', killFame: 100, kills: 2, deaths: 1 },
        { name: 'B', killFame: 100, kills: 2, deaths: 3 },
        { name: 'C', killFame: 100, kills: 4, deaths: 0 },
        { name: 'D', killFame: 200, kills: 0, deaths: 0 },
        { name: 'Tracked', killFame: 1, kills: 0, deaths: 0 }
    ];
    const selected = selectAutoBattleGuildSummaryRows(rows, [' tracked ', 'TRACKED', 'C']);
    assert.deepEqual(selected.map(r => r.name), ['D', 'C', 'B', 'A', 'Tracked']);
    assert.ok(selected.every(r => rows.includes(r)));
});

for (const [label, link, expected] of [
    ['AlbionZvZ direct Detail', '[531020000](https://www.albionzvz.com/battles/531020000?server=asia)', 'www.albionzvz.com'],
    ['Official fallback Detail', '[531020000](https://albiononline.com/en/killboard/battles/531020000)', 'albiononline.com']
]) {
    test('serializable Discord Link Button: ' + label, () => {
        const components = buildAutoBattleLinkComponents(link);
        const button = ButtonBuilder.from(components[0].components[0]).toJSON();
        assert.equal(button.style, 5);
        assert.equal(new URL(button.url).hostname, expected);
        assert.equal(button.custom_id, undefined);
        // Construct a client for local serialization only; never login/connect.
        const client = new Client({ intents: [] });
        const payload = new MessagePayload({ client }, { content: 'Battle ID: 531020000', components, flags: 4 }).resolveBody().body;
        assert.equal(payload.flags, 4, 'SuppressEmbeds as a second guard');
        assert.doesNotMatch(payload.content, /https?:|\]\(/);
        assert.deepEqual(payload.components, components);
    });
}

test('fallback sender keeps all weapon pages then Guild Summary; button only on first part', async () => {
    const start = source.indexOf('if (reportFiles.length > 0) {');
    const code = source.slice(start, source.indexOf('const reportSentAtMs', start));
    const files = [{ name: 'weapons-1.png' }, { name: 'weapons-2.png' }, { name: 'guild-summary.png' }];
    const components = buildAutoBattleLinkComponents('[1](https://albiononline.com/en/killboard/battles/1)');
    for (const reportFiles of [files, []]) {
        const sent = [];
        await vm.runInNewContext('(async()=>{' + code + '})()', {
            reportFiles, firstPartComponents: components, alertText: 'Battle ID: 1',
            result: { payload: { content: 'fallback statistics' } },
            sendReportPart: async payload => sent.push(payload)
        });
        assert.deepEqual(sent[0].components, components);
        assert.equal(sent[0].flags, 4);
        assert.doesNotMatch(sent[0].content, /https?:|\]\(/);
        assert.deepEqual(sent.flatMap(p => p.files || []), reportFiles);
        assert.ok(sent.slice(1).every(p => !p.components && !p.content));
    }
});

test('Battleboard sender forwards the same first-part button without changing continuation order', async () => {
    const start = integration.indexOf('if (files.length) {', integration.indexOf('async function deliver('));
    const end = integration.indexOf("record.status = 'sent'", start);
    const code = integration.slice(start, end);
    const components = buildAutoBattleLinkComponents('[1](https://albiononline.com/en/killboard/battles/1)');
    for (const files of [[{ name: 'weapons.png' }, { name: 'guild-summary.png' }], []]) {
        const sent = [];
        await vm.runInNewContext('(async()=>{' + code + '})()', {
            files, report: { payload: { components, content: 'fallback statistics' } },
            record: { partsSent: 0 }, alertText: 'Battle ID: 1', sendPart: async (i, payload) => sent.push(payload)
        });
        assert.deepEqual(sent[0].components, components);
        assert.equal(sent[0].flags, 4);
        assert.deepEqual(sent.flatMap(p => p.files || []), files);
        assert.ok(sent.slice(1).every(p => !p.components && !p.content));
    }
});

test('link row rejects unsupported URLs, and actual report callers retain validated Detail identity', () => {
    for (const link of ['https://www.albionzvz.com', '[1](https://evil.example/1)', '[1](https://evil@albiononline.com/1)']) {
        assert.throws(() => buildAutoBattleLinkComponents(link));
    }
    assert.match(source, /buildAutoBattleLinkComponents\(safeAutoBattleLink\(matchId, apiData\)\)/);
    assert.match(source, /buildAutoBattleLinkComponents\(safeAutoBattleLink\(latestMatchId, officialBattle\)\)/);
    assert.doesNotMatch(source.slice(source.indexOf('const alertText =', source.indexOf('async function checkAutoBattlesForGuild')), source.indexOf('const reportFiles =')), /\$\{safeAutoBattleLink/);
});
