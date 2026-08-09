const {
    Client,
    GatewayIntentBits,
    SlashCommandBuilder,
    REST,
    Routes,
    EmbedBuilder,
    AttachmentBuilder,
    ChannelType
} = require('discord.js');

const cloudscraper = require('cloudscraper');
const axios = require('axios');
const cheerio = require('cheerio');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const fs = require('fs');
const path = require('path');
const express = require('express');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
app.get('/', (_, res) => res.status(200).send('Albion Discord Bot is running.'));
app.listen(PORT, () => console.log(`🌐 Web server listening on port ${PORT}`));

const BOT_TOKEN = String(process.env.BOT_TOKEN || '').trim();
const OWNER_ID = String(process.env.OWNER_ID || '').trim();
if (!BOT_TOKEN) {
    console.error('❌ BOT_TOKEN is missing. Set it in Render Environment Variables.');
    process.exit(1);
}

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

const DATA_FILE = path.join(__dirname, 'tracking.json');
let targetPlayers = [];
let targetGuilds = [];
let autoBattleConfigs = [];
const processedBattles = new Set();

function loadData() {
    try {
        if (!fs.existsSync(DATA_FILE)) return saveData();
        const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        targetPlayers = Array.isArray(data.players) ? data.players : [];
        targetGuilds = Array.isArray(data.guilds) ? data.guilds : [];
        autoBattleConfigs = Array.isArray(data.autoBattles) ? data.autoBattles : [];
        console.log(`📁 Tracking: ${targetGuilds.length} guilds, ${targetPlayers.length} players, ${autoBattleConfigs.length} auto configs`);
    } catch (err) {
        console.error('❌ tracking.json load error:', err.message);
    }
}
function saveData() {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify({ players: targetPlayers, guilds: targetGuilds, autoBattles: autoBattleConfigs }, null, 2));
    } catch (err) { console.error('❌ tracking.json save error:', err.message); }
}
loadData();

function parseFameValue(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    let s = String(value ?? '').trim().toUpperCase().replace(/,/g, '');
    if (!s) return 0;
    let m = 1;
    if (s.endsWith('B')) { m = 1e9; s = s.slice(0, -1); }
    else if (s.endsWith('M')) { m = 1e6; s = s.slice(0, -1); }
    else if (s.endsWith('K')) { m = 1e3; s = s.slice(0, -1); }
    const n = parseFloat(s.replace(/[^\d.-]/g, ''));
    return Number.isFinite(n) ? Math.round(n * m) : 0;
}
function formatFame(n) {
    n = Number(n) || 0;
    if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
    return n.toLocaleString();
}
function centerString(value, width) {
    const s = String(value);
    if (s.length >= width) return s.slice(0, width);
    const p = width - s.length;
    return ' '.repeat(Math.floor(p / 2)) + s + ' '.repeat(Math.ceil(p / 2));
}
function formatUTCTime(input) {
    if (!input) return 'N/A';
    const n = Number(input);
    const d = Number.isFinite(n) && String(input).trim() !== '' ? new Date(n < 1e10 ? n * 1000 : n) : new Date(input);
    if (Number.isNaN(d.getTime())) return 'N/A';
    const text = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Bangkok', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
    return `${text.replace(',', '')} +07`;
}

