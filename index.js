// AUTO-BATTLE FIX V3 (STABLE CANVAS): Auto-alert + Auto Battle Report without manual link pasting
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

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Web server listening on port ${PORT}`);
});

const BOT_TOKEN = String(process.env.BOT_TOKEN || '').trim();
const OWNER_ID = String(process.env.OWNER_ID || '').trim();

if (!BOT_TOKEN) {
    console.error('❌ BOT_TOKEN is missing. Set it in your hosting provider Environment Variables.');
    process.exit(1);
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const DATA_FILE = path.join(__dirname, 'tracking.json');
let targetPlayers = [];
let targetGuilds = []; 
let autoBattleConfigs = []; 
let processedBattles = new Set();
let autoBattleCheckRunning = false;

// Helper Safe RoundRect for Canvas
function drawRoundRect(ctx, x, y, width, height, radius) {
    if (typeof ctx.roundRect === 'function') {
        ctx.beginPath();
        ctx.roundRect(x, y, width, height, radius);
        return;
    }
    let r = radius;
    if (typeof r === 'number') {
        r = { tl: r, tr: r, br: r, bl: r };
    }
    ctx.beginPath();
    ctx.moveTo(x + r.tl, y);
    ctx.lineTo(x + width - r.tr, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + r.tr);
    ctx.lineTo(x + width, y + height - r.br);
    ctx.quadraticCurveTo(x + width, y + height, x + width - r.br, y + height);
    ctx.lineTo(x + r.bl, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - r.bl);
    ctx.lineTo(x, y + r.tl);
    ctx.quadraticCurveTo(x, y, x + r.tl, y);
    ctx.closePath();
}

function loadData() {
    try {
        if (!fs.existsSync(DATA_FILE)) {
            saveData();
            return;
        }
        const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        targetPlayers = Array.isArray(data.players) ? data.players : [];
        
        targetGuilds = Array.isArray(data.guilds) ? data.guilds.map(g => {
            if (typeof g === 'string') return { name: g, channelId: null };
            return g;
        }) : [];

        autoBattleConfigs = Array.isArray(data.autoBattles) ? data.autoBattles : [];
        console.log(`📁 Tracking: ${targetGuilds.length} guilds, ${targetPlayers.length} players, ${autoBattleConfigs.length} auto-battle configs`);
    } catch (err) {
        console.error('❌ tracking.json load error:', err.message);
        targetPlayers = [];
        targetGuilds = [];
        autoBattleConfigs = [];
    }
}

function saveData() {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify({
            players: targetPlayers,
            guilds: targetGuilds,
            autoBattles: autoBattleConfigs
        }, null, 2), 'utf8');
    } catch (err) {
        console.error('❌ tracking.json save error:', err.message);
    }
}

loadData();

function parseFameValue(value) {
    if (typeof value === 'number') return value;
    let str = String(value || '').trim().toUpperCase();
    if (!str) return 0;
    let multiplier = 1;
    if (str.endsWith('B')) { multiplier = 1e9; str = str.slice(0, -1); }
    else if (str.endsWith('M')) { multiplier = 1e6; str = str.slice(0, -1); }
    else if (str.endsWith('K')) { multiplier = 1e3; str = str.slice(0, -1); }
    const num = parseFloat(str.replace(/,/g, ''));
    return Number.isNaN(num) ? 0 : Math.round(num * multiplier);
}

function formatFame(num) {
    num = Number(num) || 0;
    if (num >= 1e9) return `${(num / 1e9).toFixed(1)}B`;
    if (num >= 1e6) return `${(num / 1e6).toFixed(1)}M`;
    if (num >= 1e3) return `${(num / 1e3).toFixed(1)}K`;
    return num.toLocaleString();
}

function centerString(value, width) {
    const str = String(value);
    if (str.length >= width) return str.slice(0, width);
    const pad = width - str.length;
    return ' '.repeat(Math.floor(pad / 2)) + str + ' '.repeat(Math.ceil(pad / 2));
}

function formatUTCTime(input) {
    if (!input) return 'N/A';
    let date;
    if (typeof input === 'number' || (!Number.isNaN(Number(input)) && String(input).trim() !== '')) {
        let n = Number(input);
        if (n < 1e10) n *= 1000;
        date = new Date(n);
    } else date = new Date(input);
    if (Number.isNaN(date.getTime())) return 'N/A';
    const formatted = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Bangkok', day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit', hour12: false
    }).format(date);
    return `${formatted.replace(',', '')} UTC+7`;
}

function normalizeAlbionItemId(raw) {
    if (!raw) return '';
    let value = '';
    if (typeof raw === 'object') {
        value = raw.itemId ?? raw.ItemId ?? raw.itemID ?? raw.ItemID ??
            raw.type ?? raw.Type ?? raw.id ?? raw.Id ?? raw.itemType ?? raw.ItemType ??
            raw.uniqueName ?? raw.UniqueName ?? raw.name ?? raw.Name ?? '';
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
    return !s || s.includes('OFF_') || s.includes('_OFFHAND') || s.includes('OFFHAND') ||
        s.includes('SHIELD') || s.includes('TORCH') || s.includes('TOME') || s.includes('BOOK') ||
        s.includes('ORB') || s.includes('HORN');
}

function isWeaponItemId(id) {
    const s = normalizeAlbionItemId(id).toUpperCase();
    if (!s || isOffhandItemId(s)) return false;
    return s.includes('MAIN_') || s.includes('_2H_') || s.startsWith('2H_') ||
        s.includes('CROSSBOW') || s.includes('BOW') || s.includes('STAFF') || s.includes('SWORD') ||
        s.includes('MACE') || s.includes('AXE') || s.includes('HAMMER') || s.includes('SPEAR') ||
        s.includes('DAGGER') || s.includes('ARCANE') || s.includes('HOLY') || s.includes('NATURE') ||
        s.includes('FIRE') || s.includes('FROST') || s.includes('CURSED') || s.includes('GLAIVE') ||
        s.includes('SCYTHE') || s.includes('QUARTERSTAFF') || s.includes('WAR_GLOVE') ||
        s.includes('FIST') || s.includes('REAVER');
}

function isBadEquipmentItem(id) {
    const s = normalizeAlbionItemId(id).toUpperCase();
    if (!s) return true;
    return s.includes('BAG') || s.includes('CAPE') || s.includes('HEAD') || s.includes('ARMOR') ||
        s.includes('SHOES') || s.includes('FOOD') || s.includes('POTION') || s.includes('MOUNT') || isOffhandItemId(s);
}

function getApiUrls(matchId) {
    return [
        `https://gameinfo.albiononline.com/api/gameinfo/battles/${encodeURIComponent(matchId)}`,
        `https://gameinfo-sgp.albiononline.com/api/gameinfo/battles/${encodeURIComponent(matchId)}`
    ];
}

async function fetchAlbionBBWeaponMap(matchId) {
    const urls = [
        `https://api.albionbb.com/asia/battles/kills?ids=${encodeURIComponent(matchId)}`,
        `https://api.albionbb.com/asia/battles/kills?ids%5B%5D=${encodeURIComponent(matchId)}`
    ];

    for (const url of urls) {
        try {
            const response = await axios.get(url, {
                timeout: 15000,
                headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }
            });
            const data = response.data;
            const events = Array.isArray(data) ? data :
                Array.isArray(data?.events) ? data.events :
                Array.isArray(data?.kills) ? data.kills : [];
            if (!events.length) continue;

            const map = new Map();
            const addEntity = (entity) => {
                if (!entity || typeof entity !== 'object') return;
                const name = String(entity.Name ?? entity.name ?? '').trim();
                if (!name) return;
                const candidates = [
                    entity.MainHand, entity.mainHand,
                    entity.Equipment?.MainHand, entity.equipment?.MainHand,
                    entity.Equipment?.mainHand, entity.equipment?.mainHand,
                    entity.Weapon, entity.weapon
                ];
                let info = null;
                for (const c of candidates) {
                    const id = normalizeAlbionItemId(c);
                    if (!id) continue;
                    const quality = Number(c?.Quality ?? c?.quality ?? 1) || 1;
                    info = { id, quality: Math.max(1, Math.min(5, quality)) };
                    break;
                }
                if (info) map.set(name.toLowerCase(), info);
            };

            for (const event of events) {
                addEntity(event.Killer || event.killer);
                addEntity(event.Victim || event.victim);
                const groups = [
                    ...(Array.isArray(event.Participants) ? event.Participants : []),
                    ...(Array.isArray(event.GroupMembers) ? event.GroupMembers : [])
                ];
                groups.forEach(addEntity);
            }
            if (map.size) return map;
        } catch (err) {
            console.error('⚠️ AlbionBB weapon fallback failed:', err.message);
        }
    }
    return new Map();
}

