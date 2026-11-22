'use strict';

const vm = require('node:vm');
const { createCanvas } = require('@napi-rs/canvas');
const { AttachmentBuilder } = require('discord.js');
const { renderGuildSummary } = require('../../guild-summary-theme');

// Load only pure image functions, never index.js startup/login/timers or env.
function loadRenderer(source) {
    const slice = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
    const code = slice('function formatFame(', 'function centerString(') + '\n' +
        slice('function drawRoundRect(', 'function weaponIconCacheKey(') + '\n' +
        slice('async function generateGuildSummaryImage(', 'async function generatePlayerWeaponReportImage(');
    return vm.runInNewContext(code + '\n({ generateGuildSummaryImage, formatFame })',
        { createCanvas, AttachmentBuilder, renderGuildSummary });
}

module.exports = { loadRenderer };