function normalizeAlbionItemId(raw) {
    if (!raw) return '';
    let value = '';
    if (typeof raw === 'object') {
        value = raw.itemId ?? raw.ItemId ?? raw.itemID ?? raw.ItemID ?? raw.type ?? raw.Type ?? raw.id ?? raw.Id ?? raw.itemType ?? raw.ItemType ?? raw.uniqueName ?? raw.UniqueName ?? raw.name ?? raw.Name ?? '';
    } else value = String(raw);
    value = String(value).trim();
    if (!value) return '';
    const urlMatch = value.match(/\/items\/([^/?#]+)/i) || value.match(/\/v1\/item\/([^/?#]+)/i);
    if (urlMatch) {
        try { value = decodeURIComponent(urlMatch[1]); } catch (_) {}
    }
    return value.replace(/\s+/g, '_').replace(/\.png(?:\?.*)?$/i, '').replace(/@(\d+)Q\d+/i, '@$1').trim();
}
function isOffhandItemId(id) {
    const s = normalizeAlbionItemId(id).toUpperCase();
    return !s || s.includes('OFF_') || s.includes('_OFFHAND') || s.includes('OFFHAND') || s.includes('SHIELD') || s.includes('TORCH') || s.includes('TOME') || s.includes('BOOK') || s.includes('ORB') || s.includes('HORN');
}
function isWeaponItemId(id) {
    const s = normalizeAlbionItemId(id).toUpperCase();
    if (!s || isOffhandItemId(s)) return false;
    return s.includes('MAIN_') || s.includes('_2H_') || s.startsWith('2H_') || s.includes('CROSSBOW') || s.includes('BOW') || s.includes('STAFF') || s.includes('SWORD') || s.includes('MACE') || s.includes('AXE') || s.includes('HAMMER') || s.includes('SPEAR') || s.includes('DAGGER') || s.includes('ARCANE') || s.includes('HOLY') || s.includes('NATURE') || s.includes('FIRE') || s.includes('FROST') || s.includes('CURSED') || s.includes('GLAIVE') || s.includes('SCYTHE') || s.includes('QUARTERSTAFF') || s.includes('WAR_GLOVE') || s.includes('FIST') || s.includes('REAVER');
}
function isBadEquipmentItem(id) {
    const s = normalizeAlbionItemId(id).toUpperCase();
    return !s || s.includes('BAG') || s.includes('CAPE') || s.includes('HEAD') || s.includes('ARMOR') || s.includes('SHOES') || s.includes('FOOD') || s.includes('POTION') || s.includes('MOUNT') || isOffhandItemId(s);
}
function extractMainHandFromObject(obj) {
    if (!obj || typeof obj !== 'object') return '';
    const candidates = [obj.MainHand, obj.mainHand, obj.MAINHAND, obj.mainhand, obj.Mainhand, obj.Equipment?.MainHand, obj.equipment?.MainHand, obj.Equipment?.mainHand, obj.equipment?.mainHand, obj.weapon, obj.Weapon, obj.weaponId, obj.WeaponId, obj.mainHandItem, obj.MainHandItem];
    for (const raw of candidates) {
        const id = normalizeAlbionItemId(raw);
        if (id && isWeaponItemId(id) && !isBadEquipmentItem(id)) return id;
    }
    const equipment = obj.Equipment || obj.equipment;
    if (equipment && typeof equipment === 'object') {
        for (const [key, value] of Object.entries(equipment)) {
            if (!/main.?hand|weapon/i.test(key)) continue;
            const id = normalizeAlbionItemId(value);
            if (id && isWeaponItemId(id)) return id;
        }
    }
    return '';
}
function extractMainHandFromRow($, row) {
    const candidates = [];
    $(row).find('img, [data-item-id], [data-itemid], [data-type], [data-unique-name], a[href*="/items/"]').each((index, el) => {
        const $el = $(el);
        const attrs = [$el.attr('src'), $el.attr('data-src'), $el.attr('data-original'), $el.attr('data-item-id'), $el.attr('data-itemid'), $el.attr('data-type'), $el.attr('data-unique-name'), $el.attr('href')].filter(Boolean);
        let id = '';
        for (const raw of attrs) { const x = normalizeAlbionItemId(raw); if (x) { id = x; break; } }
        if (!id || !isWeaponItemId(id)) return;
        const parent = $el.closest('td,div,li,a').first();
        const context = `${$el.attr('alt') || ''} ${$el.attr('title') || ''} ${$el.attr('class') || ''} ${$el.attr('data-slot') || ''} ${$el.attr('data-equipment-slot') || ''} ${parent.text()} ${parent.attr('class') || ''} ${parent.attr('data-slot') || ''}`.toLowerCase();
        let score = 10 - index * 0.1;
        if (/main[\s_-]?hand/.test(context)) score += 100;
        if (/weapon/.test(context)) score += 25;
        if (/off[\s_-]?hand|shield|torch|tome|book|orb|horn/.test(context)) score -= 100;
        candidates.push({ id, score });
    });
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0]?.id || '';
}

async function fetchAlbionBBPage(matchId) {
    const url = `https://east.albionbb.com/battles/${encodeURIComponent(matchId)}`;
    try {
        return await cloudscraper.get({ url, timeout: 20000, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151 Safari/537.36', Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' } });
    } catch (err) { console.error('❌ AlbionBB fetch error:', err.message); return null; }
}
function readCellNumber(v) { return parseInt(String(v || '').replace(/[^\d.-]/g, ''), 10) || 0; }
function parseDataFromHTML(html) {
    const $ = cheerio.load(html);
    const players = [];
    const battleTime = $('time[datetime]').attr('datetime') || $('time').first().text().trim() || $('.battle-time').first().text().trim() || null;
    $('table').each((_, table) => {
        const headers = [];
        $(table).find('thead tr').first().find('th,td').each((__, cell) => headers.push($(cell).text().replace(/\s+/g, ' ').trim().toLowerCase()));
        if (!headers.length) return;
        const find = (...names) => names.map(n => headers.indexOf(n)).find(i => i >= 0) ?? -1;
        const nameIndex = find('name', 'player', 'player name');
        const guildIndex = find('guild', 'guild name', 'alliance');
        const killIndex = find('kills', 'kill');
        const deathIndex = find('deaths', 'death');
        const fameIndex = find('fame', 'kill fame', 'killfame');
        const damageIndex = headers.findIndex(h => /damage|dmg/.test(h));
        const healingIndex = headers.findIndex(h => /heal|healing/.test(h));
        $(table).find('tbody tr').each((__, row) => {
            const cells = $(row).find('td').map((___, td) => $(td).text().replace(/\s+/g, ' ').trim()).get();
            if (!cells.length) return;
            const name = nameIndex >= 0 ? cells[nameIndex] : cells[0] || '';
            if (!name) return;
            players.push({ name, guild: guildIndex >= 0 ? cells[guildIndex] || '' : '', kills: killIndex >= 0 ? readCellNumber(cells[killIndex]) : 0, deaths: deathIndex >= 0 ? readCellNumber(cells[deathIndex]) : 0, fame: fameIndex >= 0 ? parseFameValue(cells[fameIndex]) : 0, damage: damageIndex >= 0 ? parseFameValue(cells[damageIndex]) : 0, healing: healingIndex >= 0 ? parseFameValue(cells[healingIndex]) : 0, weapon: extractMainHandFromRow($, row) });
        });
    });
    return { players, battleTime };
}
function parseNextData(html) { const $ = cheerio.load(html); const raw = $('script#__NEXT_DATA__').html(); if (!raw) return null; try { return JSON.parse(raw); } catch (_) { return null; } }
function findTimeInNextData(obj) {
    if (!obj || typeof obj !== 'object') return null;
    const keys = ['startTime', 'endTime', 'time', 'timestamp', 'date', 'createdAt'];
    if (Array.isArray(obj)) { for (const x of obj) { const r = findTimeInNextData(x); if (r) return r; } return null; }
    for (const [k, v] of Object.entries(obj)) { if (keys.includes(k) && v) return v; if (v && typeof v === 'object') { const r = findTimeInNextData(v); if (r) return r; } }
    return null;
}
function objectToPlayer(obj) {
    if (!obj || typeof obj !== 'object') return null;
    const name = obj.name ?? obj.Name ?? obj.playerName ?? obj.PlayerName;
    if (!name || typeof name !== 'string') return null;
    return { name, guild: String(obj.guildName ?? obj.GuildName ?? obj.guild ?? obj.Guild ?? ''), kills: Number(obj.kills ?? obj.Kills ?? obj.kill ?? obj.Kill ?? 0) || 0, deaths: Number(obj.deaths ?? obj.Deaths ?? obj.death ?? obj.Death ?? 0) || 0, fame: parseFameValue(obj.killFame ?? obj.killfame ?? obj.fame ?? obj.Fame ?? obj.KillFame), damage: parseFameValue(obj.damage ?? obj.Damage ?? obj.totalDamage ?? obj.TotalDamage), healing: parseFameValue(obj.healing ?? obj.Healing ?? obj.totalHealing ?? obj.TotalHealing), weapon: extractMainHandFromObject(obj) };
}
function findPlayerArrays(obj) {
    const out = [];
    const walk = value => {
        if (!value || typeof value !== 'object') return;
        if (Array.isArray(value)) { if (value.some(x => x && typeof x === 'object' && (x.name || x.Name || x.playerName || x.PlayerName))) out.push(value); for (const x of value) walk(x); return; }
        for (const x of Object.values(value)) walk(x);
    };
    walk(obj); return out;
}

// Albion's gameinfo endpoint is an undocumented service used by the official website.
// For Asia, try Singapore first. Keep the timeout short so a slow endpoint cannot block AlbionBB.
async function fetchOfficialBattle(matchId) {
    if (!/^\d+$/.test(String(matchId))) return null;
    const urls = [
        `https://gameinfo-sgp.albiononline.com/api/gameinfo/battles/${encodeURIComponent(matchId)}`,
        `https://gameinfo.albiononline.com/api/gameinfo/battles/${encodeURIComponent(matchId)}`
    ];
    for (const url of urls) {
        try {
            const response = await axios.get(url, { timeout: 5000, validateStatus: s => s >= 200 && s < 300, headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
            if (response.data) return response.data;
        } catch (err) {
            const reason = err.code === 'ECONNABORTED' ? 'timeout' : err.response ? `HTTP ${err.response.status}` : err.message;
            console.log(`⚠️ Official API skipped: ${reason}`);
        }
    }
    return null;
}
function getApiPlayers(apiData) {
    if (!apiData?.players) return [];
    const list = Array.isArray(apiData.players) ? apiData.players : Object.values(apiData.players);
    return list.map(objectToPlayer).filter(Boolean);
}
function mergePlayerRecords(...lists) {
    const map = new Map();
    for (const list of lists) for (const p of list || []) {
        if (!p?.name) continue;
        const key = p.name.toLowerCase();
        if (!map.has(key)) map.set(key, { ...p });
        else {
            const x = map.get(key);
            x.guild ||= p.guild; x.kills = Math.max(x.kills, p.kills); x.deaths = Math.max(x.deaths, p.deaths); x.fame = Math.max(x.fame, p.fame); x.damage = Math.max(x.damage, p.damage); x.healing = Math.max(x.healing, p.healing); if (!x.weapon && p.weapon) x.weapon = p.weapon;
        }
    }
    return [...map.values()];
}

// Render service occasionally returns 404 for an enchanted/artifact identifier.
// We therefore download the image ourselves and retry the base item without @enchant.
async function loadWeaponImage(itemId) {
    const id = normalizeAlbionItemId(itemId);
    if (!id || !isWeaponItemId(id)) return null;
    const base = id.replace(/@\d+$/i, '');
    const candidates = [...new Set([id, base])];
    for (const candidate of candidates) {
        const url = `https://render.albiononline.com/v1/item/${candidate}.png?size=80`;
        try {
            const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 7000, validateStatus: s => s >= 200 && s < 300, headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'image/png,image/*;q=0.8,*/*;q=0.5' } });
            if (response.data) return await loadImage(Buffer.from(response.data));
        } catch (_) { /* try next candidate */ }
    }
    console.warn(`⚠️ Weapon image unavailable: ${id}`);
    return null;
}