async function fetchOfficialBattleWeaponMap(matchId) {
    const baseUrls = getApiUrls(matchId).map(url => url.replace(/\/battles\//i, '/events/battle/'));
    const map = new Map();
    const maxPages = 12;

    for (const baseUrl of baseUrls) {
        try {
            for (let page = 0; page < maxPages; page++) {
                const offset = page * 51;
                const url = `${baseUrl}?limit=51&offset=${offset}`;
                const response = await axios.get(url, {
                    timeout: 20000,
                    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }
                });

                const data = response.data;
                const events = Array.isArray(data) ? data :
                    Array.isArray(data?.events) ? data.events :
                    Array.isArray(data?.kills) ? data.kills : [];

                if (!events.length) break;

                const addEntity = (entity) => {
                    if (!entity || typeof entity !== 'object') return;
                    const name = String(entity.Name ?? entity.name ?? '').trim();
                    if (!name) return;

                    const info = extractMainHandInfo(entity);
                    if (!info) return;

                    const key = name.toLowerCase();
                    if (!map.has(key)) map.set(key, info);
                };

                for (const event of events) {
                    addEntity(event.Killer || event.killer);
                    addEntity(event.Victim || event.victim);

                    const groups = [
                        ...(Array.isArray(event.Participants) ? event.Participants : []),
                        ...(Array.isArray(event.GroupMembers) ? event.GroupMembers : [])
                    ];
                    groups.forEach(addEntity);
                }

                if (events.length < 51) break;
            }

            if (map.size) break;
        } catch (err) {
            console.warn(`⚠️ Official battle-event weapon fallback failed: ${err.message}`);
        }
    }

    return map;
}

async function fetchOfficialBattle(matchId) {
    const urls = getApiUrls(matchId);
    for (const url of urls) {
        try {
            const response = await axios.get(url, { timeout: 30000, headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
            if (response.data) return response.data;
        } catch (err) {}
    }
    return null;
}

function objectToPlayer(obj) {
    if (!obj || typeof obj !== 'object') return null;
    const name = obj.name ?? obj.Name ?? obj.playerName ?? obj.PlayerName;
    if (!name || typeof name !== 'string') return null;
    const guild = obj.guildName ?? obj.GuildName ?? obj.guild ?? obj.Guild ?? '';
    const weaponInfo = extractMainHandInfo(obj);
    return {
        name: String(name), guild: typeof guild === 'string' ? guild : '',
        kills: Number(obj.kills ?? obj.Kills ?? obj.kill ?? obj.Kill ?? 0) || 0,
        deaths: Number(obj.deaths ?? obj.Deaths ?? obj.death ?? obj.Death ?? 0) || 0,
        fame: parseFameValue(obj.killFame ?? obj.killfame ?? obj.fame ?? obj.Fame ?? obj.KillFame ?? 0),
        damage: parseFameValue(obj.damage ?? obj.Damage ?? obj.totalDamage ?? obj.TotalDamage ?? 0),
        healing: parseFameValue(obj.healing ?? obj.Healing ?? obj.totalHealing ?? obj.TotalHealing ?? 0),
        weapon: weaponInfo?.id || '',
        weaponQuality: weaponInfo?.quality || 1
    };
}

function getApiPlayers(apiData) {
    if (!apiData?.players) return [];
    const list = Array.isArray(apiData.players) ? apiData.players : Object.values(apiData.players);
    return list.map(objectToPlayer).filter(Boolean);
}

function extractMainHandInfo(obj) {
    if (!obj || typeof obj !== 'object') return null;

    const candidates = [];
    const pushCandidate = (value) => {
        if (value !== undefined && value !== null) candidates.push(value);
    };

    pushCandidate(obj.MainHand);
    pushCandidate(obj.mainHand);
    pushCandidate(obj.MAINHAND);
    pushCandidate(obj.mainhand);
    pushCandidate(obj.Mainhand);
    pushCandidate(obj.Equipment?.MainHand);
    pushCandidate(obj.equipment?.MainHand);
    pushCandidate(obj.Equipment?.mainHand);
    pushCandidate(obj.equipment?.mainHand);
    pushCandidate(obj.Equipment?.mainhand);
    pushCandidate(obj.equipment?.mainhand);
    pushCandidate(obj.weapon);
    pushCandidate(obj.Weapon);
    pushCandidate(obj.weaponId);
    pushCandidate(obj.WeaponId);

    const equipment = obj.Equipment || obj.equipment;
    if (equipment && typeof equipment === 'object') {
        for (const [key, value] of Object.entries(equipment)) {
            if (/main.?hand|weapon/i.test(key)) pushCandidate(value);
        }
    }

    for (const candidate of candidates) {
        const id = normalizeAlbionItemId(candidate);
        if (!id || isBadEquipmentItem(id)) continue;

        const quality = Number(
            candidate?.Quality ?? candidate?.quality ??
            candidate?.ItemQuality ?? candidate?.itemQuality ?? 1
        ) || 1;
        return { id, quality: Math.max(1, Math.min(5, quality)) };
    }
    return null;
}

function getWeaponRenderUrls(weapon, quality = 1) {
    const id = normalizeAlbionItemId(weapon);
    if (!id) return [];
    const baseId = id.replace(/@\d+$/, '');
    const q = Math.max(1, Math.min(5, Number(quality) || 1));
    const encoded = encodeURIComponent(id);
    const encodedBase = encodeURIComponent(baseId);
    return [
        `https://render.albiononline.com/v1/item/${encoded}.png?quality=${q}&size=64`,
        `https://render.albiononline.com/v1/item/${encodedBase}.png?quality=${q}&size=64`,
        `https://render.albiononline.com/v1/item/${encoded}`,
        `https://gameinfo.albiononline.com/api/gameinfo/items/${encoded}`
    ];
}

async function loadAlbionWeaponIcon(weapon, quality = 1) {
    const urls = getWeaponRenderUrls(weapon, quality);
    for (const url of urls) {
        try {
            const response = await axios.get(url, {
                responseType: 'arraybuffer',
                timeout: 8000,
                headers: {
                    'User-Agent': 'Mozilla/5.0',
                    'Accept': 'image/png,image/webp,image/*,*/*;q=0.8'
                },
                validateStatus: status => status >= 200 && status < 300
            });
            const buffer = Buffer.from(response.data);
            if (buffer.length > 100) return await loadImage(buffer);
        } catch (_) {}
    }
    return null;
}

async function loadFameIcon() {
    try {
        const fameIconUrl = 'https://render.albiononline.com/v1/spell/T6_GVGSEASONREWARD_FAMEBUFF_SPELL.png';
        const response = await axios.get(fameIconUrl, { responseType: 'arraybuffer', timeout: 5000 });
        return await loadImage(Buffer.from(response.data));
    } catch (err) {
        console.error('Failed to load Fame icon:', err.message);
        return null;
    }
}

async function generateGuildSummaryImage(guildsData) {
    if (!guildsData || !guildsData.length) return null;
    
    const topGuilds = [...guildsData];

    const width = 760;
    const rowHeight = 56;
    const headerHeight = 64;
    const padding = 20;
    const height = padding * 2 + headerHeight + (topGuilds.length * rowHeight);

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#18191c';
    drawRoundRect(ctx, 0, 0, width, height, 16);
    ctx.fill();

    ctx.fillStyle = '#949ba4';
    ctx.font = 'bold 16px sans-serif';
    ctx.fillText('NAME', padding + 10, padding + 38);
    ctx.fillText('PLAYERS', 340, padding + 38);
    ctx.fillText('KILLS', 460, padding + 38);
    ctx.fillText('DEATHS', 560, padding + 38);
    ctx.fillText('FAME', 660, padding + 38);

    ctx.strokeStyle = '#2b2d31';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(padding, padding + headerHeight);
    ctx.lineTo(width - padding, padding + headerHeight);
    ctx.stroke();

    topGuilds.forEach((g, i) => {
        const y = padding + headerHeight + (i * rowHeight);

        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 20px sans-serif';
        const gName = g.name.length > 20 ? g.name.slice(0, 18) + '..' : g.name;
        ctx.fillText(gName, padding + 10, y + 36);

        ctx.fillStyle = '#3399ff';
        ctx.fillText(String(g.playersCount || 0), 340, y + 36);

        ctx.fillStyle = '#ff5555';
        ctx.fillText(String(g.kills || 0), 460, y + 36);

        ctx.fillStyle = '#ff66cc';
        ctx.fillText(String(g.deaths || 0), 560, y + 36);

        ctx.fillStyle = '#ffcc00';
        ctx.fillText(formatFame(g.killFame || 0), 660, y + 36);
    });

    return new AttachmentBuilder(canvas.toBuffer('image/png'), { name: 'guild-summary.png' });
}

async function generatePlayerWeaponReportImage(players, battleInfo = {}) {
    if (!players || !players.length) return null;

    const fameImg = await loadFameIcon();
    const sortedPlayers = [...players].sort((a, b) =>
        (Number(b.fame) || 0) - (Number(a.fame) || 0) ||
        (Number(b.kills) || 0) - (Number(a.kills) || 0)
    );

    let totalKills = 0, totalDeaths = 0, totalFame = 0;
    let topKiller = { name: 'N/A', kills: 0 };
    let mvp = { name: 'N/A', fame: 0 };
    sortedPlayers.forEach(p => {
        const k = Number(p.kills) || 0;
        const d = Number(p.deaths) || 0;
        const f = Number(p.fame) || 0;
        totalKills += k; totalDeaths += d; totalFame += f;
        if (k > topKiller.kills) topKiller = { name: p.displayName || p.name, kills: k };
        if (f > mvp.fame) mvp = { name: p.displayName || p.name, fame: f };
    });

    // -------------------------------------------------------------------------
    // BATTLE REPORT — red / gold cinematic HUD, matching the supplied reference
    // -------------------------------------------------------------------------
    const W = 1632;
    const P = 28;
    const headerH = 122;
    const statH = 96;
    const statGap = 12;
    const cardW = 214;
    const cardH = 218;
    const cardGapX = 16;
    const cardGapY = 16;
    const cols = 7;
    const rows = Math.ceil(sortedPlayers.length / cols);
    const gridY = P + headerH + statH + 18;
    const footerH = 56;
    const H = gridY + rows * cardH + (rows - 1) * cardGapY + footerH + P;

    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');
    ctx.antialias = 'subpixel';

    const C = {
        bg: '#03070d', panel: '#08111d', panel2: '#0b1625', line: '#263b55',
        white: '#f7f9fc', muted: '#8291a7', red: '#ef3038', red2: '#ff5a45',
        gold: '#f6b91a', gold2: '#ffd866', purple: '#d83cff', blue: '#4eb5ff',
        green: '#57d68d'
    };

    function rr(x, y, w, h, r, fill, stroke = null, lw = 1) {
        drawRoundRect(ctx, x, y, w, h, r);
        if (fill) { ctx.fillStyle = fill; ctx.fill(); }
        if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke(); }
    }
    function fit(text, max, size, weight = '900') {
        let s = size;
        while (s > 8) {
            ctx.font = `${weight} ${s}px Arial, sans-serif`;
            if (ctx.measureText(String(text)).width <= max) break;
            s--;
        }
        return s;
    }
    function ct(text, x, y, size, color, weight = '900', max = Infinity) {
        const s = max === Infinity ? size : fit(text, max, size, weight);
        ctx.save(); ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
        ctx.font = `${weight} ${s}px Arial, sans-serif`; ctx.fillStyle = color;
        ctx.fillText(String(text), x, y); ctx.restore();
    }
    function panelCut(x, y, w, h, fill, stroke, cut = 12, lw = 1.4) {
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(x + cut, y); ctx.lineTo(x + w - cut, y); ctx.lineTo(x + w, y + cut);
        ctx.lineTo(x + w, y + h - cut); ctx.lineTo(x + w - cut, y + h);
        ctx.lineTo(x + cut, y + h); ctx.lineTo(x, y + h - cut); ctx.lineTo(x, y + cut);
        ctx.closePath();
        ctx.fillStyle = fill; ctx.fill();
        ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke();
        ctx.restore();
    }
    function line(x1, y1, x2, y2, color, lw = 1, alpha = 1) {
        ctx.save(); ctx.globalAlpha = alpha; ctx.strokeStyle = color; ctx.lineWidth = lw;
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); ctx.restore();
    }

    // Vector icons — no emoji/font dependency.
    function iconSwords(cx, cy, s, color) {
        ctx.save(); ctx.translate(cx, cy); ctx.strokeStyle = color; ctx.fillStyle = color;
        ctx.lineWidth = 4 * s; ctx.lineCap = 'round'; ctx.shadowColor = color; ctx.shadowBlur = 12 * s;
        for (const r of [-1, 1]) {
            ctx.save(); ctx.rotate(r * 0.58);
            ctx.beginPath(); ctx.moveTo(0, -18*s); ctx.lineTo(0, 9*s); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(-7*s, 8*s); ctx.lineTo(7*s, 8*s); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(0, 10*s); ctx.lineTo(0, 18*s); ctx.stroke();
            ctx.restore();
        }
        ctx.restore();
    }
    function iconSkull(cx, cy, s, color) {
        ctx.save(); ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 3*s;
        ctx.shadowColor = color; ctx.shadowBlur = 12*s;
        ctx.beginPath(); ctx.arc(cx, cy-4*s, 15*s, Math.PI, 0); ctx.lineTo(cx+12*s, cy+9*s);
        ctx.lineTo(cx+7*s, cy+14*s); ctx.lineTo(cx-7*s, cy+14*s); ctx.lineTo(cx-12*s, cy+9*s); ctx.closePath(); ctx.stroke();
        ctx.fillStyle = '#050a11';
        ctx.beginPath(); ctx.arc(cx-6*s, cy-3*s, 3.3*s, 0, Math.PI*2); ctx.fill();
        ctx.beginPath(); ctx.arc(cx+6*s, cy-3*s, 3.3*s, 0, Math.PI*2); ctx.fill();
        ctx.beginPath(); ctx.moveTo(cx, cy+1*s); ctx.lineTo(cx-3*s, cy+7*s); ctx.lineTo(cx+3*s, cy+7*s); ctx.closePath(); ctx.fill();
        ctx.strokeStyle = color; ctx.beginPath(); ctx.moveTo(cx-7*s, cy+14*s); ctx.lineTo(cx-4*s, cy+19*s); ctx.moveTo(cx, cy+14*s); ctx.lineTo(cx, cy+19*s); ctx.moveTo(cx+7*s, cy+14*s); ctx.lineTo(cx+4*s, cy+19*s); ctx.stroke();
        ctx.restore();
    }
    function iconGem(cx, cy, s, color) {
        ctx.save(); ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 2.5*s; ctx.shadowColor = color; ctx.shadowBlur = 13*s;
        ctx.beginPath(); ctx.moveTo(cx,cy-19*s); ctx.lineTo(cx+16*s,cy-8*s); ctx.lineTo(cx+10*s,cy+13*s); ctx.lineTo(cx,cy+20*s); ctx.lineTo(cx-10*s,cy+13*s); ctx.lineTo(cx-16*s,cy-8*s); ctx.closePath(); ctx.stroke();
        ctx.globalAlpha=.18; ctx.fill(); ctx.globalAlpha=1;
        line(cx,cy-17*s,cx,cy+18*s,color,1.4); line(cx-14*s,cy-7*s,cx+14*s,cy-7*s,color,1.4);
        ctx.restore();
    }
    function iconCrown(cx, cy, s, color) {
        ctx.save(); ctx.strokeStyle=color; ctx.fillStyle=color; ctx.lineWidth=2.5*s; ctx.lineJoin='round'; ctx.shadowColor=color; ctx.shadowBlur=13*s;
        ctx.beginPath(); ctx.moveTo(cx-19*s,cy-8*s); ctx.lineTo(cx-9*s,cy+1*s); ctx.lineTo(cx,cy-15*s); ctx.lineTo(cx+9*s,cy+1*s); ctx.lineTo(cx+19*s,cy-8*s); ctx.lineTo(cx+14*s,cy+12*s); ctx.lineTo(cx-14*s,cy+12*s); ctx.closePath(); ctx.stroke();
        ctx.globalAlpha=.18; ctx.fill(); ctx.globalAlpha=1; ctx.fillRect(cx-15*s,cy+12*s,30*s,5*s);
        ctx.restore();
    }
    function iconMedal(cx, cy, s, color) {
        ctx.save(); ctx.strokeStyle=color; ctx.fillStyle=color; ctx.lineWidth=2.5*s; ctx.shadowColor=color; ctx.shadowBlur=14*s;
        ctx.beginPath(); ctx.moveTo(cx-9*s,cy-18*s); ctx.lineTo(cx-3*s,cy-3*s); ctx.lineTo(cx+3*s,cy-3*s); ctx.lineTo(cx+9*s,cy-18*s); ctx.stroke();
        ctx.beginPath(); ctx.arc(cx,cy+7*s,14*s,0,Math.PI*2); ctx.stroke(); ctx.beginPath(); ctx.arc(cx,cy+7*s,5*s,0,Math.PI*2); ctx.fill(); ctx.restore();
    }
    function iconPeople(cx, cy, s, color) {
        ctx.save(); ctx.fillStyle=color; ctx.shadowColor=color; ctx.shadowBlur=8*s;
        for (const dx of [-8, 8]) { ctx.beginPath(); ctx.arc(cx+dx*s,cy-6*s,5*s,0,Math.PI*2); ctx.fill(); ctx.beginPath(); ctx.arc(cx+dx*s,cy+7*s,8*s,Math.PI,0); ctx.fill(); }
        ctx.restore();
    }
    function statIcon(cx, cy, color, type) {
        ctx.save(); ctx.shadowColor=color; ctx.shadowBlur=20;
        ctx.strokeStyle=color; ctx.lineWidth=1.5; ctx.fillStyle='#07101b';
        ctx.beginPath(); ctx.arc(cx,cy,31,0,Math.PI*2); ctx.fill(); ctx.stroke();
        ctx.globalAlpha=.12; ctx.fillStyle=color; ctx.beginPath(); ctx.arc(cx,cy,26,0,Math.PI*2); ctx.fill(); ctx.globalAlpha=1;
        if(type==='kills') iconSwords(cx,cy,.85,color);
        if(type==='deaths') iconSkull(cx,cy,.72,color);
        if(type==='fame') iconGem(cx,cy,.70,color);
        if(type==='killer') iconCrown(cx,cy,.70,color);
        if(type==='mvp') iconMedal(cx,cy,.75,color);
        ctx.restore();
    }
    function badge(x,y,w,h,text,fill,stroke,textColor) {
        panelCut(x,y,w,h,fill,stroke,5,1); ct(text,x+w/2,y+h-7,9,textColor,'900',w-8);
    }

    // Background: deep navy + red battlefield atmosphere + tactical grid.
    ctx.fillStyle=C.bg; ctx.fillRect(0,0,W,H);
    const glow = ctx.createRadialGradient(W*.58,70,20,W*.58,220,W*.72);
    glow.addColorStop(0,'#1b2a43'); glow.addColorStop(.55,'#091321'); glow.addColorStop(1,'#02050a');
    ctx.fillStyle=glow; ctx.fillRect(0,0,W,H);
    const redGlow = ctx.createRadialGradient(W*.72,H*.92,10,W*.72,H*.92,W*.5);
    redGlow.addColorStop(0,'rgba(160,18,18,.32)'); redGlow.addColorStop(1,'rgba(160,18,18,0)');
    ctx.fillStyle=redGlow; ctx.fillRect(0,0,W,H);
    ctx.save(); ctx.strokeStyle='rgba(120,150,190,.065)'; ctx.lineWidth=1;
    for(let x=0;x<W;x+=32){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,H);ctx.stroke();}
    for(let y=0;y<H;y+=32){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(W,y);ctx.stroke();}
    ctx.restore();
    // Abstract fortress/banners along the bottom edge.
    ctx.save(); ctx.globalAlpha=.24; ctx.fillStyle='#111a29';
    for(let i=0;i<9;i++){
        const bx=80+i*190, bh=40+(i%3)*22;
        ctx.beginPath(); ctx.moveTo(bx,H-42); ctx.lineTo(bx+10,H-bh-42); ctx.lineTo(bx+32,H-bh-42); ctx.lineTo(bx+45,H-42); ctx.closePath(); ctx.fill();
        ctx.fillRect(bx+17,H-bh-66,2,bh+24);
    }
    ctx.restore();
    ctx.fillStyle=C.red; ctx.fillRect(0,0,W,4);

    // Header.
    ctx.save();
    ctx.fillStyle='#f1f5f9'; ctx.font='900 34px Arial, sans-serif'; ctx.fillText('BATTLE',P,P+34);
    ctx.fillStyle=C.red; ctx.font='900 italic 39px Arial, sans-serif'; ctx.fillText('REPORT',P+155,P+36);
    // compact Albion-inspired crest
    ctx.strokeStyle=C.red; ctx.lineWidth=3; ctx.beginPath(); ctx.moveTo(P+3,78); ctx.lineTo(P+21,54); ctx.lineTo(P+39,78); ctx.stroke();
    ctx.fillStyle=C.red; ctx.font='900 9px Arial,sans-serif'; ctx.fillText('ONLINE',P+4,91);
    ctx.restore();
    ctx.fillStyle='#b6c2d3'; ctx.font='900 11px Arial,sans-serif';
    ctx.fillText(`EAST SERVER   |   ${formatUTCTime(battleInfo.battleTime || Date.now())}   |   MATCH ID: ${battleInfo.matchId || 'N/A'}`,P,96);
    ctx.fillStyle=C.red; ctx.font='900 9px Arial,sans-serif'; ctx.fillText('COMBAT ANALYTICS  /  LIVE BATTLE DATA',P,111);

    const badgeW=190,badgeH=64,badgeX=W-P-badgeW,badgeY=26;
    panelCut(badgeX,badgeY,badgeW,badgeH,'#091321',C.red,10,1.5);
    ct(String(sortedPlayers.length),badgeX+50,badgeY+41,28,C.white,'900');
    ctx.fillStyle='#91a0b4';ctx.font='900 10px Arial,sans-serif';ctx.fillText('PLAYERS',badgeX+83,badgeY+26);
    ctx.fillStyle='#d7deea';ctx.font='bold 11px Arial,sans-serif';ctx.fillText('IN BATTLE',badgeX+83,badgeY+45);
    iconPeople(badgeX+160,badgeY+32,.65,C.white);

    // Stats row.
    const statY=P+headerH;
    const statW=(W-P*2-statGap*4)/5;
    const stats=[
        {label:'TOTAL KILLS',value:totalKills.toLocaleString(),sub:'ELIMINATIONS',color:C.red,icon:'kills'},
        {label:'TOTAL DEATHS',value:totalDeaths.toLocaleString(),sub:'CASUALTIES',color:'#ff5b61',icon:'deaths'},
        {label:'TOTAL FAME',value:formatFame(totalFame),sub:'KILL FAME',color:C.gold,icon:'fame'},
        {label:'TOP KILLER',value:topKiller.name,sub:`${topKiller.kills} KILLS`,color:C.purple,icon:'killer'},
        {label:'MVP  /  TOP FAME',value:mvp.name,sub:`${formatFame(mvp.fame)} FAME`,color:C.gold,icon:'mvp'}
    ];
    stats.forEach((st,i)=>{
        const x=P+i*(statW+statGap);
        panelCut(x,statY,statW,statH,'#091321','#20324a',10,1.2);
        ctx.fillStyle=st.color;ctx.fillRect(x,statY,5,statH);
        statIcon(x+40,statY+48,st.color,st.icon);
        ctx.fillStyle='#72839a';ctx.font='900 10px Arial,sans-serif';ctx.fillText(st.label,x+80,statY+24);
        const valueSize=fit(st.value,statW-92,i>=3?21:27,'900');
        ctx.save();ctx.font=`900 ${valueSize}px Arial,sans-serif`;ctx.fillStyle=C.white;ctx.shadowColor='rgba(255,255,255,.12)';ctx.shadowBlur=5;ctx.fillText(st.value,x+80,statY+55);ctx.restore();
        ctx.fillStyle=st.color;ctx.font='900 9px Arial,sans-serif';ctx.fillText(st.sub,x+80,statY+77);
    });

    const weaponImages=await Promise.all(sortedPlayers.map(p=>loadAlbionWeaponIcon(p.weapon,p.weaponQuality||1)));
    const qualityMeta={1:{label:'NORMAL',color:'#8b9bb0'},2:{label:'GOOD',color:'#59aef7'},3:{label:'OUTSTANDING',color:'#a875ff'},4:{label:'EXCELLENT',color:'#ff9f24'},5:{label:'MASTERPIECE',color:'#ffd34f'}};

    // Player cards.
    sortedPlayers.forEach((p,i)=>{
        const col=i%cols,row=Math.floor(i/cols);
        const x=P+col*(cardW+cardGapX), y=gridY+row*(cardH+cardGapY);
        const cx=x+cardW/2, isMVP=i===0;
        const k=Number(p.kills)||0,d=Number(p.deaths)||0;
        const q=Math.max(1,Math.min(5,Number(p.weaponQuality)||1)),qm=qualityMeta[q];

        panelCut(x,y,cardW,cardH,isMVP?'#101a29':'#07101b',isMVP?C.gold:'#253951',10,isMVP?2:1.2);
        if(isMVP){ctx.save();ctx.shadowColor='rgba(246,185,26,.45)';ctx.shadowBlur=22;ctx.strokeStyle=C.gold;ctx.lineWidth=1.5;panelCut(x+1,y+1,cardW-2,cardH-2,null,C.gold,9,1);ctx.restore();}
        // rank
        panelCut(x+10,y+10,39,25,isMVP?'#f6b91a':'#15263b',isMVP?'#ffd866':'#324a67',5,1);
        ct(String(i+1).padStart(2,'0'),x+29.5,y+28,12,isMVP?'#111827':'#e2e8f0','900');
        if(isMVP) badge(x+cardW-61,y+10,50,25,'MVP','#241b08',C.gold,C.gold2);

        // weapon: large square frame + circular scanner ring
        const wy=y+73;
        ctx.save();ctx.shadowColor=qm.color;ctx.shadowBlur=isMVP?20:11;
        panelCut(cx-47,wy-47,94,94,'#040911',qm.color,9,isMVP?2.2:1.5);
        ctx.strokeStyle='rgba(255,255,255,.16)';ctx.lineWidth=1;ctx.beginPath();ctx.arc(cx,wy,40,0,Math.PI*2);ctx.stroke();
        ctx.strokeStyle=qm.color;ctx.lineWidth=1.5;ctx.beginPath();ctx.arc(cx,wy,51,-.7,.7);ctx.stroke();ctx.beginPath();ctx.arc(cx,wy,51,Math.PI-.7,Math.PI+.7);ctx.stroke();
        ctx.restore();
        if(weaponImages[i]){try{ctx.drawImage(weaponImages[i],cx-39,wy-39,78,78);}catch(_){} } else iconSwords(cx,wy,1.6,qm.color);
        // quality chip
        badge(cx-45,y+122,90,18,`Q${q}  ${qm.label}`,'#040a12',qm.color,qm.color);
        // player name — stronger outline and centered
        let name=String(p.displayName||p.name||'Unknown').trim();
        if(name.length>23) name=name.slice(0,21)+'..';
        const ns=fit(name,cardW-18,16,'900');
        ctx.save();ctx.textAlign='center';ctx.font=`900 ${ns}px Arial,sans-serif`;ctx.lineWidth=4;ctx.strokeStyle='#02060b';ctx.strokeText(name,cx,y+157);ctx.fillStyle=isMVP?'#fff1bd':C.white;ctx.shadowColor='rgba(255,255,255,.14)';ctx.shadowBlur=4;ctx.fillText(name,cx,y+157);ctx.restore();
        // guild
        const guild=String(p.guild||'').trim();
        if(guild) ct(guild.length>24?guild.slice(0,22)+'..':guild,cx,y+171,8,'#7d8da4','900',cardW-18);
        // K/D row with mini vector marks
        const metricY=y+190;
        iconSwords(cx-42,metricY-4,.25,k?C.red:'#718096');
        ct(String(k),cx-27,metricY,12,k?C.red:'#8090a4','900');
        ct('/',cx,metricY,10,'#4a5d75','900');
        iconSkull(cx+23,metricY-4,.25,d? '#ff5961':'#718096');
        ct(String(d),cx+39,metricY,12,d?'#ff5961':'#8090a4','900');

        // Fame strip — centered in the card, never offset by icon width.
        const fy=y+cardH-28, fw=122, fh=24, fx=cx-fw/2;
        rr(fx,fy,fw,fh,8,'#0b1523',isMVP?'#8d6a1b':'#2a405b',1);
        if(fameImg){try{ctx.drawImage(fameImg,fx+10,fy+5,14,14);}catch(_){} } else iconGem(fx+17,fy+12,.32,C.gold);
        ct(formatFame(p.fame||0),fx+76,fy+17,12,C.gold2,'900',82);
    });

    // Footer.
    const fy=H-P-12;
    line(P,fy-25,W-P,fy-25,'#1b2b40',1,.9);
    ctx.fillStyle='#8b9aaf';ctx.font='900 9px Arial,sans-serif';ctx.fillText('VICTORY BELONGS TO THOSE WHO FIGHT TOGETHER',P,fy);
    ctx.fillStyle=C.red;ctx.font='900 9px Arial,sans-serif';const pw='POWERED BY  •  BOTBOSS';ctx.fillText(pw,W-P-ctx.measureText(pw).width,fy);

    return new AttachmentBuilder(canvas.toBuffer('image/png'),{name:'battle-report.png'});
}

