'use strict';

const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');

// Resolve installed fonts once. No font downloads or per-report registration.
const families = GlobalFonts.families;
const installed = new Set((Array.isArray(families) ? families : JSON.parse(families.toString()))
    .map(f => f.family));
const FONT_FAMILY = ['Noto Sans', 'DejaVu Sans', 'Arial', 'Liberation Sans']
    .find(name => installed.has(name)) || 'sans-serif';
const COLORS = Object.freeze({
    background: '#0E0C18', table: '#151320', alternate: '#171522',
    border: '#302C40', divider: '#292537', header: '#888398',
    name: '#E8E6F1', alliance: '#B68CFF', players: '#C4C2D2',
    kills: '#B78BFF', deaths: '#F57A91', fame: '#F6C35B'
});
const GEOMETRY = Object.freeze({ width: 1000, padding: 24, header: 76, row: 66, radius: 18 });
const COLUMNS = Object.freeze([
    { key: 'alliance', title: 'ALLIANCE', width: 155, size: 19, weight: 500, left: true },
    { key: 'name', title: 'NAME', width: 290, size: 23, weight: 600, left: true },
    { key: 'players', title: 'PLAYERS', width: 110, size: 23, weight: 700 },
    { key: 'kills', title: 'KILLS', width: 100, size: 23, weight: 700 },
    { key: 'deaths', title: 'DEATHS', width: 110, size: 23, weight: 700 },
    { key: 'fame', title: 'FAME', width: 171, size: 23, weight: 700 }
]);

function fitText(ctx, value, maxWidth) {
    const text = String(value).replace(/[\r\n\t]/g, ' ');
    if (ctx.measureText(text).width <= maxWidth) return text;
    const chars = Array.from(text);
    let low = 0, high = chars.length;
    while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (ctx.measureText(chars.slice(0, mid).join('') + '…').width <= maxWidth) low = mid;
        else high = mid - 1;
    }
    return chars.slice(0, low).join('') + '…';
}

// Receives rows already selected by the existing caller. Never sorts, filters,
// deduplicates, recomputes statistics, or caps the selected tracked Guilds.
function renderGuildSummary(rows, formatFame) {
    const { width, padding, header, row, radius } = GEOMETRY;
    const height = padding * 2 + header + rows.length * row;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    const tableWidth = width - padding * 2;
    const tableHeight = height - padding * 2;
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, width, height);
    ctx.beginPath();
    ctx.roundRect(padding, padding, tableWidth, tableHeight, radius);
    ctx.fillStyle = COLORS.table;
    ctx.fill();
    ctx.save();
    ctx.clip();
    rows.forEach((_, i) => {
        if (i % 2 === 1) {
            ctx.fillStyle = COLORS.alternate;
            ctx.fillRect(padding, padding + header + i * row, tableWidth, row);
        }
    });
    ctx.strokeStyle = COLORS.divider;
    ctx.lineWidth = 1;
    for (let i = 0; i < rows.length; i++) {
        const y = padding + header + i * row + 0.5;
        ctx.beginPath(); ctx.moveTo(padding, y); ctx.lineTo(width - padding, y); ctx.stroke();
    }
    ctx.textBaseline = 'middle';
    let x = padding + 8; // 936px grid inside the 952px table, 8px on each side.
    for (const col of COLUMNS) {
        ctx.textAlign = col.left ? 'left' : 'center';
        const textX = col.left ? x + 12 : x + col.width / 2;
        const maxWidth = col.width - 24;
        ctx.font = `600 15px "${FONT_FAMILY}"`;
        ctx.fillStyle = COLORS.header;
        ctx.fillText(col.title, textX, padding + header / 2, maxWidth);
        rows.forEach((g, i) => {
            const values = {
                alliance: String(g.alliance || '-').trim(), name: String(g.name || 'Unknown'),
                players: String(g.playersCount || 0), kills: String(g.kills || 0),
                deaths: String(g.deaths || 0), fame: formatFame(g.killFame || 0)
            };
            ctx.font = `${col.weight} ${col.size}px "${FONT_FAMILY}"`;
            ctx.fillStyle = COLORS[col.key];
            const text = col.left ? fitText(ctx, values[col.key], maxWidth) : values[col.key];
            // maxWidth preserves every numeric character even for extreme counts.
            ctx.fillText(text, textX, padding + header + (i + 0.5) * row, maxWidth);
        });
        x += col.width;
    }
    ctx.restore();
    ctx.beginPath();
    ctx.roundRect(padding + 1, padding + 1, tableWidth - 2, tableHeight - 2, radius - 1);
    ctx.strokeStyle = COLORS.border;
    ctx.lineWidth = 2;
    ctx.stroke();
    return canvas.toBuffer('image/png');
}

module.exports = { renderGuildSummary, fitText, FONT_FAMILY, COLORS, GEOMETRY, COLUMNS };