async function generateTopPerformanceImage(players) {
    const width = 620, cardHeight = 78, gap = 10, padding = 15;
    const height = padding * 2 + players.length * cardHeight + Math.max(0, players.length - 1) * gap;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#bda289'; ctx.fillRect(0, 0, width, height);
    for (let i = 0; i < players.length; i++) {
        const p = players[i], y = padding + i * (cardHeight + gap), cardWidth = width - padding * 2;
        ctx.fillStyle = '#a28c78'; ctx.beginPath(); ctx.roundRect(padding, y, cardWidth, cardHeight, 10); ctx.fill();
        const percent = Math.max(0, Math.min(100, Number(p.percent) || 0));
        if (percent) { ctx.fillStyle = p.type === 'heal' ? '#21b293' : '#ff4d6d'; ctx.beginPath(); ctx.roundRect(padding, y, Math.min(cardWidth, Math.max(80, cardWidth * percent / 100)), cardHeight, 10); ctx.fill(); }
        const img = await loadWeaponImage(p.weapon);
        if (img) ctx.drawImage(img, padding + 9, y + 9, 60, 60);
        ctx.fillStyle = '#000'; ctx.font = 'bold 18px sans-serif';
        let name = `${p.guild ? `[${p.guild}] ` : ''}${p.name}`; if (name.length > 35) name = `${name.slice(0, 32)}...`;
        ctx.fillText(name, padding + 80, y + 32);
        ctx.font = 'bold 15px sans-serif'; ctx.fillStyle = '#111';
        ctx.fillText(`${p.type === 'heal' ? 'HEAL' : 'DMG'}  ${Number(p.value || 0).toLocaleString()} (${percent}%)`, padding + 80, y + 56);
    }
    return new AttachmentBuilder(canvas.toBuffer('image/png'), { name: 'top-performance.png' });
}