async function generateTopPerformanceImage(players) {
    if (!players || !players.length) return null;
    const width = 760, cardHeight = 84, gap = 12, padding = 18;
    const height = padding * 2 + players.length * cardHeight + Math.max(0, players.length - 1) * gap;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, width, height);

    const imagePromises = players.map(async (p) => {
        const weaponId = normalizeAlbionItemId(p.weapon);
        if (!weaponId || !isWeaponItemId(weaponId)) return null;
        const urls = [`https://render.albiononline.com/v1/item/${encodeURIComponent(weaponId)}.png`, `https://render.albiononline.com/v1/item/${encodeURIComponent(weaponId.split('@')[0])}.png` ];
        for (const url of urls) {
            try {
                const img = await Promise.race([loadImage(url), new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 4000))]);
                if (img) return img;
            } catch (_) {}
        }
        return null;
    });

    const weaponImages = await Promise.all(imagePromises);

    for (let i = 0; i < players.length; i++) {
        const p = players[i], y = padding + i * (cardHeight + gap), cardX = padding, cardWidth = width - padding * 2;
        ctx.fillStyle = '#2a2a2a';
        drawRoundRect(ctx, cardX, y, cardWidth, cardHeight, 12); ctx.fill();
        const percent = Math.max(0, Math.min(100, Number(p.percent) || 0));
        const barWidth = Math.min(cardWidth, cardWidth * percent / 100);
        if (barWidth > 0) {
            ctx.fillStyle = p.type === 'heal' ? '#21b293' : '#ff4d6d';
            drawRoundRect(ctx, cardX, y, barWidth, cardHeight, 12); ctx.fill();
        }
        if (weaponImages[i]) {
            const size = 60;
            ctx.drawImage(weaponImages[i], cardX + 12, y + (cardHeight - size) / 2, size, size);
        }
        let name = p.name;
        if (name.length > 25) name = `${name.slice(0, 22)}...`;
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 22px sans-serif';
        ctx.fillText(name, cardX + 88, y + 36);
        ctx.fillStyle = '#cccccc';
        ctx.font = 'bold 16px sans-serif';
        const typeLabel = p.type === 'heal' ? 'HEAL' : 'DMG';
        ctx.fillText(`${typeLabel}  ${Number(p.value || 0).toLocaleString()}  (${percent}%)`, cardX + 88, y + 62);
    }
    return new AttachmentBuilder(canvas.toBuffer('image/png'), { name: 'top-performance.png' });
}

