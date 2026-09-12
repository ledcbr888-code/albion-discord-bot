// AUTO-BATTLE FIX V3 (STABLE CANVAS) + DAILY BONUS COMMAND & AUTOMATION
const {
    Client,
    GatewayIntentBits,
    SlashCommandBuilder,
    REST,
    Routes,
    EmbedBuilder,
    AttachmentBuilder,
    ChannelType,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    PermissionsBitField
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
let dailyAutoConfigs = []; // เก็บตั้งค่ารายงาน daily อัตโนมัติ [{ guildId, channelId, serverChoice }]
let banditAutoConfigs = []; // [{ guildId, channelId, server, lastMessageId }]
let processedBattles = new Set();
let autoBattleCheckRunning = false;
let lastDailyReportDate = {}; // ป้องกันการส่งซ้ำ แยกตาม guild และ server
let lastBanditAlertKey = {};

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
        dailyAutoConfigs = Array.isArray(data.dailyAuto) ? data.dailyAuto : [];
        banditAutoConfigs = Array.isArray(data.banditAuto) ? data.banditAuto : [];

        console.log(`📁 Tracking: ${targetGuilds.length} guilds, ${targetPlayers.length} players, ${autoBattleConfigs.length} auto-battle configs, ${dailyAutoConfigs.length} daily auto configs, ${banditAutoConfigs.length} bandit configs`);
    } catch (err) {
        console.error('❌ tracking.json load error:', err.message);
        targetPlayers = [];
        targetGuilds = [];
        autoBattleConfigs = [];
        dailyAutoConfigs = [];
        banditAutoConfigs = [];
    }
}

