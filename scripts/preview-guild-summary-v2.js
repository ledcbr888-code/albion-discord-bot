'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { loadRenderer } = require('../test/helpers/guild-summary-renderer');
const { selectAutoBattleGuildSummaryRows } = require('../battle-report-layout');
const { FONT_FAMILY } = require('../guild-summary-theme');
const fixture = require('../test/fixtures/guild-summary-v2.json');

async function main() {
    const root = path.join(__dirname, '..');
    const beforeRef = 'c8ac856373876d851af2e5ee91e3438dfb99a436';
    const before = loadRenderer(execFileSync('git', ['show', beforeRef + ':index.js'], { cwd: root, maxBuffer: 2_000_000 }).toString());
    const after = loadRenderer(fs.readFileSync(path.join(root, 'index.js'), 'utf8'));
    const out = path.join(root, 'docs', 'guild-summary-v2');
    fs.mkdirSync(out, { recursive: true });
    const manifest = { synthetic: true, beforeRef, afterFont: FONT_FAMILY, scenarios: [] };
    for (const scenario of fixture.scenarios) {
        const rows = selectAutoBattleGuildSummaryRows(fixture.guilds.slice(0, scenario.take), scenario.tracked);
        for (const [label, renderer] of [['before', before], ['after', after]]) {
            const image = await renderer.generateGuildSummaryImage(rows, { includeAlliance: true, includeAll: true });
            fs.writeFileSync(path.join(out, scenario.name + '-' + label + '.png'), image.attachment);
        }
        manifest.scenarios.push({ name: scenario.name, rows });
    }
    fs.writeFileSync(path.join(out, 'fixtures-and-font.json'), JSON.stringify(manifest, null, 2) + '\n');
    console.log('Generated before/after PNGs from unchanged selected rows; font=' + FONT_FAMILY);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