function extractMatchId(input) {
    const value = String(input || '').trim();
    if (!value) throw new Error('Match ID ว่าง');
    if (/^https?:\/\//i.test(value)) {
        const m = value.match(/\/battles\/([^/?#]+)/i);
        if (!m) throw new Error('ไม่สามารถอ่าน Match ID จากลิงก์ได้');
        return m[1];
    }
    return value;
}

async function buildBattleReportPayload(input, customGuilds = targetGuilds) {
    const matchId = extractMatchId(input);
    const html = await fetchAlbionBBPage(matchId);
    let htmlPlayers = [], battleTime = null, nextPlayers = [];
    if (html) {
        const parsed = parseDataFromHTML(html);
        htmlPlayers = parsed.players; battleTime = parsed.battleTime;
        const next = parseNextData(html);
        if (next) { battleTime ||= findTimeInNextData(next); nextPlayers = findPlayerArrays(next).flatMap(a => a.map(objectToPlayer).filter(Boolean)); }
    }
    let apiData = null;
    let allPlayers = mergePlayerRecords(htmlPlayers, nextPlayers);
    // Only call gameinfo when AlbionBB/Next data did not contain the tracked player.
    const tracked = p => customGuilds.some(g => p.guild?.toLowerCase() === g.toLowerCase()) || targetPlayers.some(n => p.name.toLowerCase() === n.toLowerCase());
    if (!allPlayers.some(tracked)) apiData = await fetchOfficialBattle(matchId);
    allPlayers = mergePlayerRecords(allPlayers, getApiPlayers(apiData));
    battleTime ||= apiData?.startTime || apiData?.endTime || null;
    if (!allPlayers.length) throw new Error('ไม่พบข้อมูลผู้เล่นจาก AlbionBB หรือ Gameinfo API');

    const rows = allPlayers.filter(p => {
        const explicit = targetPlayers.some(n => n.toLowerCase() === p.name.toLowerCase());
        const guild = customGuilds.some(g => g.toLowerCase() === String(p.guild || '').toLowerCase());
        return explicit || guild;
    });
    const selected = rows.length ? rows : allPlayers;
    const totalKills = rows.reduce((n, p) => n + p.kills, 0);
    const totalDeaths = rows.reduce((n, p) => n + p.deaths, 0);
    const totalFame = rows.reduce((n, p) => n + p.fame, 0);

    const sorted = [...selected].sort((a, b) => b.fame - a.fame || b.kills - a.kills);
    const lines = [];
    for (const p of sorted) lines.push(`${String(p.name).slice(0, 19).padEnd(20)}${centerString(p.kills, 8)}${centerString(p.deaths, 8)}${centerString(formatFame(p.fame), 10)}`);
    const header = `\x1b[1;36m⚔️ ALBIONBB BATTLE REPORT\x1b[0m | \x1b[1;33m🆔 ${matchId}\x1b[0m\n\x1b[1;33m🕒 Time:\x1b[0m ${formatUTCTime(battleTime)}\n${'='.repeat(46)}\n\x1b[1;37m${'Name'.padEnd(20)}${centerString('Kills', 8)}${centerString('Deaths', 8)}${centerString('Fame', 10)}\x1b[0m\n${'-'.repeat(46)}\n`;
    let body = lines.slice(0, 35).map((line, i) => {
        const p = sorted[i]; return `${line.replace(/^(.*?)(\s{0,20})$/, '$1$2')}\n`;
    }).join('');
    if (sorted.length > 35) body += `\x1b[30m... +${sorted.length - 35} more players\x1b[0m\n`;
    const executioner = [...selected].sort((a, b) => b.kills - a.kills)[0];
    const feeder = [...selected].sort((a, b) => b.deaths - a.deaths)[0];
    const awards = `\x1b[30m${'-'.repeat(46)}\x1b[0m\n\x1b[1;35m🏆 BATTLE AWARDS\x1b[0m\n${executioner?.kills ? `\x1b[1;32m🎯 Executioner:\x1b[0m ${executioner.name} (${executioner.kills} Kills)\n` : ''}${feeder?.deaths ? `\x1b[1;31m💀 Feeder:\x1b[0m ${feeder.name} (${feeder.deaths} Deaths)\n` : ''}`;
    const footer = `\x1b[30m${'-'.repeat(46)}\x1b[0m\n\x1b[1;37m${'TOTAL'.padEnd(20)}\x1b[32m${centerString(totalKills, 8)}\x1b[31m${centerString(totalDeaths, 8)}\x1b[33m${centerString(formatFame(totalFame), 10)}\x1b[0m\n`;
    const report = '```ansi\n' + header + (rows.length ? body : '\x1b[30m(ไม่พบกิลด์หรือผู้เล่นที่ติดตามในไฟต์นี้)\x1b[0m\n') + footer + awards + '```';

    const performers = [...selected].filter(p => p.damage > 0 || p.healing > 0).sort((a, b) => b.damage + b.healing - (a.damage + a.healing)).slice(0, 5);
    let attachment = null;
    if (performers.length) {
        const maxD = Math.max(1, ...performers.map(p => p.damage));
        const maxH = Math.max(1, ...performers.map(p => p.healing));
        attachment = await generateTopPerformanceImage(performers.map(p => { const heal = p.healing > p.damage; const value = heal ? p.healing : p.damage; return { ...p, value, type: heal ? 'heal' : 'damage', percent: Math.round(value / (heal ? maxH : maxD) * 100) }; }));
    }
    return { totalFame, payload: { content: report, files: attachment ? [attachment] : [] } };
}

async function processBattleReport(input, targetContext, isMessage = false) {
    try {
        const result = await buildBattleReportPayload(input);
        if (isMessage) await targetContext.edit(result.payload); else await targetContext.editReply(result.payload);
    } catch (err) {
        console.error('❌ Process battle report error:', err);
        const msg = `❌ เกิดข้อผิดพลาดในการประมวลผลไฟต์: \`${err.message}\``;
        if (isMessage) await targetContext.edit(msg); else await targetContext.editReply(msg);
    }
}

async function checkMarketPrice(itemId, city, interaction) {
    try {
        const [priceRes, historyRes] = await Promise.all([
            axios.get(`https://east.albion-online-data.com/api/v2/stats/prices/${encodeURIComponent(itemId)}.json?locations=${encodeURIComponent(city)}`, { timeout: 8000 }).catch(() => null),
            axios.get(`https://east.albion-online-data.com/api/v2/stats/history/${encodeURIComponent(itemId)}.json?locations=${encodeURIComponent(city)}&time-scale=24`, { timeout: 8000 }).catch(() => null)
        ]);
        if (!priceRes?.data?.length) return interaction.editReply(`❌ ไม่พบข้อมูลราคาของไอเทม: \`${itemId}\` ที่เมือง \`${city}\``);
        const p = priceRes.data[0];
        const history = historyRes?.data?.[0]?.data || [];
        const volume = history.length ? history[history.length - 1].item_count || 0 : 0;
        const embed = new EmbedBuilder().setColor(0x9b59b6).setTitle(`🏷️ Price Check: ${city} (Asia)`).setDescription(`**Item ID:** \`${itemId}\``).setThumbnail(`https://render.albiononline.com/v1/item/${itemId}.png`).addFields(
            { name: '💰 Buy Order', value: `${Number(p.buy_price_max || 0).toLocaleString()} Silver`, inline: true },
            { name: '🏷️ Sell Order', value: `${Number(p.sell_price_min || 0).toLocaleString()} Silver`, inline: true },
            { name: '📊 Volume 24h', value: `${Number(volume).toLocaleString()} ชิ้น`, inline: true }
        ).setTimestamp();
        await interaction.editReply({ embeds: [embed] });
    } catch (err) { await interaction.editReply(`❌ Price error: ${err.message}`); }
}

const commands = [
    new SlashCommandBuilder().setName('check').setDescription('ระบบตรวจสอบสถิติ').addSubcommand(s => s.setName('battles').setDescription('เช็กไฟต์').addStringOption(o => o.setName('link_or_id').setDescription('Match ID หรือ AlbionBB link').setRequired(true))).addSubcommand(s => s.setName('guilds').setDescription('กิลด์ที่ติดตาม')).addSubcommand(s => s.setName('members').setDescription('ผู้เล่นที่ติดตาม')),
    new SlashCommandBuilder().setName('stat').setDescription('ดูข้อมูลผู้เล่น').addStringOption(o => o.setName('player').setDescription('ชื่อผู้เล่น').setRequired(true)),
    new SlashCommandBuilder().setName('guild').setDescription('ดูข้อมูลกิลด์').addStringOption(o => o.setName('name').setDescription('ชื่อกิลด์').setRequired(true)),
    new SlashCommandBuilder().setName('mvp').setDescription('หา MVP/Executioner/Feeder').addStringOption(o => o.setName('link_or_id').setDescription('Match ID หรือ link').setRequired(true)),
    new SlashCommandBuilder().setName('ราคา').setDescription('เช็กราคาไอเทม').addStringOption(o => o.setName('name').setDescription('Item ID').setRequired(true)).addStringOption(o => o.setName('city').setDescription('เมือง').addChoices('Black Market','Martlock','Bridgewatch','Caerleon','Lymhurst','Fort Sterling','Thetford').setRequired(false)).addIntegerOption(o => o.setName('tier').setDescription('Tier').addChoices(...[1,2,3,4,5,6,7,8].map(x => ({name:`T${x}`,value:x}))).setRequired(false)).addIntegerOption(o => o.setName('enhancement').setDescription('Enhancement 0-4').addChoices(...[0,1,2,3,4].map(x => ({name:`.${x}`,value:x}))).setRequired(false)),
    new SlashCommandBuilder().setName('regear').setDescription('ดูอุปกรณ์ผู้เล่นที่ตาย').addStringOption(o => o.setName('link_or_id').setDescription('Match ID หรือ link').setRequired(true)).addStringOption(o => o.setName('player').setDescription('ชื่อผู้เล่น').setRequired(true)),
    new SlashCommandBuilder().setName('add').setDescription('เพิ่มรายการติดตาม').addSubcommand(s => s.setName('guild').setDescription('เพิ่มกิลด์').addStringOption(o => o.setName('name').setDescription('ชื่อกิลด์').setRequired(true))).addSubcommand(s => s.setName('player').setDescription('เพิ่มผู้เล่น').addStringOption(o => o.setName('name').setDescription('ชื่อผู้เล่น').setRequired(true))),
    new SlashCommandBuilder().setName('remove').setDescription('ลบรายการติดตาม').addSubcommand(s => s.setName('guild').setDescription('ลบกิลด์').addStringOption(o => o.setName('name').setDescription('ชื่อกิลด์').setRequired(true))).addSubcommand(s => s.setName('player').setDescription('ลบผู้เล่น').addStringOption(o => o.setName('name').setDescription('ชื่อผู้เล่น').setRequired(true))),
    new SlashCommandBuilder().setName('autobattle').setDescription('แจ้งเตือนไฟต์อัตโนมัติ').addChannelOption(o => o.setName('channel').setDescription('ห้องแจ้งเตือน').addChannelTypes(ChannelType.GuildText).setRequired(true)).addStringOption(o => o.setName('guild').setDescription('กิลด์').setRequired(true)).addStringOption(o => o.setName('min_fame').setDescription('เช่น 300K หรือ 1M').setRequired(true)),
    new SlashCommandBuilder().setName('shutdown').setDescription('ปิดบอท (Owner เท่านั้น)')
].map(x => x.toJSON());

async function checkAutoBattles() {
    if (!autoBattleConfigs.length) return;
    try {
        const html = await cloudscraper.get({ url: 'https://east.albionbb.com/battles', timeout: 12000, headers: { 'User-Agent': 'Mozilla/5.0' } });
        const $ = cheerio.load(html);
        const ids = [];
        $('a[href*="/battles/"]').each((_, el) => { const m = String($(el).attr('href') || '').match(/\/battles\/([^/?#]+)/i); if (m && !ids.includes(m[1])) ids.push(m[1]); });
        for (const matchId of ids.slice(0, 5)) {
            if (processedBattles.has(matchId)) continue;
            for (const cfg of autoBattleConfigs) {
                try {
                    const result = await buildBattleReportPayload(matchId, [cfg.targetGuild]);
                    if (result.totalFame >= cfg.minFame) {
                        const channel = await client.channels.fetch(cfg.channelId).catch(() => null);
                        if (channel) { await channel.send(`🚨 **Auto-Battle Alert!** กิลด์ **${cfg.targetGuild}** Fame รวม **${formatFame(result.totalFame)}**`); await channel.send(result.payload); }
                    }
                } catch (e) { console.error(`⚠️ Auto-check ${matchId}:`, e.message); }
            }
            processedBattles.add(matchId);
        }
        while (processedBattles.size > 100) processedBattles.delete(processedBattles.values().next().value);
    } catch (err) { console.error('⚠️ Auto-Battle polling:', err.message); }
}

client.once('ready', async () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    try { await new REST({ version: '10' }).setToken(BOT_TOKEN).put(Routes.applicationCommands(client.user.id), { body: commands }); console.log('✅ Slash commands registered.'); }
    catch (err) { console.error('❌ Slash command registration:', err.message); }
    setInterval(checkAutoBattles, 2 * 60 * 1000);
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    const cmd = interaction.commandName;
    try {
        if (cmd === 'shutdown') { if (!OWNER_ID || interaction.user.id !== OWNER_ID) return interaction.reply({content:'❌ ไม่มีสิทธิ์',ephemeral:true}); await interaction.reply('👋 ปิดบอท...'); return setTimeout(() => process.exit(0), 1000); }
        if (cmd === 'check') {
            const sub = interaction.options.getSubcommand();
            if (sub === 'guilds') return interaction.reply(targetGuilds.length ? `🛡️ **กิลด์ที่ติดตาม (${targetGuilds.length})**\n\`\`\`\n${targetGuilds.map((x,i)=>`${i+1}. ${x}`).join('\n')}\n\`\`\`` : '🛡️ ไม่มีกิลด์ในระบบ');
            if (sub === 'members') return interaction.reply(targetPlayers.length ? `📋 **ผู้เล่นที่ติดตาม (${targetPlayers.length})**\n\`\`\`\n${targetPlayers.map((x,i)=>`${i+1}. ${x}`).join('\n')}\n\`\`\`` : '📋 ไม่มีผู้เล่นในระบบ');
            await interaction.deferReply(); return processBattleReport(interaction.options.getString('link_or_id'), interaction);
        }
        if (cmd === 'add' || cmd === 'remove') {
            const sub = interaction.options.getSubcommand(), name = interaction.options.getString('name').trim(), arr = sub === 'guild' ? targetGuilds : targetPlayers;
            if (cmd === 'add') { if (arr.some(x => x.toLowerCase() === name.toLowerCase())) return interaction.reply({content:`⚠️ **${name}** มีอยู่แล้ว`,ephemeral:true}); arr.push(name); saveData(); return interaction.reply(`✅ เพิ่ม **${name}** แล้ว`); }
            const before = arr.length; if (sub === 'guild') targetGuilds = targetGuilds.filter(x => x.toLowerCase() !== name.toLowerCase()); else targetPlayers = targetPlayers.filter(x => x.toLowerCase() !== name.toLowerCase());
            if (before === (sub === 'guild' ? targetGuilds.length : targetPlayers.length)) return interaction.reply({content:`❌ ไม่พบ **${name}**`,ephemeral:true}); saveData(); return interaction.reply(`🗑️ ลบ **${name}** แล้ว`);
        }
        if (cmd === 'autobattle') {
            const channel = interaction.options.getChannel('channel'), guild = interaction.options.getString('guild').trim(), fame = parseFameValue(interaction.options.getString('min_fame'));
            const data = { guildId: interaction.guildId, channelId: channel.id, targetGuild: guild, minFame: fame };
            const i = autoBattleConfigs.findIndex(x => x.guildId === interaction.guildId); if (i >= 0) autoBattleConfigs[i] = data; else autoBattleConfigs.push(data); saveData();
            return interaction.reply(`✅ Auto-Battle ตั้งค่าแล้ว\n- ห้อง: <#${channel.id}>\n- Guild: **${guild}**\n- Min Fame: **${formatFame(fame)}**`);
        }
        if (cmd === 'stat' || cmd === 'guild') {
            const name = interaction.options.getString(cmd === 'stat' ? 'player' : 'name'); await interaction.deferReply();
            const base = 'https://gameinfo-sgp.albiononline.com/api/gameinfo';
            const search = await axios.get(`${base}/search?q=${encodeURIComponent(name)}`, {timeout:5000});
            if (cmd === 'stat') {
                const x = search.data.players?.find(p => String(p.Name).toLowerCase() === name.toLowerCase()); if (!x) return interaction.editReply(`❌ ไม่พบผู้เล่น **${name}**`);
                const p = (await axios.get(`${base}/players/${x.Id}`, {timeout:5000})).data;
                return interaction.editReply({embeds:[new EmbedBuilder().setColor(0x3498db).setTitle(`👤 ${p.Name}`).addFields({name:'🛡️ Guild',value:p.GuildName||'None',inline:true},{name:'⚔️ Alliance',value:p.AllianceName||'None',inline:true},{name:'💀 Kill Fame',value:formatFame(p.KillFame),inline:true},{name:'⚰️ Death Fame',value:formatFame(p.DeathFame),inline:true}).setTimestamp()]});
            }
            const g = search.data.guilds?.find(x => String(x.Name).toLowerCase() === name.toLowerCase()); if (!g) return interaction.editReply(`❌ ไม่พบกิลด์ **${name}**`);
            const d = (await axios.get(`${base}/guilds/${g.Id}`, {timeout:5000})).data;
            return interaction.editReply({embeds:[new EmbedBuilder().setColor(0xe74c3c).setTitle(`🛡️ ${d.Name}`).addFields({name:'👑 Alliance',value:d.AllianceName||'None',inline:true},{name:'👥 Members',value:String(d.MemberCount||d.memberCount||0),inline:true},{name:'⚔️ Kill Fame',value:formatFame(d.KillFame||d.killFame),inline:true},{name:'💀 Death Fame',value:formatFame(d.DeathFame),inline:true}).setTimestamp()]});
        }
        if (cmd === 'mvp') {
            await interaction.deferReply(); const id = extractMatchId(interaction.options.getString('link_or_id')); const html = await fetchAlbionBBPage(id); if (!html) return interaction.editReply('❌ เข้าถึง AlbionBB ไม่ได้'); const p = parseDataFromHTML(html).players; if (!p.length) return interaction.editReply('❌ ไม่พบผู้เล่น');
            const mvp = [...p].sort((a,b)=>b.damage+b.healing-(a.damage+a.healing))[0], ex=[...p].sort((a,b)=>b.kills-a.kills)[0], fd=[...p].sort((a,b)=>b.deaths-a.deaths)[0];
            return interaction.editReply({embeds:[new EmbedBuilder().setColor(0xf1c40f).setTitle(`🏆 Battle Awards - ${id}`).addFields({name:'👑 MVP',value:`**${mvp.name}**\nDMG ${formatFame(mvp.damage)} | HEAL ${formatFame(mvp.healing)}`},{name:'🎯 Executioner',value:`**${ex.name}** (${ex.kills} kills)`},{name:'💀 Feeder',value:`**${fd.name}** (${fd.deaths} deaths)`}).setTimestamp()]});
        }
        if (cmd === 'regear') {
            await interaction.deferReply(); const id=extractMatchId(interaction.options.getString('link_or_id')); const player=interaction.options.getString('player'); const api=await fetchOfficialBattle(id); const list=getApiPlayers(api); const p=list.find(x=>x.name.toLowerCase()===player.toLowerCase()); if(!p) return interaction.editReply('❌ ไม่พบข้อมูลผู้เล่นจาก Gameinfo API'); if(!p.deaths) return interaction.editReply(`✅ **${player}** ไม่ได้ตายในไฟต์นี้`); return interaction.editReply(`📦 **Regear: ${p.name}**\n⚔️ Weapon: ${p.weapon||'N/A'}\n💀 Deaths: ${p.deaths}`);
        }
        if (cmd === 'ราคา') {
            let id=interaction.options.getString('name').toUpperCase().trim().replace(/\s+/g,'_'); const tier=interaction.options.getInteger('tier'), ench=interaction.options.getInteger('enhancement'); if(tier&&!/^T\d_/.test(id)) id=`T${tier}_${id}`; if(ench>0) id=id.split('@')[0]+`@${ench}`; await interaction.deferReply(); return checkMarketPrice(id, interaction.options.getString('city')||'BlackMarket', interaction);
        }
    } catch (err) { console.error('❌ interaction error:',err); if(interaction.deferred) await interaction.editReply(`❌ เกิดข้อผิดพลาด: \`${err.message}\``).catch(()=>{}); else await interaction.reply({content:`❌ เกิดข้อผิดพลาด: \`${err.message}\``,ephemeral:true}).catch(()=>{}); }
});

client.on('messageCreate', async message => {
    if (message.author.bot) return;
    const m = message.content.match(/https?:\/\/east\.albionbb\.com\/battles\/[^\s]+/i);
    if (!m) return;
    try { const status = await message.reply('⏳ กำลังดึงสถิติจาก AlbionBB...'); await processBattleReport(m[0], status, true); }
    catch (err) { console.error('❌ messageCreate:', err); }
});

client.on('error', err => console.error('❌ Discord client error:', err));
process.on('unhandledRejection', err => console.error('❌ Unhandled rejection:', err));
process.on('uncaughtException', err => console.error('❌ Uncaught exception:', err));
client.login(BOT_TOKEN);