function extractMatchId(input) {
    const value = String(input || '').trim();
    if (!value) throw new Error('Match ID ว่าง');
    if (/^https?:\/\//i.test(value)) {
        const match = value.match(/\/battles\/([^/?#]+)/i);
        if (!match) throw new Error('ไม่สามารถอ่าน Match ID จากลิงก์ได้');
        return match[1];
    }
    return value;
}

function isExactGuildMatch(playerGuild, targetGuilds) {
    const playerName = String(playerGuild || '').trim().toLowerCase();
    if (!playerName) return false;

    return targetGuilds.some(g => {
        const targetName = String(typeof g === 'string' ? g : (g?.name || '')).trim().toLowerCase();
        return targetName && playerName === targetName;
    });
}

async function buildBattleReportPayload(matchId, customTargetGuilds = [], options = {}) {
    const apiData = /^\d+$/.test(matchId) ? await fetchOfficialBattle(matchId) : null;
    if (!apiData) throw new Error('ไม่พบข้อมูลไฟต์จาก Official Albion API');

    const battleTime = apiData.startTime || apiData.timestamp || null;

    const knownGuildNames = new Set([
        ...(apiData?.guilds ? Object.values(apiData.guilds).map(g => g.name?.trim().toLowerCase()).filter(Boolean) : []),
        ...(apiData?.alliances ? Object.values(apiData.alliances).map(a => a.name?.trim().toLowerCase()).filter(Boolean) : [])
    ]);

    let rawPlayers = getApiPlayers(apiData);

    try {
        const officialWeaponMap = await fetchOfficialBattleWeaponMap(matchId);
        const albionBBWeaponMap = await fetchAlbionBBWeaponMap(matchId);

        rawPlayers = rawPlayers.map(p => {
            const key = p.name.trim().toLowerCase();
            if (p.weapon) return p;

            const info = officialWeaponMap.get(key) || albionBBWeaponMap.get(key);
            return info ? { ...p, weapon: info.id, weaponQuality: info.quality } : p;
        });
    } catch (err) {
        console.error('⚠️ Weapon enrichment error:', err.message);
    }
    let allPlayers = rawPlayers.filter(p => !knownGuildNames.has(p.name.trim().toLowerCase()));

    if (!allPlayers.length && rawPlayers.length > 0) {
        allPlayers = rawPlayers;
    }

    if (!allPlayers.length) throw new Error('ไม่พบข้อมูลผู้เล่นในไฟต์นี้');

    const reportStats = new Map();
    for (const p of allPlayers) {
        const key = p.name.toLowerCase();
        const old = reportStats.get(key);
        if (!old) {
            reportStats.set(key, {
                displayName: p.name,
                guild: p.guild || '',
                kills: Number(p.kills) || 0,
                deaths: Number(p.deaths) || 0,
                fame: Number(p.fame) || 0,
                damage: Number(p.damage) || 0,
                healing: Number(p.healing) || 0,
                weapon: p.weapon || '',
                weaponQuality: Number(p.weaponQuality) || 1
            });
        } else {
            old.kills = Math.max(old.kills, Number(p.kills) || 0);
            old.deaths = Math.max(old.deaths, Number(p.deaths) || 0);
            old.fame = Math.max(old.fame, Number(p.fame) || 0);
            old.damage = Math.max(old.damage, Number(p.damage) || 0);
            old.healing = Math.max(old.healing, Number(p.healing) || 0);
            if (!old.weapon && p.weapon) old.weapon = p.weapon;
            if ((!old.weaponQuality || old.weaponQuality === 1) && p.weaponQuality) old.weaponQuality = p.weaponQuality;
            if (!old.guild && p.guild) old.guild = p.guild;
        }
    }

    const widths = { name: 20, kills: 8, deaths: 8, fame: 10 };
    const totalWidth = widths.name + widths.kills + widths.deaths + widths.fame;
    const divider = '='.repeat(totalWidth);
    const subDivider = '-'.repeat(totalWidth);

    const allSortedRows = [...reportStats.values()].sort((a, b) => b.fame - a.fame || b.kills - a.kills || b.damage - a.damage);

    const guildNamesList = customTargetGuilds.map(g => typeof g === 'string' ? g : g.name);

    const rows = allSortedRows.filter(p => {
        if (guildNamesList.length === 0 && targetPlayers.length === 0) return true;

        const isExplicitPlayer = targetPlayers.some(
            pl => pl.trim().toLowerCase() === p.displayName.trim().toLowerCase()
        );

        const isGuildMatch = isExactGuildMatch(p.guild, guildNamesList);

        return isGuildMatch || isExplicitPlayer;
    });

    let totalKills = 0, totalDeaths = 0, totalFame = 0;
    let guildTotalFrames = 0;
    const targetRowsToCalc = rows;
    
    for (const p of targetRowsToCalc) {
        totalKills += p.kills;
        totalDeaths += p.deaths;
        totalFame += p.fame;

        if (guildNamesList.length > 0) {
            if (isExactGuildMatch(p.guild, guildNamesList)) {
                guildTotalFrames += (p.kills + p.deaths);
            }
        } else {
            guildTotalFrames += (p.kills + p.deaths);
        }
    }

    let header = `\x1b[1;36m⚔️ ALBIONBB BATTLE REPORT\x1b[0m | \x1b[1;33m🆔 ${matchId}\x1b[0m\n`;
    header += `\x1b[1;33m🕒 Time:\x1b[0m \x1b[1;37m${formatUTCTime(battleTime)}\x1b[0m\n`;
    header += `\x1b[30m${divider}\x1b[0m\n`;
    header += `\x1b[1;37m${'Name'.padEnd(widths.name)}${centerString('Kills', widths.kills)}${centerString('Deaths', widths.deaths)}${centerString('Fame', widths.fame)}\x1b[0m\n`;
    header += `\x1b[30m${subDivider}\x1b[0m\n`;

    let footer = `\x1b[30m${subDivider}\x1b[0m\n`;
    footer += `\x1b[1;37m${'TOTAL'.padEnd(widths.name)}\x1b[32m${centerString(totalKills, widths.kills)}\x1b[31m${centerString(totalDeaths, widths.deaths)}\x1b[33m${centerString(formatFame(totalFame), widths.fame)}\x1b[0m\n`;

    const awardCandidates = rows;
    const executioner = [...awardCandidates].sort((a, b) => b.kills - a.kills)[0];
    const feeder = [...awardCandidates].sort((a, b) => b.deaths - a.deaths)[0];

    let awardsText = `\x1b[30m${subDivider}\x1b[0m\n`;
    awardsText += `\x1b[1;35m🏆 BATTLE AWARDS\x1b[0m\n`;
    if (executioner && executioner.kills > 0) {
        awardsText += `\x1b[1;32m🎯 Executioner :\x1b[0m \x1b[1;37m${executioner.displayName.padEnd(14)}\x1b[0m \x1b[32m(${executioner.kills} Kills)\x1b[0m\n`;
    }
    if (feeder && feeder.deaths > 0) {
        awardsText += `\x1b[1;31m💀 Feeder      :\x1b[0m \x1b[1;37m${feeder.displayName.padEnd(14)}\x1b[0m \x1b[31m(${feeder.deaths} Deaths)\x1b[0m\n`;
    }

    let body = '';
    const displayRows = rows;
    if (displayRows.length === 0) {
        body = `\x1b[30m(ไม่พบข้อมูลผู้เล่นในไฟต์นี้)\x1b[0m\n`;
    } else {
        for (let i = 0; i < displayRows.length; i++) {
            const p = displayRows[i];
            const name = p.displayName.slice(0, widths.name - 1).padEnd(widths.name);
            const kills = centerString(p.kills, widths.kills);
            const deaths = centerString(p.deaths, widths.deaths);
            const fame = centerString(formatFame(p.fame), widths.fame);

            const line = `\x1b[1;37m${name}\x1b[0m${p.kills > 0 ? `\x1b[32m${kills}\x1b[0m` : `\x1b[30m${kills}\x1b[0m`}${p.deaths > 0 ? `\x1b[31m${deaths}\x1b[0m` : `\x1b[30m${deaths}\x1b[0m`}${p.fame > 0 ? `\x1b[33m${fame}\x1b[0m` : `\x1b[30m${fame}\x1b[0m`}\n`;

            const remainingCount = displayRows.length - i;
            const testReportLength = ('```ansi\n' + header + body + line + `\x1b[30m... +${remainingCount} more players\x1b[0m\n` + footer + awardsText + '```').length;

            if (testReportLength > 1950) {
                body += `\x1b[30m... +${remainingCount} more players\x1b[0m\n`;
                break;
            }
            body += line;
        }
    }

    const battleUrl = `https://east.albionbb.com/battles/${matchId}`;
    const report = `🔗 **Battle Link:** <${battleUrl}>\n` + '```ansi\n' + header + body + footer + awardsText + '```';

    const performancePlayers = displayRows
        .filter(p => p.damage > 0 || p.healing > 0)
        .sort((a, b) => (b.damage + b.healing) - (a.damage + a.healing))
        .slice(0, 5);

    const attachments = [];

    try {
        const playerReport = await generatePlayerWeaponReportImage(displayRows, {
            matchId: matchId,
            battleTime: battleTime
        });
        if (playerReport) attachments.push(playerReport);
    } catch (err) {
        console.error('❌ Weapon report image error:', err.message);
    }

    if (performancePlayers.length) {
        try {
            const maxDamage = Math.max(1, ...performancePlayers.map(p => p.damage));
            const maxHealing = Math.max(1, ...performancePlayers.map(p => p.healing));
            const top = performancePlayers.map(p => {
                const heal = p.healing > p.damage, value = heal ? p.healing : p.damage, max = heal ? maxHealing : maxDamage;
                return { name: p.displayName, guild: p.guild, weapon: p.weapon, value, percent: Math.round((value / max) * 100), type: heal ? 'heal' : 'damage' };
            });
            const topImage = await generateTopPerformanceImage(top);
            if (topImage) attachments.push(topImage);
        } catch (err) { console.error('❌ Top performance image error:', err.message); }
    }

    let guildSummaryAttachment = null;
    try {
        if (apiData.guilds) {
            const playerCountByGuild = new Map();

            for (const p of rawPlayers) {
                const guildName = String(p.guild || '').trim();
                const playerName = String(p.name || '').trim();
                if (!guildName || !playerName) continue;

                const guildKey = guildName.toLowerCase();
                if (!playerCountByGuild.has(guildKey)) {
                    playerCountByGuild.set(guildKey, new Set());
                }

                playerCountByGuild.get(guildKey).add(playerName.toLowerCase());
            }

            let guildsData = Object.values(apiData.guilds).map(g => {
                const guildName = String(g.name || 'Unknown').trim();
                const guildKey = guildName.toLowerCase();

                return {
                    name: guildName,
                    playersCount: playerCountByGuild.get(guildKey)?.size || 0,
                    kills: g.kills || 0,
                    deaths: g.deaths || 0,
                    killFame: g.killFame || 0
                };
            });

            if (options.autoBattle && guildNamesList.length > 0) {
                const tracked = guildsData.filter(g => isExactGuildMatch(g.name, guildNamesList));
                const trackedNames = new Set(tracked.map(g => g.name.trim().toLowerCase()));

                const topOthers = guildsData
                    .filter(g => !trackedNames.has(g.name.trim().toLowerCase()))
                    .sort((a, b) =>
                        (b.killFame || 0) - (a.killFame || 0) ||
                        (b.kills || 0) - (a.kills || 0)
                    )
                    .slice(0, 3);

                guildsData = [...tracked, ...topOthers];
            } else if (guildNamesList.length > 0) {
                guildsData = guildsData.filter(g => isExactGuildMatch(g.name, guildNamesList));
            } else {
                guildsData.sort((a, b) => b.killFame - a.killFame);
            }

            guildSummaryAttachment = await generateGuildSummaryImage(guildsData);
        }
    } catch (err) {
        console.error('❌ Guild summary image error:', err.message);
    }

    if (guildSummaryAttachment) {
        attachments.push(guildSummaryAttachment);
    }

    return {
        matchId,
        totalFame,
        guildTotalFrames,
        battleUrl,
        payload: { content: report, files: attachments }
    };
}

async function processBattleReport(input, targetContext, isMessage = false) {
    try {
        const matchId = extractMatchId(input);
        const { payload } = await buildBattleReportPayload(matchId, targetGuilds);
        const files = Array.isArray(payload.files) ? payload.files : [];

        if (files.length > 1) {
            const firstPayload = {
                content: payload.content,
                files: [files[0]]
            };
            if (isMessage) {
                await targetContext.edit(firstPayload);
                for (const file of files.slice(1)) {
                    await targetContext.channel.send({ files: [file] });
                }
            } else {
                await targetContext.editReply(firstPayload);
                for (const file of files.slice(1)) {
                    await targetContext.followUp({ files: [file] });
                }
            }
            return;
        }

        if (isMessage) await targetContext.edit(payload); else await targetContext.editReply(payload);
    } catch (err) {
        console.error('❌ Process battle report error:', err);
        const message = `❌ เกิดข้อผิดพลาดในการประมวลผลไฟต์: \`${err.message}\``;
        if (isMessage) await targetContext.edit(message); else await targetContext.editReply(message);
    }
}

async function fetchGuildRecentBattles(guildName) {
    try {
        const searchUrl = `https://east.albionbb.com/?search=${encodeURIComponent(guildName)}`;
        const searchRes = await cloudscraper.get(searchUrl).catch(() => null);
        if (!searchRes) return [];

        const $ = cheerio.load(searchRes);
        const matchIds = [];
        $('a[href*="/battles/"]').each((_, el) => {
            const href = $(el).attr('href');
            const match = href ? href.match(/\/battles\/(\d+)/) : null;
            if (match && match[1]) {
                matchIds.push(match[1]);
            }
        });

        return [...new Set(matchIds)];
    } catch (err) {
        console.warn(`⚠️ Fetch guild battles error for ${guildName}:`, err.message);
        return [];
    }
}

async function checkAutoBattles() {
    if (!autoBattleConfigs.length) return;
    if (autoBattleCheckRunning) return;

    autoBattleCheckRunning = true;
    try {
        for (const config of autoBattleConfigs) {
            const recentMatches = await fetchGuildRecentBattles(config.targetGuild);
            if (!recentMatches.length) continue;

            const latestMatchId = recentMatches[0];

            if (processedBattles.has(latestMatchId)) continue;

            try {
                const officialBattle = await fetchOfficialBattle(latestMatchId);
                if (!officialBattle) {
                    console.warn(`⚠️ Official Albion API ไม่พบ Match ID ${latestMatchId}`);
                    continue;
                }

                const officialGuildNames = officialBattle.guilds
                    ? Object.values(officialBattle.guilds).map(g => g?.name).filter(Boolean)
                    : [];

                if (!isExactGuildMatch(config.targetGuild, officialGuildNames)) {
                    console.log(
                        `⏭️ Skip Match ${latestMatchId}: tracked Guild "${config.targetGuild}" ` +
                        `ไม่ตรงกับ Official Guilds: ${officialGuildNames.join(', ') || 'N/A'}`
                    );
                    processedBattles.add(latestMatchId);
                    continue;
                }

                const result = await buildBattleReportPayload(
                    latestMatchId,
                    [config.targetGuild],
                    { autoBattle: true }
                );

                const checkValue = config.minFrames;
                if (result.guildTotalFrames >= checkValue || result.totalFame >= checkValue) {
                    const channel = await client.channels.fetch(config.channelId).catch(() => null);
                    if (channel) {
                        await channel.send({
                            content: 
                                `🚨 **Auto-Battle Alert!** ตรวจพบไฟต์ใหม่ของกิลด์ **${config.targetGuild}**\n` +
                                `⚔️ รวม Kills + Deaths: \`${result.guildTotalFrames.toLocaleString()}\`\n` +
                                `💰 Total Fame: \`${formatFame(result.totalFame)}\`\n` +
                                `🔗 **Battle Link:** <${result.battleUrl}>`
                        });

                        const reportFiles = Array.isArray(result.payload.files) ? result.payload.files : [];
                        if (reportFiles.length > 0) {
                            for (const file of reportFiles) {
                                await channel.send({ files: [file] });
                            }
                        } else {
                            await channel.send({ content: result.payload.content });
                        }
                    }
                }
                
                processedBattles.add(latestMatchId);
            } catch (e) {
                console.error(`❌ Auto-Battle Error on Match ID ${latestMatchId} for guild ${config.targetGuild}:`, e.message);
            }

            if (processedBattles.size > 300) {
                const arr = [...processedBattles];
                processedBattles = new Set(arr.slice(150));
            }
        }
    } catch (err) {
        console.error('❌ Auto-Battle background polling error:', err.message);
    } finally {
        autoBattleCheckRunning = false;
    }
}

const commands = [
    new SlashCommandBuilder().setName('check').setDescription('ระบบตรวจสอบสถิติและรายชื่อ')
        .addSubcommand(s => s.setName('battles').setDescription('เช็กสถิติไฟต์จาก Match ID หรือ ลิงก์').addStringOption(o => o.setName('link_or_id').setDescription('ลิงก์ AlbionBB หรือ Match ID').setRequired(true)))
        .addSubcommand(s => s.setName('guilds').setDescription('แสดงรายชื่อกิลด์ที่ติดตาม'))
        .addSubcommand(s => s.setName('members').setDescription('แสดงรายชื่อผู้เล่นที่ติดตาม')),
    new SlashCommandBuilder().setName('add').setDescription('เพิ่มรายการติดตาม')
        .addSubcommand(s => s.setName('guild').setDescription('เพิ่มกิลด์และกำหนดห้องสำหรับดึงข้อมูลเมื่อวางลิงก์')
            .addStringOption(o => o.setName('name').setDescription('ชื่อกิลด์').setRequired(true))
            .addChannelOption(o => o.setName('channel').setDescription('ห้องที่อนุญาตให้วางลิงก์เพื่อดึงข้อมูลอัตโนมัติ').addChannelTypes(ChannelType.GuildText).setRequired(true)))
        .addSubcommand(s => s.setName('player').setDescription('เพิ่มผู้เล่น').addStringOption(o => o.setName('name').setDescription('ชื่อผู้เล่น').setRequired(true))),
    new SlashCommandBuilder().setName('remove').setDescription('ลบรายการติดตาม')
        .addSubcommand(s => s.setName('guild').setDescription('ลบกิลด์').addStringOption(o => o.setName('name').setDescription('ชื่อกิลด์').setRequired(true)))
        .addSubcommand(s => s.setName('player').setDescription('ลบผู้เล่น').addStringOption(o => o.setName('name').setDescription('ชื่อผู้เล่น').setRequired(true))),
    new SlashCommandBuilder().setName('autobattle').setDescription('จัดการระบบติดตามไฟต์อัตโนมัติ')
        .addSubcommand(s => s.setName('set').setDescription('ตั้งค่าระบบติดตามไฟต์อัตโนมัติ')
            .addChannelOption(o => o.setName('channel').setDescription('ห้องที่ต้องการให้แจ้งเตือน').addChannelTypes(ChannelType.GuildText).setRequired(true))
            .addStringOption(o => o.setName('guild').setDescription('ชื่อ Guild ที่ต้องการติดตาม').setRequired(true))
            .addStringOption(o => o.setName('min_frames').setDescription('จำนวนขั้นต่ำ เช่น 200K (Fame หรือ Kills+Deaths)').setRequired(true)))
        .addSubcommand(s => s.setName('list').setDescription('แสดงรายชื่อกิลด์ที่ตั้งค่า Auto-Battle ในเซิร์ฟเวอร์นี้'))
        .addSubcommand(s => s.setName('remove').setDescription('ลบกิลด์ที่ตั้งค่า Auto-Battle ออก')
            .addStringOption(o => o.setName('guild').setDescription('ชื่อ Guild ที่ต้องการยกเลิกติดตาม Auto-Battle').setRequired(true)))
].map(c => c.toJSON());

client.once('clientReady', async () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('✅ Slash commands registered.');
    } catch (err) { console.error('❌ Slash command registration error:', err); }

    setTimeout(async () => {
        for (const config of autoBattleConfigs) {
            const matches = await fetchGuildRecentBattles(config.targetGuild);
            if (matches.length > 0) {
                processedBattles.add(matches[0]);
            }
        }
        console.log('🛡️ Auto-Battle initialized and synced latest matches.');
    }, 5000);

    setInterval(checkAutoBattles, 5 * 60 * 1000);
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    const { commandName } = interaction;

    if (commandName === 'check') {
        const sub = interaction.options.getSubcommand();
        if (sub === 'guilds') {
            if (!targetGuilds.length) return interaction.reply('🛡️ ไม่มีกิลด์ในระบบติดตาม');
            const listFormatted = targetGuilds.map((g, i) => `${i + 1}. ${g.name} ${g.channelId ? `(ห้อง: <#${g.channelId}>)` : ''}`).join('\n');
            return interaction.reply(`🛡️ **กิลด์ที่ติดตาม (${targetGuilds.length})**\n\`\`\`\n${listFormatted}\n\`\`\``);
        }
        if (sub === 'members') {
            if (!targetPlayers.length) return interaction.reply('📋 ไม่มีผู้เล่นในระบบติดตาม');
            return interaction.reply(`📋 **ผู้เล่นที่ติดตาม (${targetPlayers.length})**\n\`\`\`\n${targetPlayers.map((x, i) => `${i + 1}. ${x}`).join('\n')}\n\`\`\``);
        }
        if (sub === 'battles') {
            await interaction.deferReply();
            return processBattleReport(interaction.options.getString('link_or_id'), interaction);
        }
    }

    if (commandName === 'add') {
        const sub = interaction.options.getSubcommand();
        if (sub === 'guild') {
            const name = interaction.options.getString('name').trim();
            const channel = interaction.options.getChannel('channel');

            const existingIndex = targetGuilds.findIndex(x => x.name.toLowerCase() === name.toLowerCase());
            if (existingIndex >= 0) {
                targetGuilds[existingIndex].channelId = channel.id;
                saveData();
                return interaction.reply(`🛡️ อัปเดตห้องสำหรับกิลด์ **${name}** เป็น <#${channel.id}> เรียบร้อยแล้ว`);
            }

            targetGuilds.push({ name, channelId: channel.id });
            saveData();
            return interaction.reply(`🛡️ เพิ่มกิลด์ **${name}** และกำหนดให้ดึงข้อมูลอัตโนมัติเฉพาะในห้อง <#${channel.id}> เรียบร้อยแล้วครับ`);
        }
        if (sub === 'player') {
            const name = interaction.options.getString('name').trim();
            if (targetPlayers.some(x => x.toLowerCase() === name.toLowerCase())) return interaction.reply({ content: `⚠️ ผู้เล่น **${name}** มีอยู่แล้ว`, flags: 64 });
            targetPlayers.push(name); saveData(); return interaction.reply(`✅ เพิ่มผู้เล่น **${name}** แล้ว`);
        }
    }

    if (commandName === 'remove') {
        const sub = interaction.options.getSubcommand(), name = interaction.options.getString('name').trim();
        if (sub === 'guild') {
            const before = targetGuilds.length; 
            targetGuilds = targetGuilds.filter(x => x.name.toLowerCase() !== name.toLowerCase());
            if (before === targetGuilds.length) return interaction.reply({ content: `❌ ไม่พบกิลด์ **${name}**`, flags: 64 });
            saveData(); return interaction.reply(`🗑️ ลบกิลด์ **${name}** แล้ว`);
        }
        if (sub === 'player') {
            const before = targetPlayers.length; targetPlayers = targetPlayers.filter(x => x.toLowerCase() !== name.toLowerCase());
            if (before === targetPlayers.length) return interaction.reply({ content: `❌ ไม่พบผู้เล่น **${name}**`, flags: 64 });
            saveData(); return interaction.reply(`🗑️ ลบผู้เล่น **${name}** แล้ว`);
        }
    }

    if (commandName === 'autobattle') {
        const sub = interaction.options.getSubcommand();

        if (sub === 'set') {
            await interaction.deferReply();
            const channel = interaction.options.getChannel('channel');
            const guildName = interaction.options.getString('guild').trim();
            const minFramesInput = interaction.options.getString('min_frames');
            const minFrames = parseFameValue(minFramesInput);

            let existingConfigs = autoBattleConfigs.filter(c => c.guildId === interaction.guildId);
            const duplicateIndex = existingConfigs.findIndex(c => c.targetGuild.toLowerCase() === guildName.toLowerCase());

            const configData = {
                guildId: interaction.guildId,
                channelId: channel.id,
                targetGuild: guildName,
                minFrames: minFrames
            };

            if (duplicateIndex >= 0) {
                const globalIndex = autoBattleConfigs.findIndex(c => c.guildId === interaction.guildId && c.targetGuild.toLowerCase() === guildName.toLowerCase());
                if (globalIndex >= 0) autoBattleConfigs[globalIndex] = configData;
            } else {
                autoBattleConfigs.push(configData);
            }
            saveData();

            return interaction.editReply(`✅ ตั้งค่า **Auto-Battle Tracker** สำเร็จเรียบร้อย!\n- 🌐 เซิร์ฟเวอร์: **EAST (ตายตัว)**\n- 📢 ห้องแจ้งเตือน: <#${channel.id}>\n- 🛡️ กิลด์ที่ติดตาม: **${guildName}**\n- ⚔️ ขั้นต่ำ: **${minFrames.toLocaleString()}**\n\n📌 *ระบบจะคอยตรวจสอบไฟต์การต่อสู้ใหม่ๆ ของกิลด์นี้ให้อัตโนมัติทุกๆ 5 นาทีครับ*`);
        }

        if (sub === 'list') {
            const serverConfigs = autoBattleConfigs.filter(c => c.guildId === interaction.guildId);
            if (!serverConfigs.length) return interaction.reply({ content: '🛡️ เซิร์ฟเวอร์นี้ยังไม่มีการตั้งค่า Auto-Battle สำหรับกิลด์ใดๆ', flags: 64 });

            let listText = serverConfigs.map((c, i) => `${i + 1}. กิลด์: **${c.targetGuild}** | ห้อง: <#${c.channelId}> | ขั้นต่ำ: **${(c.minFrames || 0).toLocaleString()}**`).join('\n');
            const embed = new EmbedBuilder()
                .setColor(0x3498db)
                .setTitle(`🛡️ รายชื่อกิลด์ที่ติดตาม Auto-Battle ในเซิร์ฟเวอร์นี้ (${serverConfigs.length})`)
                .setDescription(listText)
                .setTimestamp();
            return interaction.reply({ embeds: [embed] });
        }

        if (sub === 'remove') {
            const guildName = interaction.options.getString('guild').trim();
            const beforeCount = autoBattleConfigs.length;
            
            autoBattleConfigs = autoBattleConfigs.filter(c => !(c.guildId === interaction.guildId && c.targetGuild.toLowerCase() === guildName.toLowerCase()));

            if (beforeCount === autoBattleConfigs.length) {
                return interaction.reply({ content: `❌ ไม่พบกิลด์ **${guildName}** ในระบบ Auto-Battle ของเซิร์ฟเวอร์นี้`, flags: 64 });
            }

            saveData();
            return interaction.reply(`🗑️ ลบกิลด์ **${guildName}** ออกจากระบบ Auto-Battle เรียบร้อยแล้ว`);
        }
    }
});

client.on('messageCreate', async message => {
    if (message.author.bot) return;
    const match = message.content.match(/https?:\/\/(?:east\.)?albionbb\.com\/battles\/[^\s]+/i);
    if (!match) return;

    const matchingGuildConfig = targetGuilds.find(g => g.channelId === message.channel.id);
    if (targetGuilds.some(g => g.channelId) && !matchingGuildConfig) {
        return; 
    }

    try {
        const status = await message.reply('⏳ กำลังดึงสถิติและสร้างรายงานจาก Official Albion API...');
        await processBattleReport(match[0], status, true);
    } catch (err) { console.error('❌ messageCreate error:', err); }
});

client.on('error', err => console.error('❌ Discord client error:', err));
process.on('unhandledRejection', err => console.error('❌ Unhandled rejection:', err));
process.on('uncaughtException', err => console.error('❌ Uncaught exception:', err));

console.log('🛡️ AUTO-BATTLE FIX V3 LOADED: Fully automated battle reports enabled');

client.login(BOT_TOKEN);