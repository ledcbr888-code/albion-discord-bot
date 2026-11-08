'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const {
    commandBuilders,
    PRESETS,
    WEAPONS,
    getMetaWarnings,
    buildWeaponGridImage,
    buildRosterSmallIconImage
} = require('../cta');

function pngDimensions(buffer) {
    assert.ok(Buffer.isBuffer(buffer), 'image renderer should return a Buffer');
    assert.ok(buffer.length >= 24, 'PNG buffer should include its IHDR header');
    assert.equal(buffer.toString('hex', 0, 8), '89504e470d0a1a0a', 'output should be a PNG');
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

test('CTA max-player option supports the built-in 22-player AVA preset', () => {
    const command = commandBuilders.find(builder => builder.name === 'cta').toJSON();
    const maxPlayersOption = command.options.find(option => option.name === 'max_players');
    const ava = PRESETS.ava;
    const avaTotal = 1 + Object.values(ava.counts).reduce((sum, count) => sum + count, 0);

    assert.equal(maxPlayersOption.max_value, 22);
    assert.equal(avaTotal, 22);
    assert.ok(avaTotal <= maxPlayersOption.max_value);
});

test('DPS composition warnings identify missing and low DPS counts for larger groups', () => {
    const noDps = getMetaWarnings({ Tank: 3, DPS: 0, Support: 2, Heal: 2 }, 8, 20);
    const lowDps = getMetaWarnings({ Tank: 3, DPS: 2, Support: 2, Heal: 2 }, 9, 20);

    assert.ok(noDps.some(message => message.includes('ยังไม่มี DPS')));
    assert.ok(lowDps.some(message => message.includes('DPS น้อยกว่า 3 คน')));
});

test('every selectable CTA weapon has a matching local PNG asset', () => {
    const weaponNames = [...new Set(Object.values(WEAPONS).flat())];
    const missing = weaponNames.filter(name => {
        const filename = (name === 'Clarent Blade' ? 'ClarentBlade' : name) + '.png';
        return !fs.existsSync(path.join(__dirname, '..', 'weapon', filename));
    });

    assert.deepEqual(missing, []);
});

test('weapon selection grid keeps 16 choices per page within the reduced canvas size', async () => {
    const buffer = await buildWeaponGridImage(WEAPONS.DPS, new Map(), 'DPS', 0);
    const dimensions = pngDimensions(buffer);

    assert.deepEqual(dimensions, { width: 850, height: 818 });
    assert.ok(buffer.length < 2_000_000, 'weapon grid should stay below 2 MB');
});

test('22-player CTA roster renders to a compact four-column image', async () => {
    const slots = [{ role: 'Caller', weapon: WEAPONS.Caller[0], userId: 'caller', userName: 'Caller' }];
    for (const role of ['Tank', 'DPS', 'Support', 'Heal']) {
        const count = PRESETS.ava.counts[role];
        for (let index = 0; index < count; index++) {
            slots.push({
                role,
                weapon: WEAPONS[role][index % WEAPONS[role].length],
                userId: index % 2 === 0 ? role + '-' + index : null,
                userName: index % 2 === 0 ? 'Player ' + index : null
            });
        }
    }
    assert.equal(slots.length, 22);

    const buffer = await buildRosterSmallIconImage({
        id: 'cta-roster-image-regression-' + Date.now(),
        slots
    });
    const dimensions = pngDimensions(buffer);

    assert.deepEqual(dimensions, { width: 1100, height: 742 });
    assert.ok(buffer.length < 2_000_000, '22-player roster image should stay below 2 MB');
});