function saveData() {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify({
            players: targetPlayers,
            guilds: targetGuilds,
            autoBattles: autoBattleConfigs,
            dailyAuto: dailyAutoConfigs,
            banditAuto: banditAutoConfigs
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
                const info = extractMainHandInfo(entity);
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
        totalKills += k;
        totalDeaths += d;
        totalFame += f;
        if (k > topKiller.kills) topKiller = { name: p.displayName || p.name, kills: k };
        if (f > mvp.fame) mvp = { name: p.displayName || p.name, fame: f };
    });

    const playersPerRow = 7;
    const cardWidth = 210;
    const cardHeight = 214;
    const gapX = 14, gapY = 14, padding = 30;
    const headerHeight = 96, statsHeight = 92;
    const gridOffsetY = padding + headerHeight + statsHeight + 20;
    const columns = Math.min(playersPerRow, sortedPlayers.length);
    const rows = Math.ceil(sortedPlayers.length / playersPerRow);
    const width = Math.max(1600, padding * 2 + columns * cardWidth + (columns - 1) * gapX);
    const footerHeight = 58;
    const height = gridOffsetY + rows * cardHeight + (rows - 1) * gapY + footerHeight + padding;

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.antialias = 'subpixel';

    const qualityMeta = {
        1: { label: 'NORMAL', color: '#94a3b8' },
        2: { label: 'GOOD', color: '#60a5fa' },
        3: { label: 'OUTSTANDING', color: '#a78bfa' },
        4: { label: 'EXCELLENT', color: '#f59e0b' },
        5: { label: 'MASTERPIECE', color: '#fbbf24' }
    };

    function rounded(x, y, w, h, r, fill, stroke = null, line = 1) {
        drawRoundRect(ctx, x, y, w, h, r);
        if (fill) { ctx.fillStyle = fill; ctx.fill(); }
        if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = line; ctx.stroke(); }
    }

    function textFit(text, maxWidth, startSize, weight = 'bold') {
        let size = startSize;
        while (size > 8) {
            ctx.font = `${weight} ${size}px Arial, sans-serif`;
            if (ctx.measureText(text).width <= maxWidth) return size;
            size -= 1;
        }
        return size;
    }

    function centerText(text, cx, y, size, color, weight = 'bold', maxWidth = Infinity) {
        const fs = maxWidth < Infinity ? textFit(text, maxWidth, size, weight) : size;
        ctx.save();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.font = `${weight} ${fs}px Arial, sans-serif`;
        ctx.fillStyle = color;
        ctx.fillText(text, cx, y);
        ctx.restore();
    }

    function drawSwordIcon(cx, cy, scale, color) {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(-Math.PI / 4);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.shadowColor = color;
        ctx.shadowBlur = 8 * scale;
        ctx.fillStyle = color;
        ctx.strokeStyle = color;
        ctx.lineWidth = 2 * scale;

        for (const off of [-5, 5]) {
            ctx.save();
            ctx.translate(off * scale, 0);
            ctx.beginPath();
            ctx.moveTo(0, -17 * scale);
            ctx.lineTo(3 * scale, 10 * scale);
            ctx.lineTo(-3 * scale, 10 * scale);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(-8 * scale, 8 * scale);
            ctx.lineTo(8 * scale, 8 * scale);
            ctx.stroke();
            ctx.fillRect(-2 * scale, 9 * scale, 4 * scale, 8 * scale);
            ctx.restore();
        }
        ctx.restore();
    }

    function drawSkullIcon(cx, cy, scale, color) {
        ctx.save();
        ctx.shadowColor = color;
        ctx.shadowBlur = 9 * scale;
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = 2 * scale;
        ctx.beginPath();
        ctx.arc(cx, cy - 3 * scale, 11 * scale, Math.PI, 0);
        ctx.lineTo(cx + 9 * scale, cy + 7 * scale);
        ctx.lineTo(cx + 5 * scale, cy + 12 * scale);
        ctx.lineTo(cx - 5 * scale, cy + 12 * scale);
        ctx.lineTo(cx - 9 * scale, cy + 7 * scale);
        ctx.closePath();
        ctx.stroke();
        ctx.fillRect(cx - 6 * scale, cy + 10 * scale, 12 * scale, 4 * scale);
        ctx.fillStyle = '#070d17';
        ctx.beginPath(); ctx.arc(cx - 4 * scale, cy - 3 * scale, 2.2 * scale, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(cx + 4 * scale, cy - 3 * scale, 2.2 * scale, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.moveTo(cx, cy + 1 * scale); ctx.lineTo(cx - 2 * scale, cy + 6 * scale); ctx.lineTo(cx + 2 * scale, cy + 6 * scale); ctx.closePath(); ctx.fill();
        ctx.restore();
    }

    function drawGemIcon(cx, cy, scale, color) {
        ctx.save();
        ctx.shadowColor = color;
        ctx.shadowBlur = 12 * scale;
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = 2 * scale;
        ctx.beginPath();
        ctx.moveTo(cx, cy - 15 * scale);
        ctx.lineTo(cx + 12 * scale, cy - 6 * scale);
        ctx.lineTo(cx + 8 * scale, cy + 11 * scale);
        ctx.lineTo(cx, cy + 16 * scale);
        ctx.lineTo(cx - 8 * scale, cy + 11 * scale);
        ctx.lineTo(cx - 12 * scale, cy - 6 * scale);
        ctx.closePath();
        ctx.stroke();
        ctx.globalAlpha = .18;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.beginPath(); ctx.moveTo(cx, cy - 14 * scale); ctx.lineTo(cx, cy + 14 * scale); ctx.moveTo(cx - 11 * scale, cy - 5 * scale); ctx.lineTo(cx + 11 * scale, cy - 5 * scale); ctx.stroke();
        ctx.restore();
    }

    function drawCrownIcon(cx, cy, scale, color) {
        ctx.save();
        ctx.shadowColor = color;
        ctx.shadowBlur = 12 * scale;
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = 2 * scale;
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(cx - 15 * scale, cy - 8 * scale);
        ctx.lineTo(cx - 7 * scale, cy - 1 * scale);
        ctx.lineTo(cx, cy - 13 * scale);
        ctx.lineTo(cx + 7 * scale, cy - 1 * scale);
        ctx.lineTo(cx + 15 * scale, cy - 8 * scale);
        ctx.lineTo(cx + 11 * scale, cy + 10 * scale);
        ctx.lineTo(cx - 11 * scale, cy + 10 * scale);
        ctx.closePath();
        ctx.stroke();
        ctx.globalAlpha = .20; ctx.fill(); ctx.globalAlpha = 1;
        ctx.fillRect(cx - 12 * scale, cy + 10 * scale, 24 * scale, 4 * scale);
        ctx.restore();
    }

    function drawMedalIcon(cx, cy, scale, color) {
        ctx.save();
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.shadowColor = color;
        ctx.shadowBlur = 14 * scale;
        ctx.lineWidth = 2 * scale;
        ctx.beginPath();
        ctx.moveTo(cx - 7 * scale, cy - 13 * scale); ctx.lineTo(cx - 3 * scale, cy - 2 * scale); ctx.lineTo(cx + 3 * scale, cy - 2 * scale); ctx.lineTo(cx + 7 * scale, cy - 13 * scale); ctx.stroke();
        ctx.beginPath(); ctx.arc(cx, cy + 5 * scale, 11 * scale, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.arc(cx, cy + 5 * scale, 5 * scale, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
    }

    function drawCrosshair(cx, cy, r, color) {
        ctx.save();
        ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.globalAlpha = .35;
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
        for (const a of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
            ctx.beginPath();
            ctx.moveTo(cx + Math.cos(a) * (r + 4), cy + Math.sin(a) * (r + 4));
            ctx.lineTo(cx + Math.cos(a) * (r + 13), cy + Math.sin(a) * (r + 13));
            ctx.stroke();
        }
        ctx.restore();
    }

    function drawStatIcon(cx, cy, color, type) {
        ctx.save();
        ctx.fillStyle = '#0b1423';
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.shadowColor = color;
        ctx.shadowBlur = 12;
        ctx.beginPath(); ctx.arc(cx, cy, 25, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.globalAlpha = .18;
        ctx.beginPath(); ctx.arc(cx, cy, 21, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
        ctx.globalAlpha = 1;
        if (type === 'kills') drawSwordIcon(cx, cy, .82, color);
        if (type === 'deaths') drawSkullIcon(cx, cy, .78, color);
        if (type === 'fame') drawGemIcon(cx, cy, .75, color);
        if (type === 'killer') drawCrownIcon(cx, cy, .78, color);
        if (type === 'mvp') drawMedalIcon(cx, cy, .82, color);
        ctx.restore();
    }

    ctx.fillStyle = '#02050a'; ctx.fillRect(0, 0, width, height);
    const bg = ctx.createRadialGradient(width * .52, 90, 20, width * .52, height * .45, width * .82);
    bg.addColorStop(0, '#17243b'); bg.addColorStop(.38, '#0a1322'); bg.addColorStop(1, '#010409');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, width, height);

    ctx.save();
    ctx.strokeStyle = 'rgba(148,163,184,.075)'; ctx.lineWidth = 1;
    for (let x = 0; x <= width; x += 32) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke(); }
    for (let y = 0; y <= height; y += 32) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke(); }
    ctx.strokeStyle = 'rgba(220,38,38,.045)';
    for (let x = -height; x < width; x += 210) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + height, height); ctx.stroke(); }
    ctx.restore();

    const edge = ctx.createLinearGradient(0, 0, width, 0);
    edge.addColorStop(0, '#dc2626'); edge.addColorStop(.5, '#f59e0b'); edge.addColorStop(1, '#dc2626');
    ctx.fillStyle = edge; ctx.fillRect(0, 0, width, 4);

    drawCrosshair(width - 92, 55, 25, '#ef4444');
    ctx.save();
    ctx.shadowColor = 'rgba(255,255,255,.16)'; ctx.shadowBlur = 12;
    ctx.fillStyle = '#f8fafc'; ctx.font = '900 38px Arial, sans-serif';
    ctx.fillText('BATTLE REPORT', padding, padding + 37);
    ctx.restore();
    ctx.fillStyle = '#94a3b8'; ctx.font = 'bold 12px Arial, sans-serif';
    ctx.fillText(`EAST SERVER   |   ${formatUTCTime(battleInfo.battleTime || Date.now())}   |   MATCH ID: ${battleInfo.matchId || 'N/A'}`, padding + 1, padding + 60);
    ctx.fillStyle = '#ef4444'; ctx.font = '900 10px Arial, sans-serif';
    ctx.fillText('COMBAT ANALYTICS  /  LIVE BATTLE DATA', padding + 1, padding + 79);

    const badgeW = 184, badgeH = 62, badgeX = width - padding - badgeW, badgeY = 23;
    rounded(badgeX, badgeY, badgeW, badgeH, 14, '#08111f', '#334b70', 1.2);
    ctx.fillStyle = '#101c2f'; drawRoundRect(ctx, badgeX + 6, badgeY + 6, 54, badgeH - 12, 10); ctx.fill();
    centerText(String(sortedPlayers.length), badgeX + 33, badgeY + 39, 25, '#f8fafc', '900');
    ctx.fillStyle = '#64748b'; ctx.font = '900 10px Arial, sans-serif'; ctx.fillText('PLAYERS', badgeX + 73, badgeY + 27);
    ctx.fillStyle = '#cbd5e1'; ctx.font = 'bold 11px Arial, sans-serif'; ctx.fillText('IN BATTLE', badgeX + 73, badgeY + 45);

    const statY = padding + headerHeight;
    const statGap = 12;
    const statW = (width - padding * 2 - statGap * 4) / 5;
    const statH = 82;
    const stats = [
        { label: 'TOTAL KILLS', value: totalKills.toLocaleString(), sub: 'ELIMINATIONS', color: '#ef4444', icon: 'kills' },
        { label: 'TOTAL DEATHS', value: totalDeaths.toLocaleString(), sub: 'CASUALTIES', color: '#f87171', icon: 'deaths' },
        { label: 'TOTAL FAME', value: formatFame(totalFame), sub: 'KILL FAME', color: '#fbbf24', icon: 'fame' },
        { label: 'TOP KILLER', value: String(topKiller.name), sub: `${topKiller.kills} KILLS`, color: '#d946ef', icon: 'killer' },
        { label: 'MVP  /  TOP FAME', value: String(mvp.name), sub: `${formatFame(mvp.fame)} FAME`, color: '#f59e0b', icon: 'mvp' }
    ];

    stats.forEach((st, i) => {
        const x = padding + i * (statW + statGap);
        rounded(x, statY, statW, statH, 13, '#08111f', '#1e3049', 1.2);
        ctx.fillStyle = st.color; drawRoundRect(ctx, x, statY, 4, statH, 3); ctx.fill();
        drawStatIcon(x + 32, statY + 41, st.color, st.icon);
        ctx.fillStyle = '#64748b'; ctx.font = '900 9px Arial, sans-serif'; ctx.fillText(st.label, x + 66, statY + 23);
        const val = String(st.value);
        const fs = textFit(val, statW - 78, i >= 3 ? 18 : 22, '900');
        ctx.font = `900 ${fs}px Arial, sans-serif`;
        ctx.fillStyle = '#f8fafc';
        ctx.fillText(val, x + 66, statY + 49);
        ctx.fillStyle = st.color; ctx.font = '900 8px Arial, sans-serif'; ctx.fillText(st.sub, x + 66, statY + 67);
    });

    const iconImages = await Promise.all(sortedPlayers.map(p => loadAlbionWeaponIcon(p.weapon, p.weaponQuality || 1)));

    sortedPlayers.forEach((p, i) => {
        const col = i % playersPerRow;
        const row = Math.floor(i / playersPerRow);
        const x = padding + col * (cardWidth + gapX);
        const y = gridOffsetY + row * (cardHeight + gapY);
        const isMVP = i === 0;
        const k = Number(p.kills) || 0;
        const d = Number(p.deaths) || 0;
        const q = Math.max(1, Math.min(5, Number(p.weaponQuality) || 1));
        const qm = qualityMeta[q];
        const cx = x + cardWidth / 2;

        rounded(x, y, cardWidth, cardHeight, 15, isMVP ? '#111a2b' : '#07101c', isMVP ? '#f59e0b' : '#22344d', isMVP ? 2 : 1.2);
        if (isMVP) {
            ctx.save();
            ctx.shadowColor = 'rgba(245,158,11,.35)'; ctx.shadowBlur = 20;
            ctx.strokeStyle = '#f59e0b'; ctx.lineWidth = 1.5;
            drawRoundRect(ctx, x, y, cardWidth, cardHeight, 15); ctx.stroke();
            ctx.restore();
        }

        rounded(x + 10, y + 10, 38, 23, 7, isMVP ? '#f59e0b' : '#142238', isMVP ? '#fcd34d' : '#2a405e', 1);
        centerText(String(i + 1).padStart(2, '0'), x + 29, y + 26, 11, isMVP ? '#111827' : '#cbd5e1', '900');

        if (isMVP) {
            ctx.fillStyle = '#fbbf24'; ctx.font = '900 9px Arial, sans-serif'; ctx.fillText('MVP', x + cardWidth - 40, y + 26);
        }

        const wy = y + 63;
        ctx.save();
        ctx.shadowColor = qm.color; ctx.shadowBlur = isMVP ? 18 : 10;
        ctx.fillStyle = '#030811';
        ctx.beginPath(); ctx.arc(cx, wy, 45, 0, Math.PI * 2); ctx.fill();
        ctx.shadowBlur = 0;
        ctx.strokeStyle = qm.color; ctx.lineWidth = isMVP ? 2.4 : 1.8;
        ctx.beginPath(); ctx.arc(cx, wy, 45, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = 'rgba(255,255,255,.13)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(cx, wy, 37, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();

        ctx.save();
        ctx.strokeStyle = qm.color; ctx.lineWidth = 2; ctx.globalAlpha = .65;
        [[0,-49,0,-56],[0,49,0,56],[-49,0,-56,0],[49,0,56,0]].forEach(a => {
            ctx.beginPath(); ctx.moveTo(cx + a[0], wy + a[1]); ctx.lineTo(cx + a[2], wy + a[3]); ctx.stroke();
        });
        ctx.restore();

        if (iconImages[i]) {
            try { ctx.drawImage(iconImages[i], cx - 36, wy - 36, 72, 72); } catch (_) {}
        } else {
            drawSwordIcon(cx, wy, 1.7, qm.color);
        }

        const qText = `Q${q}  ${qm.label}`;
        ctx.font = '900 8px Arial, sans-serif';
        const qw = ctx.measureText(qText).width + 18;
        rounded(cx - qw / 2, y + 108, qw, 17, 8, '#050b14', qm.color, 1);
        centerText(qText, cx, y + 120, 8, qm.color, '900');

        let name = String(p.displayName || p.name || 'Unknown').trim();
        if (name.length > 22) name = `${name.slice(0, 20)}..`;
        const nameSize = textFit(name, cardWidth - 20, 15, '900');
        ctx.save();
        ctx.textAlign = 'center';
        ctx.font = `900 ${nameSize}px Arial, sans-serif`;
        ctx.lineWidth = 3;
        ctx.strokeStyle = '#02060c';
        ctx.strokeText(name, cx, y + 145);
        ctx.fillStyle = isMVP ? '#fef3c7' : '#f8fafc';
        ctx.shadowColor = isMVP ? 'rgba(245,158,11,.25)' : 'rgba(255,255,255,.10)';
        ctx.shadowBlur = 5;
        ctx.fillText(name, cx, y + 145);
        ctx.restore();

        const guild = String(p.guild || '').trim();
        if (guild) {
            let g = guild.length > 21 ? `${guild.slice(0, 19)}..` : guild;
            centerText(g, cx, y + 158, 8, '#64748b', 'bold', cardWidth - 20);
        }

        const metricY = y + 180;
        centerText(String(k), cx - 18, metricY, 12, k > 0 ? '#ef4444' : '#64748b', '900');
        centerText('/', cx, metricY, 11, '#475569', '900');
        centerText(String(d), cx + 18, metricY, 12, d > 0 ? '#f87171' : '#64748b', '900');

        const fameText = formatFame(p.fame || 0);
        const famePillW = 112;
        const famePillH = 23;
        const fameX = cx - famePillW / 2;
        const fameY = y + cardHeight - 31;
        rounded(fameX, fameY, famePillW, famePillH, 10, '#0b1422', isMVP ? '#8b6518' : '#263a55', 1);
        if (fameImg) {
            try { ctx.drawImage(fameImg, fameX + 10, fameY + 5, 13, 13); } catch (_) {}
        } else {
            drawGemIcon(fameX + 17, fameY + 11, .35, '#fbbf24');
        }
        centerText(fameText, fameX + 72, fameY + 16, 11, '#fbbf24', '900');
    });

    const footerY = height - padding - 13;
    ctx.strokeStyle = '#1b2b42'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padding, footerY - 25); ctx.lineTo(width - padding, footerY - 25); ctx.stroke();
    ctx.fillStyle = '#64748b'; ctx.font = '900 9px Arial, sans-serif';
    ctx.fillText('VICTORY BELONGS TO THOSE WHO FIGHT TOGETHER', padding, footerY);
    ctx.fillStyle = '#ef4444'; ctx.font = '900 9px Arial, sans-serif';
    const powered = 'POWERED BY  •  BOTBOSS';
    ctx.fillText(powered, width - padding - ctx.measureText(powered).width, footerY);

    return new AttachmentBuilder(canvas.toBuffer('image/png'), { name: 'battle-report.png' });
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

// ---------------------------
// HELPER FOR DAILY BONUS
// ---------------------------
// Albion's public GameInfo API does NOT expose a /dailyactivity endpoint.
// Daily production bonuses are published/recorded by third-party trackers.
// AO-SAGE publicly shows the current bonus for all three live servers.
const DAILY_BONUS_SOURCE = 'https://ao-sage.com/';
const DAILY_CACHE_FILE = path.join(__dirname, 'daily-bonus-cache.json');

// Albion Data Project confirms live festivities from multiple game clients.
// It may return 404 when a server has no confirmed snapshot yet, so it is a
// fallback only and must never replace one server's data with another server's.
const AODP_FESTIVITIES_URLS = {
    west: 'https://west.albion-online-data.com/api/v2/stats/festivities',
    asia: 'https://east.albion-online-data.com/api/v2/stats/festivities',
    europe: 'https://europe.albion-online-data.com/api/v2/stats/festivities'
};

const SERVER_NAMES = {
    west: 'Americas (West)',
    asia: 'Asia (East)',
    europe: 'Europe (EU)'
};

// Daily production bonus reset times. Asia resets at 00:00 UTC (07:00 Thai),
// while Americas and Europe reset at 10:00 UTC (17:00 Thai).
const DAILY_RESET_UTC_HOURS = {
    asia: 0,
    west: 10,
    europe: 10
};

function getDailyResetText(serverKey) {
    const utcHour = DAILY_RESET_UTC_HOURS[serverKey] ?? 10;
    const thaiHour = (utcHour + 7) % 24;
    return `⏳ ${String(thaiHour).padStart(2, '0')}:00 น. ไทย (${String(utcHour).padStart(2, '0')}:00 UTC)`;
}

const DAILY_SERVER_LABELS = {
    west: 'Americas',
    asia: 'Asia',
    europe: 'Europe'
};

const DAILY_CATEGORY_META = {
    cloth_helmet: { label: 'Cloth Cowl', city: 'Thetford', baseBonus: 15 },
    cloth_robe: { label: 'Cloth Robes', city: 'Fort Sterling', baseBonus: 15 },
    cloth_boots: { label: 'Cloth Sandals', city: 'Bridgewatch', baseBonus: 15 },
    crossbow: { label: 'Crossbow', city: 'Bridgewatch', baseBonus: 15 },
    cursestaff: { label: 'Cursed Staff', city: 'Bridgewatch', baseBonus: 15 },
    dagger: { label: 'Dagger', city: 'Bridgewatch', baseBonus: 15 },
    plate_armor: { label: 'Plate Armor', city: 'Bridgewatch', baseBonus: 15 },
    stone: { label: 'Stone', city: 'Bridgewatch', baseBonus: 40 },
    hammer: { label: 'Hammer', city: 'Fort Sterling', baseBonus: 15 },
    holystaff: { label: 'Holy Staff', city: 'Fort Sterling', baseBonus: 15 },
    plate_helmet: { label: 'Plate Helmet', city: 'Fort Sterling', baseBonus: 15 },
    spear: { label: 'Spear', city: 'Fort Sterling', baseBonus: 15 },
    wood: { label: 'Wood', city: 'Fort Sterling', baseBonus: 40 },
    arcane_staff: { label: 'Arcane Staff', city: 'Lymhurst', baseBonus: 15 },
    bow: { label: 'Bow', city: 'Lymhurst', baseBonus: 15 },
    fiber: { label: 'Fiber', city: 'Lymhurst', baseBonus: 40 },
    leather_helmet: { label: 'Leather Hood', city: 'Lymhurst', baseBonus: 15 },
    leather_shoes: { label: 'Leather Shoes', city: 'Lymhurst', baseBonus: 15 },
    sword: { label: 'Sword', city: 'Lymhurst', baseBonus: 15 },
    axe: { label: 'Axe', city: 'Martlock', baseBonus: 15 },
    froststaff: { label: 'Frost Staff', city: 'Martlock', baseBonus: 15 },
    hide: { label: 'Hide', city: 'Martlock', baseBonus: 40 },
    offhand: { label: 'Off-Hand', city: 'Martlock', baseBonus: 15 },
    plate_boots: { label: 'Plate Boots', city: 'Martlock', baseBonus: 15 },
    quarterstaff: { label: 'Quarterstaff', city: 'Martlock', baseBonus: 15 },
    firestaff: { label: 'Fire Staff', city: 'Thetford', baseBonus: 15 },
    leather_jacket: { label: 'Leather Jackets', city: 'Thetford', baseBonus: 15 },
    mace: { label: 'Mace', city: 'Thetford', baseBonus: 15 },
    naturestaff: { label: 'Nature Staff', city: 'Thetford', baseBonus: 15 },
    ore: { label: 'Ore', city: 'Thetford', baseBonus: 40 },
    food: { label: 'Food', city: 'Caerleon', baseBonus: 15 },
    gathering_gear: { label: 'Gathering Gear', city: 'Caerleon', baseBonus: 15 },
    shapeshifter_staff: { label: 'Shapeshifter Staff', city: 'Caerleon', baseBonus: 15 },
    tool: { label: 'Tool', city: 'Caerleon', baseBonus: 15 },
    war_gloves: { label: 'War Gloves', city: 'Caerleon', baseBonus: 15 },
    bag: { label: 'Bag', city: 'Brecilien', baseBonus: 15 },
    cape: { label: 'Cape', city: 'Brecilien', baseBonus: 15 },
    potion: { label: 'Potion', city: 'Brecilien', baseBonus: 15 }
};

const DAILY_CATEGORY_ALIASES = {
    cloth_cowl: 'cloth_helmet',
    cloth_helmet: 'cloth_helmet',
    cloth_robe: 'cloth_robe',
    cloth_sandals: 'cloth_boots',
    leather_hood: 'leather_helmet',
    leather_jackets: 'leather_jacket',
    arcane_staff: 'arcane_staff',
    frost_staff: 'froststaff',
    holy_staff: 'holystaff',
    fire_staff: 'firestaff',
    nature_staff: 'naturestaff',
    quarter_staff: 'quarterstaff',
    gathering_equipment: 'gathering_gear',
    shapeshifterstaff: 'shapeshifter_staff',
    war_glove: 'war_gloves',
    off_hand: 'offhand'
};

const DAILY_CATEGORY_ITEM_IDS = {
    'Cloth Robes': ['T4_CLOTH_ROBE', 'T5_CLOTH_ROBE', 'T6_CLOTH_ROBE', 'T7_CLOTH_ROBE', 'T8_CLOTH_ROBE', 'T4_CLOTH_ROBE@1', 'T5_CLOTH_ROBE@1', 'T6_CLOTH_ROBE@1', 'T7_CLOTH_ROBE@1'],
    'Leather Jackets': ['T4_LEATHER_JACKET', 'T5_LEATHER_JACKET', 'T6_LEATHER_JACKET', 'T7_LEATHER_JACKET', 'T8_LEATHER_JACKET', 'T4_LEATHER_JACKET@1', 'T5_LEATHER_JACKET@1', 'T6_LEATHER_JACKET@1', 'T7_LEATHER_JACKET@1'],
    'Cloth Cowl': ['T4_CLOTH_COWL', 'T5_CLOTH_COWL', 'T6_CLOTH_COWL', 'T7_CLOTH_COWL', 'T8_CLOTH_COWL', 'T4_CLOTH_COWL@1', 'T5_CLOTH_COWL@1', 'T6_CLOTH_COWL@1', 'T7_CLOTH_COWL@1'],
    'Nature Staff': ['T4_MAIN_NATURESTAFF', 'T5_MAIN_NATURESTAFF', 'T6_MAIN_NATURESTAFF', 'T7_MAIN_NATURESTAFF', 'T8_MAIN_NATURESTAFF', 'T4_MAIN_NATURESTAFF@1', 'T5_MAIN_NATURESTAFF@1', 'T6_MAIN_NATURESTAFF@1', 'T7_MAIN_NATURESTAFF@1']
};

const DAILY_CATEGORY_ICON_URLS = {
    'Cloth Robes': 'https://render.albiononline.com/v1/destiny/Cloth%20Robe%20Crafter.png?locale=en',
    'Leather Jackets': 'https://render.albiononline.com/v1/destiny/Leather%20Jacket%20Crafter.png?locale=en',
    'Cloth Cowl': 'https://render.albiononline.com/v1/destiny/Cloth%20Cowl%20Crafter.png?locale=en',
    'Nature Staff': 'https://render.albiononline.com/v1/destiny/Nature%20Staff%20Crafter.png?locale=en'
};

function dailyCategoryKey(raw) {
    const key = String(raw || '').toLowerCase().replace(/^common_|^rare_/, '').replace(/-/g, '_');
    return DAILY_CATEGORY_ALIASES[key] || key;
}

function loadDailyCache() {
    try {
        if (!fs.existsSync(DAILY_CACHE_FILE)) return null;
        const cached = JSON.parse(fs.readFileSync(DAILY_CACHE_FILE, 'utf8'));
        return cached && typeof cached === 'object' ? cached : null;
    } catch (err) {
        console.warn('⚠️ Daily cache read failed:', err.message);
        return null;
    }
}

function saveDailyCache(serverKey, data) {
    try {
        const cache = loadDailyCache() || {};
        cache[serverKey] = { ...data, cachedAt: new Date().toISOString() };
        fs.writeFileSync(DAILY_CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
    } catch (err) {
        console.warn('⚠️ Daily cache write failed:', err.message);
    }
}

function parseAodpDailyBonus(serverKey, payload) {
    if (!payload || !Array.isArray(payload.Events)) return null;

    const entries = payload.Events
        .filter(event => Number(event?.Kind) === 2 && String(event?.Category || '').toUpperCase() === 'GENERAL')
        .map(event => {
            const rawName = String(event.UniqueName || '');
            const key = dailyCategoryKey(rawName);
            const meta = DAILY_CATEGORY_META[key];
            if (!meta) return null;
            return {
                category: meta.label,
                city: meta.city,
                baseBonus: meta.baseBonus,
                dailyBonus: /^RARE_/i.test(rawName) ? 20 : 10
            };
        })
        .filter(Boolean)
        .filter((item, index, all) => all.findIndex(x => x.category === item.category) === index)
        .slice(0, 2);

    if (!entries.length) return null;
    return {
        entries,
        raw: `AODP ${payload.Server || serverKey}`,
        source: 'AODP',
        stale: false,
        date: payload.ConfirmedAt || new Date().toISOString()
    };
}

function cleanDailyText(value) {
    return String(value || '')
        .replace(/\u00a0/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function extractDailyServerBlock(bodyText, serverKey) {
    const label = DAILY_SERVER_LABELS[serverKey];
    if (!label) return '';

    const text = cleanDailyText(bodyText);
    const labels = Object.values(DAILY_SERVER_LABELS);
    const positions = [];

    // Find every standalone server heading. We intentionally keep only occurrences
    // that have another server heading after them; this avoids matching the FAQ/footer.
    const re = new RegExp(`\\b${label}\\b`, 'g');
    let match;
    while ((match = re.exec(text)) !== null) {
        positions.push(match.index);
    }

    for (const start of positions) {
        const nextPositions = labels
            .filter(x => x !== label)
            .map(x => {
                const m = text.slice(start + label.length).match(new RegExp(`\\b${x}\\b`));
                return m ? start + label.length + m.index : Infinity;
            })
            .filter(Number.isFinite)
            .sort((a, b) => a - b);

        const end = nextPositions.length ? nextPositions[0] : Math.min(text.length, start + 1200);
        const block = text.slice(start, end);

        // The homepage has a short card list for each server. A useful block normally
        // contains at least one percentage pair (+10%/+20%).
        if (/\+\d+%\s+\+\d+%/.test(block)) return block;
    }

    return '';
}

function parseDailyBonusBlock(block) {
    const result = {
        entries: [],
        raw: cleanDailyText(block)
    };

    if (!block) return result;

    // Remove the server heading itself so it cannot become part of the category name.
    block = cleanDailyText(block).replace(/^(Americas|Asia|Europe)\b/i, '').trim();

    // Parse known category/city labels instead of a greedy generic expression.
    // The generic parser could consume both cards and return stale-looking data.
    const categoryNames = Object.values(DAILY_CATEGORY_META)
        .map(x => x.label)
        .sort((a, b) => b.length - a.length)
        .map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('|');
    const cityNames = [...new Set(Object.values(DAILY_CATEGORY_META).map(x => x.city))]
        .sort((a, b) => b.length - a.length)
        .map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('|');
    const pairRe = new RegExp(`(${categoryNames})\\s+(${cityNames})\\s+\\+(\\d+)%\\s+\\+(\\d+)%`, 'gi');
    let match;
    while ((match = pairRe.exec(block)) !== null) {
        const category = cleanDailyText(match[1]);
        const city = cleanDailyText(match[2]);
        const baseBonus = Number(match[3]);
        const dailyBonus = Number(match[4]);
        if (!category || !city) continue;

        // Avoid accidental matches from unrelated page text.
        if (category.length > 70 || city.length > 45) continue;
        result.entries.push({ category, city, baseBonus, dailyBonus });
    }

    // Deduplicate cards that may appear more than once in the HTML.
    const seen = new Set();
    result.entries = result.entries.filter(item => {
        const key = `${item.category}|${item.city}|${item.baseBonus}|${item.dailyBonus}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    }).slice(0, 2);

    return result;
}

function extractDailyPageDate(html, serverKey) {
    const label = DAILY_SERVER_LABELS[serverKey];
    if (!label) return '';
    const re = new RegExp(`region:["']${serverKey}["'][^}]{0,180}?date:["'](\\d{4}-\\d{2}-\\d{2})["']`, 'i');
    const match = String(html || '').match(re);
    return match ? match[1] : '';
}

function getExpectedDailyDate() {
    return new Date().toISOString().slice(0, 10);
}

function formatIctTime(dateValue) {
    const date = new Date(dateValue || Date.now());
    return date.toLocaleTimeString('en-GB', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' });
}

function getNextResetInfo(serverKey) {
    const resetHour = DAILY_RESET_UTC_HOURS[serverKey] ?? 10;
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(resetHour, 0, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    const minutes = Math.max(0, Math.floor((next - now) / 60000));
    return {
        clock: `${String((resetHour + 7) % 24).padStart(2, '0')}:00 ICT`,
        countdown: `${Math.floor(minutes / 60)}h ${minutes % 60}m`
    };
}

async function fetchDailyBonus(serverKey) {
    try {
        const response = await axios.get(DAILY_BONUS_SOURCE, {
            timeout: 20000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36',
                Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            },
            validateStatus: status => status >= 200 && status < 300
        });

        const $ = cheerio.load(response.data);
        const bodyText = $('body').text();
        const block = extractDailyServerBlock(bodyText, serverKey);
        const parsed = parseDailyBonusBlock(block);
        const pageDate = extractDailyPageDate(response.data, serverKey);

        if (pageDate && pageDate !== getExpectedDailyDate()) {
            console.warn(`⚠️ AO-SAGE ${serverKey} is still showing ${pageDate}; waiting for ${getExpectedDailyDate()}`);
        } else if (!parsed.entries.length) {
            console.warn(`⚠️ AO-SAGE returned no parsable daily bonus for ${serverKey}. Block: ${block.slice(0, 300)}`);
        } else {
            parsed.source = 'AO-SAGE';
            parsed.stale = false;
            parsed.date = pageDate || new Date().toISOString().slice(0, 10);
            parsed.fetchedAt = new Date().toISOString();
            saveDailyCache(serverKey, parsed);
            console.log(`✅ Daily bonus source connected: ${serverKey} -> ${DAILY_BONUS_SOURCE}`);
            return parsed;
        }
    } catch (err) {
        console.error(`❌ Fetch daily bonus error (${serverKey}):`, err.message);
    }

    // Fallback 1: Albion Data Project festivities endpoint.
    const aodpUrl = AODP_FESTIVITIES_URLS[serverKey];
    if (aodpUrl) {
        try {
            const response = await axios.get(aodpUrl, {
                timeout: 15000,
                headers: { 'User-Agent': 'BOTBOSS Daily Bonus/1.0', Accept: 'application/json' },
                validateStatus: status => status >= 200 && status < 300
            });
            const parsed = parseAodpDailyBonus(serverKey, response.data);
            if (parsed && String(parsed.date || '').slice(0, 10) === getExpectedDailyDate()) {
                parsed.fetchedAt = new Date().toISOString();
                saveDailyCache(serverKey, parsed);
                console.log(`✅ Daily bonus fallback connected: ${serverKey} -> ${aodpUrl}`);
                return parsed;
            }
            console.warn(`⚠️ AODP returned no parsable daily bonus for ${serverKey}`);
        } catch (err) {
            console.warn(`⚠️ AODP fallback failed (${serverKey}):`, err.message);
        }
    }

    // Fallback 2: use the last confirmed value for the same server only.
    const cache = loadDailyCache();
    const cached = cache?.[serverKey];
    const currentServerDate = getExpectedDailyDate();
    const cachedDate = String(cached?.date || cached?.cachedAt || '').slice(0, 10);
    if (cached?.entries?.length && cachedDate === currentServerDate) {
        console.warn(`⚠️ Using stale daily bonus cache for ${serverKey}, cached at ${cached.cachedAt || 'unknown time'}`);
        return {
            ...cached,
            source: cached.source || 'CACHE',
            stale: true
        };
    }

    if (cached?.entries?.length) {
        console.warn(`⚠️ Ignoring old daily bonus cache for ${serverKey}: ${cachedDate || 'unknown date'} (today is ${currentServerDate})`);
    }

    return null;
}

async function generateDailyBonusEmbed(serverChoice) {
    const serverDisplayName = SERVER_NAMES[serverChoice] || 'Albion Server';
    const dailyData = await fetchDailyBonus(serverChoice);

    if (!dailyData) return null;

    const entries = dailyData.entries || [];
    const bonusLines = entries.map((item, index) =>
        `${index + 1}. **${item.category}** — **+${item.dailyBonus}% Daily Bonus**\n   🏙️ Best Craft City: **${item.city}** (+${item.baseBonus}%)`
    ).join('\n\n');

    const sourceLabel = dailyData.stale
        ? `⚠️ ${dailyData.source || 'CACHE'} — ข้อมูลล่าสุดที่ยืนยันได้ (อาจไม่ใช่โบนัสของวันนี้)`
        : `${dailyData.source || 'AO-SAGE'} — ข้อมูลประจำวันที่ ${String(dailyData.date || '').slice(0, 10)} หลังการรีเซ็ตประจำวัน`;

    return new EmbedBuilder()
        .setColor(0xF1C40F)
        .setTitle('✨ **ALBION ONLINE — DAILY BONUS REPORT** ✨')
        .setDescription(`📢 **โบนัสประจำวัน**\n\`\`\`ansi\n\x1b[1;33m🌐 Server: ${serverDisplayName}\x1b[0m\n\`\`\``)
        .addFields(
            {
                name: '🎯 **หมวดหมู่โบนัสวันนี้ (DAILY BONUS)**',
                value: bonusLines || 'ไม่พบข้อมูลโบนัสสำหรับเซิร์ฟเวอร์นี้',
                inline: false
            },
            {
                name: '📝 **แหล่งข้อมูล**',
                value: sourceLabel,
                inline: false
            },
            {
                name: '⏰ **เวลาการรีเซ็ต**',
                value: getDailyResetText(serverChoice),
                inline: false
            }
        )
        .setThumbnail('https://render.albiononline.com/v1/spell/T6_GVGSEASONREWARD_FAMEBUFF_SPELL.png')
        .setFooter({ text: 'Albion Online Daily Bonus • Powered by BOTBOSS', iconURL: client.user.displayAvatarURL() })
        .setTimestamp();
}

async function loadDailyItemIcon(itemId) {
    const urls = [
        `https://render.albiononline.com/v1/item/${encodeURIComponent(itemId)}.png?quality=1&size=96`,
        `https://render.albiononline.com/v1/item/${encodeURIComponent(itemId)}.png?size=96`
    ];
    for (const url of urls) {
        try {
            const response = await axios.get(url, {
                responseType: 'arraybuffer',
                timeout: 8000,
                headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'image/png,image/*,*/*;q=0.8' },
                validateStatus: status => status >= 200 && status < 300
            });
            if (response.data?.length > 100) return await loadImage(Buffer.from(response.data));
        } catch (_) {}
    }
    return null;
}

async function loadDailyCategoryIcon(category) {
    const url = DAILY_CATEGORY_ICON_URLS[category];
    if (!url) return null;
    try {
        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 10000,
            headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'image/png,image/*,*/*;q=0.8' },
            validateStatus: status => status >= 200 && status < 300
        });
        if (response.data?.length > 100) return await loadImage(Buffer.from(response.data));
    } catch (err) {
        console.warn(`⚠️ Daily category icon failed (${category}):`, err.message);
    }
    return null;
}

function drawCityBadge(ctx, city, x, y, size) {
    const cityStyles = {
        'Fort Sterling': { fill: '#f4f1e8', accent: '#b8d9e4', text: '#23313a', mark: 'FS' },
        Thetford: { fill: '#4f285f', accent: '#d7a0ed', text: '#fff0ff', mark: 'TH' },
        Bridgewatch: { fill: '#77502d', accent: '#f0c06a', text: '#fff0c8', mark: 'BW' },
        Lymhurst: { fill: '#315640', accent: '#9bd29f', text: '#eaffea', mark: 'LY' },
        Martlock: { fill: '#4b5365', accent: '#bfc8dd', text: '#f4f6ff', mark: 'MA' },
        Caerleon: { fill: '#242326', accent: '#aaa5b5', text: '#f4f0ff', mark: 'CA' },
        Brecilien: { fill: '#40576b', accent: '#9fc4d4', text: '#e9f7ff', mark: 'BR' }
    };
    const style = cityStyles[city] || { fill: '#4b4037', accent: '#d2b273', text: '#fff4df', mark: String(city || 'CT').slice(0, 2).toUpperCase() };
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
    ctx.shadowBlur = 12;
    ctx.fillStyle = style.fill;
    ctx.beginPath();
    ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = style.accent;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = style.accent;
    ctx.beginPath();
    ctx.moveTo(x + size / 2, y + size - 7);
    ctx.lineTo(x + size / 2 - 10, y + size / 2 + 8);
    ctx.lineTo(x + size / 2 + 10, y + size / 2 + 8);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = style.fill;
    ctx.beginPath();
    ctx.arc(x + size / 2, y + size / 2 - 2, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = style.text;
    ctx.font = `900 ${Math.max(12, Math.floor(size * 0.22))}px Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(style.mark, x + size / 2, y + size / 2 + 5);
    ctx.textAlign = 'left';
    ctx.restore();
}

async function generateDailyBonusCard(serverChoice) {
    const dailyData = await fetchDailyBonus(serverChoice);
    if (!dailyData?.entries?.length) return null;

    const entries = dailyData.entries.slice(0, 2);
    // Render at 1.5x resolution so Discord's preview keeps the text and
    // large bonus icon sharper while all layout coordinates stay unchanged.
    const width = 960;
    const height = 1140;
    const renderScale = 1.5;
    const canvas = createCanvas(Math.round(width * renderScale), Math.round(height * renderScale));
    const ctx = canvas.getContext('2d');
    ctx.scale(renderScale, renderScale);
    const bg = ctx.createLinearGradient(0, 0, width, height);
    bg.addColorStop(0, '#080706');
    bg.addColorStop(0.5, '#120e0b');
    bg.addColorStop(1, '#060505');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);

    const dateText = String(dailyData.date || new Date().toISOString()).slice(0, 10)
        .split('-').reverse().join(' ');
    const resetText = serverChoice === 'asia' ? 'resets 00:00 UTC' : 'resets 10:00 UTC';
    const nextReset = getNextResetInfo(serverChoice);
    const statusText = dailyData.stale ? 'STALE DATA' : 'CONFIRMED TODAY';
    const statusFill = dailyData.stale ? '#6d3429' : '#28543f';
    ctx.fillStyle = '#9a8b80';
    ctx.font = 'bold 15px Arial, sans-serif';
    ctx.letterSpacing = '3px';
    ctx.fillText(`DAILY PRODUCTION BONUS`, 44, 43);
    ctx.fillStyle = '#e0a83a';
    ctx.font = 'bold 13px Arial, sans-serif';
    ctx.fillText(String(serverChoice).toUpperCase(), 264, 43);
    ctx.fillStyle = '#c9c0b8';
    ctx.font = 'bold 14px Arial, sans-serif';
    ctx.fillText(`${dateText}   ${resetText}`, 326, 43);
    drawRoundRect(ctx, 690, 24, 220, 30, 15);
    ctx.fillStyle = statusFill;
    ctx.fill();
    ctx.strokeStyle = dailyData.stale ? '#b45d45' : '#55a679';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = '#f4eadf';
    ctx.font = '900 12px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(statusText, 800, 44);
    ctx.textAlign = 'left';
    ctx.fillStyle = '#28201b';
    ctx.fillRect(44, 58, width - 88, 1);

    const gap = 18;
    const cardX = 44;
    const cardY = 78;
    const cardW = width - 88;
    const cardH = 470;

    const rounded = (x, y, w, h, r, fill, stroke) => {
        drawRoundRect(ctx, x, y, w, h, r);
        ctx.fillStyle = fill; ctx.fill();
        if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
    };

    const iconTasks = entries.map(async entry => ({
        category: await loadDailyCategoryIcon(entry.category)
    }));
    const iconSets = await Promise.all(iconTasks);

    entries.forEach((entry, index) => {
        const x = cardX;
        const y = cardY + index * (cardH + gap);
        const border = entry.dailyBonus >= 20 ? '#d47a24' : '#553a20';
        rounded(x, y, cardW, cardH, 14, '#17120f', border);
        ctx.fillStyle = '#b39b87';
        ctx.font = 'bold 15px Arial, sans-serif';
        ctx.fillText('PRODUCTION BONUS', x + 30, y + 34);

        const title = String(entry.category).toUpperCase();
        ctx.fillStyle = '#f2eee9';
        ctx.font = '900 40px Arial, sans-serif';
        ctx.fillText(title, x + 30, y + 92, cardW - 320);
        rounded(x + cardW - 168, y + 52, 126, 52, 26,
            entry.dailyBonus >= 20 ? '#71320e' : '#4a2b0c',
            entry.dailyBonus >= 20 ? '#f09a38' : '#b87824');
        ctx.fillStyle = entry.dailyBonus >= 20 ? '#ffd18b' : '#f0b34c';
        ctx.font = '900 27px Arial, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`+${entry.dailyBonus}%${entry.dailyBonus >= 20 ? ' HIGH' : ''}`, x + cardW - 105, y + 88);
        ctx.textAlign = 'left';

        ctx.fillStyle = '#33251c';
        ctx.fillRect(x + 30, y + 115, cardW - 60, 1);
        ctx.fillStyle = '#b0a095';
        ctx.font = 'bold 14px Arial, sans-serif';
        ctx.fillText('BEST CRAFT CITY', x + 30, y + 144);
        ctx.fillStyle = '#eee7df';
        ctx.font = 'bold 23px Arial, sans-serif';
        ctx.fillText(`${entry.city}  +${entry.baseBonus}%`, x + 30, y + 176, cardW - 410);

        const iconData = iconSets[index] || { items: [], category: null };
        // Keep one prominent category icon beside the Best Craft City details.
        // It is intentionally separated from the city badge in the lower-right.
        if (iconData.category) {
            try { ctx.drawImage(iconData.category, x + cardW / 2 - 140, y + 126, 280, 280); } catch (_) {}
        }

        // Decorative crafting route panel uses a city badge at bottom-right.
        ctx.fillStyle = '#a99a8f';
        ctx.font = 'bold 14px Arial, sans-serif';
        ctx.fillText('CRAFTING ROUTE', x + 32, y + 424);
        ctx.fillStyle = '#c2a36a';
        ctx.font = 'bold 17px Arial, sans-serif';
        ctx.fillText('BONUS CITY VERIFIED', x + 32, y + 450);
        ctx.strokeStyle = '#46352a';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x + 32, y + 458);
        ctx.lineTo(x + cardW - 150, y + 458);
        ctx.stroke();
        drawCityBadge(ctx, entry.city, x + cardW - 106, y + cardH - 105, 66);
        ctx.fillStyle = '#d9c3a0';
        ctx.font = 'bold 12px Arial, sans-serif';
        ctx.fillText(entry.city, x + cardW - 190, y + cardH - 38, 82);

        // Price/volume data is not available from the current source, so keep
        // this area intentionally empty instead of rendering overlapping N/A text.
    });

    const footer = dailyData.stale
        ? `STALE CACHE — ${String(dailyData.date || '').slice(0, 10)}`
        : `${dailyData.source || 'AO-SAGE'} — UPDATED ${formatIctTime(dailyData.fetchedAt)}`;
    ctx.fillStyle = '#6c5f55';
    ctx.font = 'bold 13px Arial, sans-serif';
    ctx.fillText(footer, 44, height - 38);
    ctx.fillStyle = '#a99172';
    ctx.fillText(`NEXT RESET ${nextReset.clock}  •  IN ${nextReset.countdown}`, 44, height - 16);

    return new AttachmentBuilder(canvas.toBuffer('image/png'), { name: 'daily-production-bonus.png' });
}

// ----------------------------------------
// AUTOMATED DAILY REPORT SCHEDULER
// ----------------------------------------
async function checkAndSendDailyAutoReports() {
    if (!dailyAutoConfigs.length) return;

    const now = new Date();
    const utcHours = now.getUTCHours();
    const utcMinutes = now.getUTCMinutes();
    const todayStr = now.toISOString().split('T')[0];

    // Each server has its own reset clock. Asia resets at 00:00 UTC (07:00
    // Thai), while Americas/Europe reset at 10:00 UTC (17:00 Thai).
    for (const config of dailyAutoConfigs) {
        const serverKey = config.serverChoice || 'asia';
        const resetHour = DAILY_RESET_UTC_HOURS[serverKey] ?? 10;
        const afterDailyReset = utcHours > resetHour || (utcHours === resetHour && utcMinutes >= 5);
        const reportKey = `${config.guildId}:${serverKey}:${todayStr}`;
        if (!afterDailyReset || lastDailyReportDate[reportKey]) continue;

        try {
            const channel = await client.channels.fetch(config.channelId).catch(() => null);
            if (!channel) continue;

            console.log(`⏰ Triggering ${serverKey} daily bonus report...`);
            const card = await generateDailyBonusCard(serverKey);
            if (card) {
                await channel.send({
                    content: `📢 **รายงานโบนัสรายวันอัตโนมัติประจำวันที่ ${todayStr}**`,
                    files: [card]
                });
                lastDailyReportDate[reportKey] = true;
            } else {
                // Do not mark the report as sent and do not publish yesterday's
                // data. The next scheduler tick retries until today's snapshot
                // becomes available (useful when the game opens late).
                console.warn(`⏳ ${serverKey} daily data is not ready; retrying next minute`);
            }
        } catch (err) {
            console.error(`❌ Automated Daily Report failed for channel ${config.channelId}:`, err.message);
        }
    }
}

// ----------------------------------------
// BANDIT ASSAULT (ASIA) SCHEDULE & ALERTS
// Source: user-provided Asia schedule reference image.
// ----------------------------------------
const BANDIT_ASSAULT_SCHEDULE_UTC = [
    { hour: 2, chance: 30 }, { hour: 5, chance: 30 }, { hour: 7, chance: 50 },
    { hour: 9, chance: 60 }, { hour: 11, chance: 40 }, { hour: 13, chance: 60 },
    { hour: 15, chance: 60 }, { hour: 17, chance: 60 }, { hour: 19, chance: 30 },
    { hour: 21, chance: 20 }
];
const BANDIT_SERVER_NAMES = { asia: 'Asia (East)' };

function getNextBanditAssault(now = new Date()) {
    const candidates = [];
    for (let dayOffset = 0; dayOffset <= 1; dayOffset += 1) {
        for (const slot of BANDIT_ASSAULT_SCHEDULE_UTC) {
            const start = new Date(now);
            start.setUTCDate(start.getUTCDate() + dayOffset);
            start.setUTCHours(slot.hour, 0, 0, 0);
            if (start > now) candidates.push({ ...slot, start });
        }
    }
    candidates.sort((a, b) => a.start - b.start);
    return candidates[0] || null;
}

function banditCountdownText(minutes) {
    const safeMinutes = Math.max(0, Math.ceil(minutes));
    return safeMinutes >= 60
        ? `${Math.floor(safeMinutes / 60)} ชม. ${safeMinutes % 60} นาที`
        : `${safeMinutes} นาที`;
}

function banditEventKey(event) {
    return event ? event.start.toISOString() : '';
}

function getBanditChanceStyle(chance) {
    if (chance >= 60) return { label: 'HIGH CHANCE', fill: '#71320e', accent: '#f09a38', text: '#ffd18b' };
    if (chance >= 40) return { label: 'MEDIUM CHANCE', fill: '#66500d', accent: '#e0bd4c', text: '#ffed9b' };
    return { label: 'LOW CHANCE', fill: '#353b46', accent: '#a9b5c8', text: '#e5edf8' };
}

async function generateBanditCard(event, minutesUntil) {
    const width = 960;
    const height = 560;
    const scale = 1.5;
    const canvas = createCanvas(width * scale, height * scale);
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    const style = getBanditChanceStyle(event.chance);
    const ictTime = event.start.toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', hour12: false });
    const dateText = event.start.toLocaleDateString('en-GB', { timeZone: 'Asia/Bangkok', day: '2-digit', month: 'long', year: 'numeric' });

    const bg = ctx.createLinearGradient(0, 0, width, height);
    bg.addColorStop(0, '#080706'); bg.addColorStop(0.55, '#1a100d'); bg.addColorStop(1, '#080605');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = style.accent; ctx.lineWidth = 2; ctx.strokeRect(26, 26, width - 52, height - 52);
    ctx.fillStyle = '#bdab9a'; ctx.font = 'bold 15px Arial, sans-serif';
    ctx.fillText('BANDIT ASSAULT', 52, 62);
    ctx.fillStyle = '#e0a83a'; ctx.font = 'bold 14px Arial, sans-serif';
    ctx.fillText('ASIA (EAST)', 260, 62);
    ctx.fillStyle = '#c9c0b8'; ctx.font = 'bold 14px Arial, sans-serif';
    ctx.fillText(`${dateText}  •  STARTS ${ictTime} ICT`, 390, 62);

    drawRoundRect(ctx, 52, 92, 856, 408, 18);
    ctx.fillStyle = '#17110e'; ctx.fill(); ctx.strokeStyle = '#4e3323'; ctx.stroke();
    ctx.fillStyle = '#a38f80'; ctx.font = 'bold 14px Arial, sans-serif';
    ctx.fillText('EVENT FORECAST', 86, 132);
    ctx.fillStyle = '#f5eee7'; ctx.font = '900 45px Arial, sans-serif';
    ctx.fillText('BANDIT ASSAULT', 86, 190);
    ctx.fillStyle = style.text; ctx.font = '900 72px Arial, sans-serif';
    ctx.fillText(`${event.chance}%`, 86, 285);
    ctx.fillStyle = '#a38f80'; ctx.font = 'bold 16px Arial, sans-serif';
    ctx.fillText('CHANCE OF OCCURRENCE', 94, 318);
    drawRoundRect(ctx, 90, 350, 285, 46, 23); ctx.fillStyle = style.fill; ctx.fill(); ctx.strokeStyle = style.accent; ctx.stroke();
    ctx.fillStyle = style.text; ctx.font = '900 17px Arial, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(style.label, 232, 380); ctx.textAlign = 'left';

    ctx.fillStyle = '#d9c6b7'; ctx.font = 'bold 19px Arial, sans-serif';
    ctx.fillText(`STARTS IN  ${banditCountdownText(minutesUntil)}`, 500, 190);
    ctx.fillStyle = '#e0a83a'; ctx.font = '900 42px Arial, sans-serif';
    ctx.fillText(`${ictTime} ICT`, 500, 250);
    ctx.fillStyle = '#9e8e83'; ctx.font = 'bold 15px Arial, sans-serif';
    ctx.fillText('Schedule source: Asia reference table', 500, 292);
    ctx.fillText('Probability is a forecast, not a guarantee', 500, 322);
    ctx.fillStyle = '#6e5b4e'; ctx.fillRect(500, 355, 330, 1);
    ctx.fillStyle = '#cbb5a1'; ctx.font = 'bold 15px Arial, sans-serif';
    ctx.fillText('Next check runs every minute', 500, 390);
    ctx.fillStyle = '#887366'; ctx.font = 'bold 13px Arial, sans-serif';
    ctx.fillText(`EVENT KEY  ${event.start.toISOString()}`, 500, 430);
    ctx.fillText('BOTBOSS • BANDIT ALERT', 52, 532);
    return new AttachmentBuilder(canvas.toBuffer('image/png'), { name: 'bandit-assault.png' });
}

function banditAlertComponents(guildId) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`bandit_toggle:${guildId}`).setLabel('เปิด/ปิดแจ้งเตือน').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`bandit_status:${guildId}`).setLabel('ดูรอบถัดไป').setStyle(ButtonStyle.Primary)
    );
}

async function checkAndSendBanditAlerts() {
    if (!banditAutoConfigs.length) return;
    const now = new Date();
    const event = getNextBanditAssault(now);
    if (!event) return;

    const minutesUntil = (event.start - now) / 60000;
    // Alert at the 15-minute mark; if the bot was restarted later, alert once
    // immediately while still showing the accurate remaining countdown.
    if (minutesUntil <= 15 && minutesUntil > 0) {
        const key = banditEventKey(event);
        for (const config of banditAutoConfigs) {
            if ((config.server || 'asia') !== 'asia') continue;
            if (config.enabled === false) continue;
            if (lastBanditAlertKey[config.guildId] === key || config.lastEventKey === key) continue;
            try {
                const channel = await client.channels.fetch(config.channelId).catch(() => null);
                if (!channel) continue;
                const ictTime = event.start.toLocaleTimeString('th-TH', {
                    timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', hour12: false
                });
                const chanceLabel = event.chance >= 60 ? `${event.chance}% (โอกาสสูง)` : event.chance >= 40 ? `${event.chance}% (ปานกลาง)` : `${event.chance}% (ต่ำ)`;
                if (config.lastMessageId) {
                    await channel.messages.delete(config.lastMessageId).catch(err => {
                        console.warn(`⚠️ Could not delete previous Bandit alert ${config.lastMessageId}:`, err.message);
                    });
                }
                const card = await generateBanditCard(event, minutesUntil);
                const alertMessage = await channel.send({
                    content: `⚔️ **BANDIT ASSAULT — ASIA**\nกำลังจะเริ่มใน **${banditCountdownText(minutesUntil)}**\n🕒 เวลาเริ่ม: **${ictTime} น. (ICT)**\n🎲 โอกาสเกิด: **${chanceLabel}**`,
                    files: [card],
                    components: [banditAlertComponents(config.guildId)]
                });
                config.lastMessageId = alertMessage.id;
                config.lastEventKey = key;
                saveData();
                lastBanditAlertKey[config.guildId] = key;
            } catch (err) {
                console.error(`❌ Bandit Assault alert failed for channel ${config.channelId}:`, err.message);
            }
        }
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
            .addStringOption(o => o.setName('guild').setDescription('ชื่อ Guild ที่ต้องการยกเลิกติดตาม Auto-Battle').setRequired(true))),
    new SlashCommandBuilder().setName('daily').setDescription('ดึงข้อมูลหรือตั้งค่ารายงานโบนัสประจำวันอัตโนมัติ')
        .addSubcommand(s => s.setName('get').setDescription('ดึงข้อมูลโบนัสประจำวันทันที')
            .addChannelOption(o => o.setName('channel').setDescription('ส่งรายงานไปยังห้องที่เลือก (ไม่เลือกจะส่งห้องนี้)').addChannelTypes(ChannelType.GuildText)))
        .addSubcommand(s => s.setName('setup').setDescription('ตั้งค่าให้บอทส่งรายงานโบนัสประจำวันให้อัตโนมัติทุกวัน (17:05 น. ไทย)')
            .addChannelOption(o => o.setName('channel').setDescription('ห้องที่ต้องการให้แจ้งเตือนอัตโนมัติ').addChannelTypes(ChannelType.GuildText).setRequired(true))
            .addStringOption(o => o.setName('server').setDescription('เลือกเซิร์ฟเวอร์').setRequired(true)
                .addChoices(
                    { name: '🌏 Asia (East)', value: 'asia' },
                    { name: '🌎 West (Americas)', value: 'west' },
                    { name: '🌍 Europe (EU)', value: 'europe' }
                )))
        .addSubcommand(s => s.setName('remove').setDescription('ยกเลิกการส่งรายงานโบนัสประจำวันอัตโนมัติในเซิร์ฟเวอร์นี้'))
    ,new SlashCommandBuilder().setName('bandit').setDescription('แจ้งเตือนกิจกรรม Bandit Assault เซิร์ฟเวอร์ Asia')
        .addSubcommand(s => s.setName('setup').setDescription('ตั้งค่าการแจ้งเตือน Bandit Assault ล่วงหน้า 15 นาที')
            .addChannelOption(o => o.setName('channel').setDescription('ห้องที่ต้องการให้แจ้งเตือน').addChannelTypes(ChannelType.GuildText).setRequired(true))
            .addStringOption(o => o.setName('server').setDescription('เซิร์ฟเวอร์ของตาราง Bandit Assault').setRequired(true)
                .addChoices({ name: '🌏 Asia (East)', value: 'asia' })))
        .addSubcommand(s => s.setName('status').setDescription('ดูรอบ Bandit Assault ครั้งถัดไป'))
        .addSubcommand(s => s.setName('remove').setDescription('ยกเลิกการแจ้งเตือน Bandit Assault'))
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
    setInterval(checkAndSendDailyAutoReports, 60 * 1000);
    setInterval(checkAndSendBanditAlerts, 60 * 1000);
});

client.on('interactionCreate', async interaction => {
    if (interaction.isButton()) {
        const [action, guildId] = interaction.customId.split(':');
        if (action === 'bandit_toggle') {
            const config = banditAutoConfigs.find(c => c.guildId === guildId);
            if (!config) return interaction.reply({ content: '❌ ยังไม่ได้ตั้งค่า Bandit Assault สำหรับเซิร์ฟเวอร์นี้', ephemeral: true });
            config.enabled = config.enabled === false;
            saveData();
            return interaction.reply({ content: config.enabled ? '✅ เปิดการแจ้งเตือน Bandit Assault แล้ว' : '🔕 ปิดการแจ้งเตือน Bandit Assault แล้ว', ephemeral: true });
        }
        if (action === 'bandit_status') {
            const next = getNextBanditAssault(new Date());
            const nextIct = next.start.toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'short', timeStyle: 'short' });
            return interaction.reply({ content: `⚔️ รอบถัดไป: **${nextIct} น.**\n🎲 โอกาสเกิด: **${next.chance}%**\n⏳ เหลือ **${banditCountdownText((next.start - Date.now()) / 60000)}**`, ephemeral: true });
        }
        return;
    }
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

    if (commandName === 'daily') {
        const sub = interaction.options.getSubcommand();

        if (sub === 'get') {
            await interaction.deferReply();
            const targetChannel1 = interaction.options.getChannel('channel') || interaction.channel;

            // /daily get: แสดงเฉพาะ Daily Bonus ของเซิร์ฟเวอร์ Asia (East) เท่านั้น
            const cardAsia = await generateDailyBonusCard('asia');

            if (!cardAsia) {
                return interaction.editReply('❌ **เกิดข้อผิดพลาด:** ไม่สามารถดึง Daily Bonus ของเซิร์ฟเวอร์ **Asia (East)** ได้ในขณะนี้\n`ตรวจสอบ console log ของบอทเพื่อดูรายละเอียด`');
            }

            try {
                if (targetChannel1.id === interaction.channel.id) {
                    await interaction.editReply({ files: [cardAsia] });
                } else {
                    await targetChannel1.send({ files: [cardAsia] });
                    await interaction.editReply(`✅ ส่งรายงานโบนัสประจำวันไปยังห้อง <#${targetChannel1.id}> เรียบร้อยแล้ว!`);
                }

            } catch (err) {
                console.error('❌ Daily command response error:', err.message);
                await interaction.editReply('❌ ไม่สามารถส่งข้อความไปยังห้องที่เลือกได้ โปรดตรวจสอบสิทธิ์การส่งข้อความของบอท');
            }
        }

        if (sub === 'setup') {
            await interaction.deferReply();
            const channel = interaction.options.getChannel('channel');
            const serverChoice = interaction.options.getString('server');

            const existingIndex = dailyAutoConfigs.findIndex(c => c.guildId === interaction.guildId);
            const configData = {
                guildId: interaction.guildId,
                channelId: channel.id,
                serverChoice: serverChoice
            };

            if (existingIndex >= 0) {
                dailyAutoConfigs[existingIndex] = configData;
            } else {
                dailyAutoConfigs.push(configData);
            }
            saveData();

            const setupCard = await generateDailyBonusCard(serverChoice);
            const setupMessage = `✅ **ตั้งค่ารายงานโบนัสรายวันอัตโนมัติสำเร็จ!**\n- 🌐 เซิร์ฟเวอร์: **${SERVER_NAMES[serverChoice]}**\n- 📢 ห้องแจ้งเตือน: <#${channel.id}>\n- ⏰ เวลาแจ้งเตือน: **หลัง ${getDailyResetText(serverChoice)}** ของทุกวันครับ`;
            return setupCard
                ? interaction.editReply({ content: setupMessage, files: [setupCard] })
                : interaction.editReply(setupMessage);
        }

        if (sub === 'remove') {
            const beforeCount = dailyAutoConfigs.length;
            dailyAutoConfigs = dailyAutoConfigs.filter(c => c.guildId !== interaction.guildId);

            if (beforeCount === dailyAutoConfigs.length) {
                return interaction.reply({ content: '❌ เซิร์ฟเวอร์นี้ยังไม่ได้ตั้งค่ารายงานโบนัสรายวันอัตโนมัติไว้ครับ', flags: 64 });
            }

            saveData();
            return interaction.reply('🗑️ ยกเลิกการตั้งค่ารายงานโบนัสรายวันอัตโนมัติสำหรับเซิร์ฟเวอร์นี้เรียบร้อยแล้ว');
        }
    }

    if (commandName === 'bandit') {
        const sub = interaction.options.getSubcommand();
        const next = getNextBanditAssault(new Date());
        if (!next) return interaction.reply('❌ ไม่พบตาราง Bandit Assault ในขณะนี้');

        const nextIct = next.start.toLocaleString('th-TH', {
            timeZone: 'Asia/Bangkok', dateStyle: 'short', timeStyle: 'short'
        });
        const nextChance = next.chance >= 60 ? `${next.chance}% (โอกาสสูง)` : `${next.chance}%`;

        if (sub === 'status') {
            return interaction.reply(
                `⚔️ **BANDIT ASSAULT — ASIA**\n` +
                `รอบถัดไป: **${nextIct} น. (ICT)**\n` +
                `เวลาที่เหลือ: **${banditCountdownText((next.start - Date.now()) / 60000)}**\n` +
                `🎲 โอกาสเกิด: **${nextChance}**`
            );
        }

        if (sub === 'setup') {
            const channel = interaction.options.getChannel('channel');
            const server = interaction.options.getString('server') || 'asia';
            const previousConfig = banditAutoConfigs.find(c => c.guildId === interaction.guildId);
            const configData = {
                guildId: interaction.guildId,
                channelId: channel.id,
                server,
                enabled: true,
                lastMessageId: previousConfig?.lastMessageId || null,
                lastEventKey: previousConfig?.lastEventKey || null
            };
            const existingIndex = banditAutoConfigs.findIndex(c => c.guildId === interaction.guildId);
            if (existingIndex >= 0) banditAutoConfigs[existingIndex] = configData;
            else banditAutoConfigs.push(configData);
            saveData();
            return interaction.reply(
                `✅ ตั้งค่าแจ้งเตือน **Bandit Assault** สำเร็จ\n` +
                `📢 ห้องแจ้งเตือน: <#${channel.id}>\n` +
                `🌐 เซิร์ฟเวอร์: **${BANDIT_SERVER_NAMES[server] || server}**\n` +
                `⏰ บอทจะแจ้งก่อนเริ่ม 15 นาที\n` +
                `🎲 รอบถัดไป: **${nextIct} น.** — โอกาสเกิด **${nextChance}**`
            );
        }

        if (sub === 'remove') {
            const before = banditAutoConfigs.length;
            banditAutoConfigs = banditAutoConfigs.filter(c => c.guildId !== interaction.guildId);
            if (before === banditAutoConfigs.length) return interaction.reply('❌ เซิร์ฟเวอร์นี้ยังไม่ได้ตั้งค่า Bandit Assault');
            saveData();
            return interaction.reply('🗑️ ยกเลิกการแจ้งเตือน Bandit Assault เรียบร้อยแล้ว');
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

console.log('🛡️ AUTO-BATTLE FIX V3 LOADED: Fully automated battle reports & /daily bonus feature enabled');

client.login(BOT_TOKEN);
