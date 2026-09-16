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
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
const fs = require('fs');
const path = require('path');
const express = require('express');

const BANDIT_SERIF_FONT = '/usr/share/fonts/truetype/noto/NotoSerifDisplay-Black.ttf';
const BANDIT_DISPLAY_FONT = '/usr/share/fonts/truetype/noto/NotoSansDisplay-CondensedExtraBold.ttf';
if (fs.existsSync(BANDIT_SERIF_FONT)) GlobalFonts.registerFromPath(BANDIT_SERIF_FONT, 'Bandit Serif');
if (fs.existsSync(BANDIT_DISPLAY_FONT)) GlobalFonts.registerFromPath(BANDIT_DISPLAY_FONT, 'Bandit Display');
const DAILY_DISPLAY_FONT = path.join(__dirname, 'assets', 'InterDisplay-ExtraBold.otf');
const DAILY_TEXT_FONT = path.join(__dirname, 'assets', 'InterDisplay-Bold.otf');
if (fs.existsSync(DAILY_DISPLAY_FONT)) GlobalFonts.registerFromPath(DAILY_DISPLAY_FONT, 'Daily Display');
if (fs.existsSync(DAILY_TEXT_FONT)) GlobalFonts.registerFromPath(DAILY_TEXT_FONT, 'Daily Text');
const DAILY_THAI_DISPLAY_FONT = path.join(__dirname, 'assets', 'NotoSansThai-CondensedExtraBold.ttf');
const DAILY_THAI_TEXT_FONT = path.join(__dirname, 'assets', 'NotoSansThai-CondensedBold.ttf');
if (fs.existsSync(DAILY_THAI_DISPLAY_FONT)) GlobalFonts.registerFromPath(DAILY_THAI_DISPLAY_FONT, 'Daily Thai Display');
if (fs.existsSync(DAILY_THAI_TEXT_FONT)) GlobalFonts.registerFromPath(DAILY_THAI_TEXT_FONT, 'Daily Thai Text');

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
let dailyPlayerConfirmations = []; // ข้อมูลที่ผู้เล่น Asia ยืนยันจากในเกม
let dailySourceStatus = {};
let banditAutoConfigs = []; // [{ guildId, channelId, server, lastMessageId }]
let processedBattles = new Set();
let autoBattleCheckRunning = false;
let lastDailyReportDate = {}; // ป้องกันการส่งซ้ำ แยกตาม guild และ server
let lastBanditAlertKey = {};
// DailyFame: แยกตาม Discord server [{ guildId, channelId, players, enabled, lastReportDate, snapshots }] — player-only
let dailyFameConfigs = {};

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
        dailyAutoConfigs = Array.isArray(data.dailyAuto) ? data.dailyAuto.map(c => ({ ...c, serverChoice: 'asia' })) : [];
        dailyPlayerConfirmations = Array.isArray(data.dailyConfirmations) ? data.dailyConfirmations : [];
        dailySourceStatus = data.dailySourceStatus && typeof data.dailySourceStatus === 'object' ? data.dailySourceStatus : {};
        banditAutoConfigs = Array.isArray(data.banditAuto) ? data.banditAuto : [];
        dailyFameConfigs = data.dailyFameConfigs && typeof data.dailyFameConfigs === 'object' ? data.dailyFameConfigs : {};

        console.log(`📁 Tracking: ${targetGuilds.length} guilds, ${targetPlayers.length} players, ${autoBattleConfigs.length} auto-battle configs, ${dailyAutoConfigs.length} daily auto configs, ${banditAutoConfigs.length} bandit configs, ${Object.keys(dailyFameConfigs).length} DailyFame configs`);
    } catch (err) {
        console.error('❌ tracking.json load error:', err.message);
        targetPlayers = [];
        targetGuilds = [];
        autoBattleConfigs = [];
        dailyAutoConfigs = [];
        dailyPlayerConfirmations = [];
        dailySourceStatus = {};
        banditAutoConfigs = [];
        dailyFameConfigs = {};
    }
}

function saveData() {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify({
            players: targetPlayers,
            guilds: targetGuilds,
            autoBattles: autoBattleConfigs,
            dailyAuto: dailyAutoConfigs,
            dailyConfirmations: dailyPlayerConfirmations,
            dailySourceStatus,
            banditAuto: banditAutoConfigs,
            dailyFameConfigs
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

    // -------------------------------------------------------------
    // ⚙️ ระบบคำนวณขนาดการ์ดอัตโนมัติ (Dynamic Card Scaling)
    // -------------------------------------------------------------
    const totalPlayers = sortedPlayers.length;
    const isSmallList = totalPlayers < 10; // ตรวจสอบว่ามีผู้เล่นน้อยกว่า 10 คนหรือไม่

    // กำหนดขนาดตามจำนวนคน: <10 คน ขยายใหญ่พิเศษ | >=10 คน ขนาดมาตรฐาน
    const playersPerRow = isSmallList ? Math.min(totalPlayers, 5) : 7;
    const cardWidth = isSmallList ? 270 : 210;
    const cardHeight = isSmallList ? 260 : 214;
    const gapX = isSmallList ? 20 : 14;
    const gapY = isSmallList ? 20 : 14;
    const padding = 30;

    const headerHeight = 96, statsHeight = 92;
    const gridOffsetY = padding + headerHeight + statsHeight + 25;
    const columns = Math.min(playersPerRow, totalPlayers);
    const rows = Math.ceil(totalPlayers / playersPerRow);

    const totalGridWidth = columns * cardWidth + (columns - 1) * gapX;
    const minCanvasWidth = isSmallList ? 1400 : 1600;
    const width = Math.max(minCanvasWidth, padding * 2 + totalGridWidth);
    const gridStartX = (width - totalGridWidth) / 2; // จัดการ์ดให้อยู่ตรงกลางภาพพอดี

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

    // 🎨 พื้นหลังภาพ
    const customBgPath = path.join(__dirname, 'assets', 'battle-bg.jpg');
    let hasBgImg = false;
    if (fs.existsSync(customBgPath)) {
        try {
            const bgImg = await loadImage(customBgPath);
            ctx.drawImage(bgImg, 0, 0, width, height);
            ctx.fillStyle = 'rgba(2, 6, 15, 0.82)';
            ctx.fillRect(0, 0, width, height);
            hasBgImg = true;
        } catch (_) {}
    }

    if (!hasBgImg) {
        ctx.fillStyle = '#02050a'; ctx.fillRect(0, 0, width, height);
        const bg = ctx.createRadialGradient(width * .5, height * .4, 50, width * .5, height * .5, width * .75);
        bg.addColorStop(0, '#111d33');
        bg.addColorStop(0.5, '#070f1e');
        bg.addColorStop(1, '#020408');
        ctx.fillStyle = bg; ctx.fillRect(0, 0, width, height);

        ctx.save();
        for (let p = 0; p < 45; p++) {
            const px = (Math.sin(p * 99) * 0.5 + 0.5) * width;
            const py = (Math.cos(p * 33) * 0.5 + 0.5) * height;
            const pr = (p % 3) + 1.5;
            ctx.fillStyle = p % 2 === 0 ? 'rgba(239, 68, 68, 0.25)' : 'rgba(245, 158, 11, 0.2)';
            ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = 8;
            ctx.beginPath(); ctx.arc(px, py, pr, 0, Math.PI * 2); ctx.fill();
        }
        ctx.restore();

        ctx.save();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)'; ctx.lineWidth = 1;
        for (let x = 0; x <= width; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke(); }
        for (let y = 0; y <= height; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke(); }
        ctx.restore();
    }

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

    // 🎯 แถบสถิติรวม (Center Alignment)
    const statY = padding + headerHeight;
    const statGap = 14;
    const statW = 270;
    const statH = 82;
    const totalStatsWidth = (5 * statW) + (4 * statGap);
    const statStartX = (width - totalStatsWidth) / 2;

    const stats = [
        { label: 'TOTAL KILLS', value: totalKills.toLocaleString(), sub: 'ELIMINATIONS', color: '#ef4444', icon: 'kills' },
        { label: 'TOTAL DEATHS', value: totalDeaths.toLocaleString(), sub: 'CASUALTIES', color: '#f87171', icon: 'deaths' },
        { label: 'TOTAL FAME', value: formatFame(totalFame), sub: 'KILL FAME', color: '#fbbf24', icon: 'fame' },
        { label: 'TOP KILLER', value: String(topKiller.name), sub: `${topKiller.kills} KILLS`, color: '#d946ef', icon: 'killer' },
        { label: 'MVP  /  TOP FAME', value: String(mvp.name), sub: `${formatFame(mvp.fame)} FAME`, color: '#f59e0b', icon: 'mvp' }
    ];

    stats.forEach((st, i) => {
        const x = statStartX + i * (statW + statGap);
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

    // 🃏 วาดการ์ดผู้เล่น
    sortedPlayers.forEach((p, i) => {
        const col = i % playersPerRow;
        const row = Math.floor(i / playersPerRow);
        const x = gridStartX + col * (cardWidth + gapX);
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

        // Rank Badge
        const bW = isSmallList ? 46 : 38;
        const bH = isSmallList ? 26 : 23;
        rounded(x + 10, y + 10, bW, bH, 7, isMVP ? '#f59e0b' : '#142238', isMVP ? '#fcd34d' : '#2a405e', 1);
        centerText(String(i + 1).padStart(2, '0'), x + 10 + bW / 2, y + 10 + bH / 2 + 4, isSmallList ? 13 : 11, isMVP ? '#111827' : '#cbd5e1', '900');

        if (isMVP) {
            ctx.fillStyle = '#fbbf24'; ctx.font = `900 ${isSmallList ? 11 : 9}px Arial, sans-serif`; 
            ctx.fillText('MVP', x + cardWidth - (isSmallList ? 48 : 40), y + (isSmallList ? 28 : 26));
        }

        // Weapon Circle & Icon
        const wy = isSmallList ? y + 76 : y + 63;
        const iconRadius = isSmallList ? 52 : 45;
        const iconDrawSize = isSmallList ? 84 : 72;

        ctx.save();
        ctx.shadowColor = qm.color; ctx.shadowBlur = isMVP ? 18 : 10;
        ctx.fillStyle = '#030811';
        ctx.beginPath(); ctx.arc(cx, wy, iconRadius, 0, Math.PI * 2); ctx.fill();
        ctx.shadowBlur = 0;
        ctx.strokeStyle = qm.color; ctx.lineWidth = isMVP ? 2.4 : 1.8;
        ctx.beginPath(); ctx.arc(cx, wy, iconRadius, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = 'rgba(255,255,255,.13)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(cx, wy, iconRadius - 8, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();

        ctx.save();
        ctx.strokeStyle = qm.color; ctx.lineWidth = 2; ctx.globalAlpha = .65;
        const lIn = iconRadius + 4, lOut = iconRadius + 11;
        [[0,-lIn,0,-lOut],[0,lIn,0,lOut],[-lIn,0,-lOut,0],[lIn,0,lOut,0]].forEach(a => {
            ctx.beginPath(); ctx.moveTo(cx + a[0], wy + a[1]); ctx.lineTo(cx + a[2], wy + a[3]); ctx.stroke();
        });
        ctx.restore();

        if (iconImages[i]) {
            try { ctx.drawImage(iconImages[i], cx - iconDrawSize / 2, wy - iconDrawSize / 2, iconDrawSize, iconDrawSize); } catch (_) {}
        } else {
            drawSwordIcon(cx, wy, isSmallList ? 2.0 : 1.7, qm.color);
        }

        // Quality Badge
        const qY = isSmallList ? y + 134 : y + 108;
        const qText = `Q${q}  ${qm.label}`;
        ctx.font = `900 ${isSmallList ? 10 : 8}px Arial, sans-serif`;
        const qw = ctx.measureText(qText).width + (isSmallList ? 22 : 18);
        const qh = isSmallList ? 20 : 17;
        rounded(cx - qw / 2, qY, qw, qh, 8, '#050b14', qm.color, 1);
        centerText(qText, cx, qY + qh - 4, isSmallList ? 10 : 8, qm.color, '900');

        // Player Name
        const nameY = isSmallList ? y + 175 : y + 145;
        let name = String(p.displayName || p.name || 'Unknown').trim();
        if (name.length > 22) name = `${name.slice(0, 20)}..`;
        const nameSize = textFit(name, cardWidth - 20, isSmallList ? 18 : 15, '900');
        ctx.save();
        ctx.textAlign = 'center';
        ctx.font = `900 ${nameSize}px Arial, sans-serif`;
        ctx.lineWidth = 3;
        ctx.strokeStyle = '#02060c';
        ctx.strokeText(name, cx, nameY);
        ctx.fillStyle = isMVP ? '#fef3c7' : '#f8fafc';
        ctx.shadowColor = isMVP ? 'rgba(245,158,11,.25)' : 'rgba(255,255,255,.10)';
        ctx.shadowBlur = 5;
        ctx.fillText(name, cx, nameY);
        ctx.restore();

        // Guild Name
        const guildY = isSmallList ? y + 192 : y + 158;
        const guild = String(p.guild || '').trim();
        if (guild) {
            let g = guild.length > 21 ? `${guild.slice(0, 19)}..` : guild;
            centerText(g, cx, guildY, isSmallList ? 10 : 8, '#64748b', 'bold', cardWidth - 20);
        }

        // Metrics K/D
        const metricY = isSmallList ? y + 218 : y + 180;
        centerText(String(k), cx - (isSmallList ? 22 : 18), metricY, isSmallList ? 14 : 12, k > 0 ? '#ef4444' : '#64748b', '900');
        centerText('/', cx, metricY, isSmallList ? 13 : 11, '#475569', '900');
        centerText(String(d), cx + (isSmallList ? 22 : 18), metricY, isSmallList ? 14 : 12, d > 0 ? '#f87171' : '#64748b', '900');

        // Fame Pill
        const fameText = formatFame(p.fame || 0);
        const famePillW = isSmallList ? 136 : 112;
        const famePillH = isSmallList ? 26 : 23;
        const fameX = cx - famePillW / 2;
        const fameY = y + cardHeight - (isSmallList ? 34 : 31);
        rounded(fameX, fameY, famePillW, famePillH, 10, '#0b1422', isMVP ? '#8b6518' : '#263a55', 1);
        if (fameImg) {
            try { ctx.drawImage(fameImg, fameX + 10, fameY + (isSmallList ? 6 : 5), isSmallList ? 15 : 13, isSmallList ? 15 : 13); } catch (_) {}
        } else {
            drawGemIcon(fameX + 17, fameY + 11, .35, '#fbbf24');
        }
        centerText(fameText, fameX + (isSmallList ? 85 : 72), fameY + (isSmallList ? 18 : 16), isSmallList ? 12 : 11, '#fbbf24', '900');
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
    const addedGuildNames = targetGuilds.map(g => typeof g === 'string' ? g : g.name);

    // กรองข้อมูลสำหรับรูปบน (battle-report.png)
    const rows = allSortedRows.filter(p => {
        const hasAddedFilters = addedGuildNames.length > 0 || targetPlayers.length > 0;

        if (hasAddedFilters) {
            const isExplicitPlayer = targetPlayers.some(
                pl => pl.trim().toLowerCase() === p.displayName.trim().toLowerCase()
            );

            const isGuildMatch = isExactGuildMatch(p.guild, addedGuildNames);

            return isGuildMatch || isExplicitPlayer;
        }

        if (options.autoBattle && guildNamesList.length > 0) {
            return isExactGuildMatch(p.guild, guildNamesList);
        }

        return true;
    });

    let totalKills = 0, totalDeaths = 0, totalFame = 0;
    let guildTotalFrames = 0;

    // คำนวณยอดรวม Kills + Deaths ของกิลด์เพื่อใช้ตรวจสอบเงื่อนไข Auto-Battle minFrames
    for (const p of allSortedRows) {
        if (guildNamesList.length > 0) {
            if (isExactGuildMatch(p.guild, guildNamesList)) {
                guildTotalFrames += (p.kills + p.deaths);
            }
        } else {
            guildTotalFrames += (p.kills + p.deaths);
        }
    }

    for (const p of rows) {
        totalKills += p.kills;
        totalDeaths += p.deaths;
        totalFame += p.fame;
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
const DAILY_BONUS_SOURCE = 'https://ao-sage.com/';
const DAILY_BONUS_TODAY_SOURCE = 'https://ao-sage.com/today';
const DAILY_BONUS_CATALOG_SOURCE = 'https://www.albiondatabase.com/events';
const DAILY_BONUS_FEED_ASIA = process.env.DAILY_BONUS_FEED_ASIA || '';
const DAILY_CACHE_FILE = path.join(__dirname, 'daily-bonus-cache.json');

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
    'Cloth Cowl': ['T6_CLOTH_COWL'],
    'Cloth Robes': ['T6_CLOTH_ROBE'],
    'Cloth Sandals': ['T6_CLOTH_SHOES'],
    'Crossbow': ['T6_2H_CROSSBOW'],
    'Cursed Staff': ['T6_2H_CURSEDSTAFF'],
    'Dagger': ['T6_MAIN_DAGGER'],
    'Plate Armor': ['T6_PLATE_ARMOR'],
    'Stone': ['T6_STONEBLOCK'],
    'Hammer': ['T6_2H_HAMMER'],
    'Holy Staff': ['T6_MAIN_HOLYSTAFF'],
    'Plate Helmet': ['T6_PLATE_HEAD'],
    'Spear': ['T6_MAIN_SPEAR'],
    'Wood': ['T6_WOOD'],
    'Arcane Staff': ['T6_MAIN_ARCANESTAFF'],
    'Bow': ['T6_2H_BOW'],
    'Fiber': ['T6_FIBER'],
    'Leather Hood': ['T6_LEATHER_HEAD'],
    'Leather Shoes': ['T6_LEATHER_SHOES'],
    'Sword': ['T6_MAIN_SWORD'],
    'Axe': ['T6_MAIN_AXE'],
    'Frost Staff': ['T6_MAIN_FROSTSTAFF'],
    'Hide': ['T6_HIDE'],
    'Off-Hand': ['T6_OFFHAND'],
    'Plate Boots': ['T6_PLATE_BOOTS'],
    'Quarterstaff': ['T6_2H_QUARTERSTAFF'],
    'Fire Staff': ['T6_MAIN_FIRESTAFF'],
    'Leather Jackets': ['T6_LEATHER_JACKET'],
    'Mace': ['T6_MAIN_MACE'],
    'Nature Staff': ['T6_MAIN_NATURESTAFF'],
    'Ore': ['T6_ORE'],
    'Food': ['T6_MEAL_STEW'],
    'Gathering Gear': ['T6_GATHERER_HEAD'],
    'Shapeshifter Staff': ['T6_MAIN_SHAPESHIFTERSTAFF'],
    'Tool': ['T6_TOOL_PICKAXE'],
    'War Gloves': ['T6_MAIN_WARGLOVES'],
    'Bag': ['T6_BAG'],
    'Cape': ['T6_CAPE'],
    'Potion': ['T6_POTION_HEAL']
};

const DAILY_CATEGORY_ICON_URLS = {
    'Cloth Robes': 'https://render.albiononline.com/v1/destiny/Cloth%20Robe%20Crafter.png?locale=en',
    'Leather Jackets': 'https://render.albiononline.com/v1/destiny/Leather%20Jacket%20Crafter.png?locale=en',
    'Cloth Cowl': 'https://render.albiononline.com/v1/destiny/Cloth%20Cowl%20Crafter.png?locale=en',
    'Nature Staff': 'https://render.albiononline.com/v1/destiny/Nature%20Staff%20Crafter.png?locale=en'
};
const dailyIconCache = new Map();

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
        const previous = cache[serverKey];
        const oldSignature = (previous?.entries || []).map(x => `${x.category}|${x.city}|${x.dailyBonus}`).sort().join('||');
        const newSignature = (data?.entries || []).map(x => `${x.category}|${x.city}|${x.dailyBonus}`).sort().join('||');
        const changed = Boolean(oldSignature && newSignature && oldSignature !== newSignature);
        data.changed = changed;
        if (changed) data.changedAt = new Date().toISOString();
        cache[serverKey] = { ...data, changed, changedAt: changed ? new Date().toISOString() : previous?.changedAt, cachedAt: new Date().toISOString() };
        fs.writeFileSync(DAILY_CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
    } catch (err) {
        console.warn('⚠️ Daily cache write failed:', err.message);
    }
}

function setDailySourceStatus(serverKey, patch) {
    dailySourceStatus[serverKey] = { ...(dailySourceStatus[serverKey] || {}), ...patch, checkedAt: new Date().toISOString() };
    saveData();
}

function getCommunityDailyData(serverKey) {
    const today = getExpectedDailyDate();
    const rows = dailyPlayerConfirmations.filter(x => x.server === serverKey && x.date === today);
    if (!rows.length) return null;
    const entries = rows.filter((item, index, all) => all.findIndex(x => x.category === item.category) === index)
        .map(x => ({ category: x.category, city: x.city, baseBonus: Number(x.baseBonus) || 15, dailyBonus: Number(x.dailyBonus) || 10 }))
        .slice(0, 2);
    if (!entries.length) return null;
    return { entries, source: 'COMMUNITY', stale: false, date: today, confirmations: rows.length, fetchedAt: new Date().toISOString() };
}

function dailyDataSignature(data) {
    return (data?.entries || []).map(x => `${x.category}|${x.city}|${x.dailyBonus}`).sort().join('||');
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

    block = cleanDailyText(block).replace(/^(Americas|Asia|Europe)\b/i, '').trim();

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

        if (category.length > 70 || city.length > 45) continue;
        result.entries.push({ category, city, baseBonus, dailyBonus });
    }

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


function parseExternalDailyFeed(payload, serverKey) {
    if (serverKey !== 'asia' || !payload || typeof payload !== 'object') return null;
    const date = String(payload.date || payload.day || '').slice(0, 10);
    const entries = Array.isArray(payload.entries) ? payload.entries : Array.isArray(payload.bonuses) ? payload.bonuses : [];
    const normalized = entries.map(row => {
        const rawCategory = row.category || row.name || row.item || row.type;
        const key = dailyCategoryKey(rawCategory);
        const meta = DAILY_CATEGORY_META[key];
        if (!meta) return null;
        return {
            category: meta.label,
            city: cleanDailyText(row.city || meta.city),
            baseBonus: Number(row.baseBonus ?? meta.baseBonus) || meta.baseBonus,
            dailyBonus: Number(row.dailyBonus ?? row.bonus ?? row.percent) || 10
        };
    }).filter(Boolean).filter((item, index, all) => all.findIndex(x => x.category === item.category) === index).slice(0, 2);
    if (!date || date !== getExpectedDailyDate() || normalized.length < 2) return null;
    return { entries: normalized, source: 'EXTERNAL_FEED', stale: false, date, fetchedAt: new Date().toISOString() };
}

async function fetchDailyExternalFeed(serverKey) {
    const feedUrl = serverKey === 'asia' ? DAILY_BONUS_FEED_ASIA : '';
    if (!feedUrl) return null;
    try {
        const response = await axios.get(feedUrl, {
            timeout: 5000,
            headers: { 'User-Agent': 'Boss Bot Daily Bonus/1.0', Accept: 'application/json' },
            validateStatus: status => status >= 200 && status < 300
        });
        const parsed = parseExternalDailyFeed(response.data, serverKey);
        if (parsed) {
            setDailySourceStatus(serverKey, { externalFeed: 'confirmed', externalFeedDate: parsed.date, externalFeedUrl: feedUrl });
            saveDailyCache(serverKey, parsed);
            console.log(`✅ Daily bonus external feed connected: ${serverKey}`);
            return parsed;
        }
        setDailySourceStatus(serverKey, { externalFeed: 'invalid_or_not_ready', externalFeedDate: null, externalFeedUrl: feedUrl });
    } catch (err) {
        setDailySourceStatus(serverKey, { externalFeed: 'error', externalFeedError: err.message, externalFeedUrl: feedUrl });
        console.warn(`⚠️ External Daily feed failed (${serverKey}):`, err.message);
    }
    return null;
}

async function checkAlbionDatabaseCatalog(serverKey) {
    if (serverKey !== 'asia') return;
    try {
        const response = await axios.get(DAILY_BONUS_CATALOG_SOURCE, {
            timeout: 5000,
            headers: { 'User-Agent': 'Boss Bot Daily Bonus/1.0', Accept: 'text/html,application/xhtml+xml' },
            validateStatus: status => status >= 200 && status < 300
        });
        const $ = cheerio.load(response.data);
        const text = cleanDailyText($('body').text());
        const updatedMatch = text.match(/Updated\s+([A-Za-z]{3}\s+\d{1,2},\s+\d{4})/i);
        const hasDailyPool = /Daily Crafting Bonuses/i.test(text);
        setDailySourceStatus(serverKey, {
            albionDatabase: hasDailyPool ? 'available' : 'unavailable',
            albionDatabaseUpdated: updatedMatch ? updatedMatch[1] : null
        });
        return { available: hasDailyPool, updated: updatedMatch ? updatedMatch[1] : null };
    } catch (err) {
        const status = Number(err.response?.status || 0);
        if (status === 403) {
            setDailySourceStatus(serverKey, {
                albionDatabase: 'blocked',
                albionDatabaseStatus: status,
                albionDatabaseError: 'Cloudflare denied the server-side request'
            });
            console.warn('ℹ️ Albion Database catalog skipped: Cloudflare denied the server-side request (403)');
        } else {
            setDailySourceStatus(serverKey, { albionDatabase: 'error', albionDatabaseError: err.message });
            console.warn('⚠️ Albion Database source check failed:', err.message);
        }
        return null;
    }
}

async function fetchDailyBonus(serverKey) {
    const externalPromise = fetchDailyExternalFeed(serverKey);
    const catalogPromise = checkAlbionDatabaseCatalog(serverKey);
    const aoPromise = axios.get(DAILY_BONUS_SOURCE, {
        timeout: 8000,
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html,application/xhtml+xml' },
        validateStatus: status => status >= 200 && status < 300
    });
    const aodpUrl = AODP_FESTIVITIES_URLS[serverKey];
    const aodpPromise = aodpUrl ? axios.get(aodpUrl, {
        timeout: 5000,
        headers: { 'User-Agent': 'BOTBOSS Daily Bonus/1.0', Accept: 'application/json' },
        validateStatus: status => status >= 200 && status < 500
    }) : Promise.reject(new Error('No AODP URL configured'));

    const external = await externalPromise;
    if (external) return external;

    const [aoResult, aodpResult] = await Promise.allSettled([aoPromise, aodpPromise]);
    catalogPromise.catch(() => null);

    if (aoResult.status === 'fulfilled') {
        const html = aoResult.value.data;
        const $ = cheerio.load(html);
        const block = extractDailyServerBlock($('body').text(), serverKey);
        const parsed = parseDailyBonusBlock(block);
        const pageDate = extractDailyPageDate(html, serverKey);
        if (pageDate === getExpectedDailyDate() && parsed.entries.length) {
            parsed.source = 'AO-SAGE';
            parsed.stale = false;
            parsed.date = pageDate;
            parsed.fetchedAt = new Date().toISOString();
            setDailySourceStatus(serverKey, { aoSage: 'confirmed', aoSageDate: pageDate });
            saveDailyCache(serverKey, parsed);
            console.log(`✅ Daily bonus source connected: ${serverKey} -> AO-SAGE`);
            return parsed;
        }
        setDailySourceStatus(serverKey, { aoSage: 'waiting', aoSageDate: pageDate || null });
        console.warn(`⚠️ AO-SAGE ${serverKey} has no confirmed snapshot for ${getExpectedDailyDate()}`);
    } else {
        setDailySourceStatus(serverKey, { aoSage: 'error', aoSageError: aoResult.reason?.message || 'unknown error' });
        console.warn(`⚠️ AO-SAGE request failed (${serverKey}):`, aoResult.reason?.message || 'unknown error');
    }

    if (aodpResult.status === 'fulfilled') {
        if (Number(aodpResult.value.status) === 404) {
            setDailySourceStatus(serverKey, { aodp: 'no_snapshot', aodpStatus: 404 });
            console.warn(`ℹ️ AODP ${serverKey} has no confirmed snapshot yet (404)`);
        }
        const parsed = parseAodpDailyBonus(serverKey, aodpResult.value.data);
        if (parsed && String(parsed.date || '').slice(0, 10) === getExpectedDailyDate()) {
            parsed.fetchedAt = new Date().toISOString();
            saveDailyCache(serverKey, parsed);
            setDailySourceStatus(serverKey, { aodp: 'confirmed', aodpDate: getExpectedDailyDate() });
            console.log(`✅ Daily bonus fallback connected: ${serverKey} -> AODP`);
            return parsed;
        }
        if (Number(aodpResult.value.status) !== 404) {
            setDailySourceStatus(serverKey, { aodp: 'not_daily_or_waiting', aodpStatus: aodpResult.value.status });
            console.warn(`⚠️ AODP has no confirmed Daily Bonus snapshot for ${serverKey}`);
        }
    } else {
        setDailySourceStatus(serverKey, { aodp: 'error', aodpError: aodpResult.reason?.message || 'unavailable' });
        console.warn(`⚠️ AODP request failed (${serverKey}):`, aodpResult.reason?.message || 'unavailable');
    }

    const community = getCommunityDailyData(serverKey);
    if (community) {
        setDailySourceStatus(serverKey, { community: 'confirmed', confirmations: community.confirmations });
        saveDailyCache(serverKey, community);
        return community;
    }

    const cache = loadDailyCache();
    const cached = cache?.[serverKey];
    const currentServerDate = getExpectedDailyDate();
    const cachedDate = String(cached?.date || '').slice(0, 10);
    if (cached?.entries?.length && cachedDate === currentServerDate) {
        console.warn(`⚠️ Using same-day daily bonus cache for ${serverKey}, cached at ${cached.cachedAt || 'unknown time'}`);
        return { ...cached, source: cached.source || 'CACHE', stale: true };
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
    const aliases = {
        'Cloth Robe': 'Cloth Robes',
        'Leather Jacket': 'Leather Jackets',
        'Nature Staves': 'Nature Staff'
    };
    const categoryKey = aliases[String(category).trim()] || String(category).trim();
    if (dailyIconCache.has(categoryKey)) return dailyIconCache.get(categoryKey);
    const url = DAILY_CATEGORY_ICON_URLS[categoryKey];
    if (url) {
        try {
            const response = await axios.get(url, {
                responseType: 'arraybuffer', timeout: 6000,
                headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'image/png,image/*,*/*;q=0.8' },
                validateStatus: status => status >= 200 && status < 300
            });
            if (response.data?.length > 100) {
                const image = await loadImage(Buffer.from(response.data));
                dailyIconCache.set(categoryKey, image);
                return image;
            }
        } catch (err) {
            console.warn(`⚠️ Daily category icon failed (${category}):`, err.message);
        }
    }

    const itemId = DAILY_CATEGORY_ITEM_IDS[categoryKey]?.[0];
    if (itemId) {
        const fallback = await loadDailyItemIcon(itemId);
        if (fallback) {
            dailyIconCache.set(categoryKey, fallback);
            return fallback;
        }
    }
    return null;
}

async function preloadDailyIcons() {
    await Promise.all(Object.keys(DAILY_CATEGORY_ICON_URLS).map(category => loadDailyCategoryIcon(category)));
    console.log(`✅ Preloaded ${dailyIconCache.size} Daily Bonus icons`);
}

function drawCategoryPlaceholder(ctx, category, x, y, size) {
    const initials = String(category || 'DB').split(/\s+/).map(x => x[0]).join('').slice(0, 3).toUpperCase();
    ctx.save();
    ctx.fillStyle = '#3d2917'; ctx.strokeStyle = '#d39a45'; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(x + size / 2, y + size / 2, size / 2 - 8, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#ffe0a3'; ctx.font = `900 ${Math.floor(size * 0.22)}px Arial, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(initials, x + size / 2, y + size / 2);
    ctx.restore();
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
    serverChoice = 'asia';
    const dailyData = await fetchDailyBonus('asia');
    if (!dailyData?.entries?.length) return null;

    const entries = dailyData.entries.slice(0, 2);
    const width = 1200;
    const height = 900;
    const renderScale = 1.35;
    const canvas = createCanvas(Math.round(width * renderScale), Math.round(height * renderScale));
    const ctx = canvas.getContext('2d');
    ctx.scale(renderScale, renderScale);

    const bgPath = path.join(__dirname, 'assets', 'daily-production-bg.png');
    try {
        if (fs.existsSync(bgPath)) {
            const bgImage = await loadImage(bgPath);
            ctx.drawImage(bgImage, 0, 0, width, height);
        } else {
            const bg = ctx.createLinearGradient(0, 0, width, height);
            bg.addColorStop(0, '#07152a');
            bg.addColorStop(0.55, '#0b2237');
            bg.addColorStop(1, '#08121f');
            ctx.fillStyle = bg;
            ctx.fillRect(0, 0, width, height);
        }
    } catch (_) {
        ctx.fillStyle = '#081525';
        ctx.fillRect(0, 0, width, height);
    }

    const FONT_HEAD = '900 44px "Daily Display", "Inter Display", sans-serif';
    const FONT_TITLE = '900 30px "Daily Display", "Inter Display", sans-serif';
    const FONT_BODY = '700 17px "Daily Text", "Inter Display", sans-serif';
    const FONT_SMALL = '700 14px "Daily Text", "Inter Display", sans-serif';
    const FONT_TINY = '700 12px "Daily Text", "Inter Display", sans-serif';

    const fitText = (text, maxWidth, start, min, family = 'Daily Display') => {
        let size = start;
        while (size > min) {
            ctx.font = `900 ${size}px "${family}", "Inter Display", sans-serif`;
            if (ctx.measureText(text).width <= maxWidth) return size;
            size -= 1;
        }
        return min;
    };

    const round = (x, y, w, h, r, fill, stroke = null, lineWidth = 1) => {
        drawRoundRect(ctx, x, y, w, h, r);
        ctx.fillStyle = fill;
        ctx.fill();
        if (stroke) {
            ctx.strokeStyle = stroke;
            ctx.lineWidth = lineWidth;
            ctx.stroke();
        }
    };

    const glowRound = (x, y, w, h, r, fill, stroke, glowColor) => {
        ctx.save();
        ctx.shadowColor = glowColor;
        ctx.shadowBlur = 18;
        round(x, y, w, h, r, fill, stroke, 2);
        ctx.restore();
    };

    const drawIconFrame = (img, x, y, size, accent) => {
        ctx.save();
        ctx.shadowColor = accent;
        ctx.shadowBlur = 22;
        ctx.strokeStyle = accent;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(x + size / 2, y + size / 2, size / 2 - 9, 0, Math.PI * 2);
        ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.fillStyle = 'rgba(3,12,23,0.86)';
        ctx.beginPath();
        ctx.arc(x + size / 2, y + size / 2, size / 2 - 14, 0, Math.PI * 2);
        ctx.fill();
        if (img) {
            try { ctx.drawImage(img, x + 28, y + 28, size - 56, size - 56); } catch (_) {}
        }
        ctx.restore();
    };

    const dateText = String(dailyData.date || new Date().toISOString()).slice(0, 10)
        .split('-').reverse().join('/');
    const nextReset = getNextResetInfo('asia');
    const sourceLabel = dailyData.source === 'AO-SAGE' ? 'AO-SAGE' : dailyData.source === 'EXTERNAL_FEED' ? 'EXTERNAL FEED' : dailyData.source === 'AODP' ? 'AODP' : dailyData.source === 'COMMUNITY' ? 'COMMUNITY' : String(dailyData.source || 'CACHE').toUpperCase();
    const statusText = dailyData.stale
        ? `RECOVERED • ${sourceLabel}`
        : dailyData.source === 'COMMUNITY'
            ? 'COMMUNITY CONFIRMED'
            : dailyData.changed
                ? `UPDATED • ${sourceLabel}`
                : `CONFIRMED • ${sourceLabel}`;
    const statusFill = dailyData.stale ? '#6d3429' : dailyData.source === 'COMMUNITY' ? '#66531a' : '#235642';

    ctx.textAlign = 'center';
    ctx.fillStyle = '#f5f7fb';
    ctx.font = FONT_HEAD;
    ctx.fillText('DAILY PRODUCTION BONUS', width / 2, 58);

    ctx.fillStyle = '#8fd7ff';
    ctx.font = FONT_BODY;
    ctx.fillText('✦  ASIA (EAST)  ✦', width / 2, 84);

    ctx.fillStyle = '#aab7c8';
    ctx.font = FONT_SMALL;
    ctx.fillText(`BONUS TODAY  •  ${dateText}  •  ${statusText}`, width / 2, 108);

    round(width - 250, 28, 220, 54, 18, 'rgba(8,19,33,0.90)', '#d7a13d', 2);
    ctx.fillStyle = '#e9c269';
    ctx.font = FONT_TINY;
    ctx.fillText('NEXT RESET', width - 140, 49);
    ctx.fillStyle = '#ffffff';
    ctx.font = '900 18px "Daily Display", "Inter Display", sans-serif';
    ctx.fillText(`${nextReset.clock}  •  ${nextReset.countdown}`, width - 140, 70);

    const gap = 18;
    const margin = 42;
    const cardY = 128;
    const cardH = 650;
    const cardW = (width - margin * 2 - gap) / 2;
    const accents = ['#37a9ff', '#e8ad3e'];

    const iconSets = await Promise.all(entries.map(async entry => await loadDailyCategoryIcon(entry.category)));

    entries.forEach((entry, index) => {
        const x = margin + index * (cardW + gap);
        const accent = accents[index] || '#d7a13d';
        const inner = 'rgba(6,17,29,0.92)';

        ctx.save();
        ctx.shadowColor = accent;
        ctx.shadowBlur = 24;
        round(x, cardY, cardW, cardH, 18, inner, accent, 2.5);
        ctx.restore();

        ctx.textAlign = 'left';
        ctx.fillStyle = accent;
        ctx.font = FONT_TINY;
        ctx.fillText(`TODAY #${index + 1}`, x + 26, cardY + 34);

        const title = String(entry.category || 'UNKNOWN').toUpperCase();
        const titleSize = fitText(title, cardW - 54, 31, 22);
        ctx.font = `900 ${titleSize}px "Daily Display", "Inter Display", sans-serif`;
        ctx.fillStyle = '#ffffff';
        ctx.fillText(title, x + 26, cardY + 76);

        round(x + 22, cardY + 96, cardW - 44, 68, 13, 'rgba(13,33,53,0.92)', accent, 1.5);
        ctx.fillStyle = '#91a7ba';
        ctx.font = FONT_TINY;
        ctx.fillText('CRAFTING BONUS', x + 38, cardY + 118);
        ctx.fillStyle = '#8bd4ff';
        ctx.font = FONT_TINY;
        ctx.textAlign = 'right';
        ctx.fillText('PRODUCTION MULTIPLIER', x + cardW - 38, cardY + 118);
        ctx.fillStyle = '#ffd25b';
        ctx.font = '900 30px "Daily Display", "Inter Display", sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(`+${entry.dailyBonus}%`, x + 38, cardY + 150);
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'right';
        ctx.fillText(`×${(1 + Number(entry.dailyBonus || 0) / 100).toFixed(2)}`, x + cardW - 38, cardY + 150);

        const panelY = cardY + 184;
        const panelH = 286;
        const leftW = 205;
        const rightX = x + 22 + leftW + 16;
        const rightW = cardW - 44 - leftW - 16;

        round(x + 22, panelY, leftW, panelH, 14, 'rgba(3,14,26,0.88)', accent, 1.5);
        round(rightX, panelY, rightW, panelH, 14, 'rgba(3,14,26,0.88)', '#29445f', 1.5);

        ctx.textAlign = 'center';
        ctx.fillStyle = '#93a6b8';
        ctx.font = FONT_TINY;
        ctx.fillText('EXAMPLE ITEM', x + 22 + leftW / 2, panelY + 27);

        const icon = iconSets[index];
        drawIconFrame(icon, x + 22 + 22, panelY + 38, 160, accent);

        const itemLabel = String(entry.category || 'ITEM').toUpperCase();
        ctx.fillStyle = '#ffffff';
        ctx.font = `900 ${fitText(itemLabel, leftW - 30, 17, 12)}px "Daily Display", "Inter Display", sans-serif`;
        ctx.fillText(itemLabel, x + 22 + leftW / 2, panelY + 223);
        ctx.fillStyle = '#71879a';
        ctx.font = FONT_TINY;
        ctx.fillText('REPRESENTATIVE ITEM', x + 22 + leftW / 2, panelY + 248);

        ctx.textAlign = 'left';
        ctx.fillStyle = '#93a6b8';
        ctx.font = FONT_TINY;
        ctx.fillText('BEST PLACE TO CRAFT', rightX + 20, panelY + 30);

        const city = String(entry.city || 'Unknown City');
        ctx.fillStyle = '#ffffff';
        ctx.font = `900 ${fitText(city.toUpperCase(), rightW - 40, 25, 17)}px "Daily Display", "Inter Display", sans-serif`;
        ctx.fillText(city.toUpperCase(), rightX + 20, panelY + 68);

        ctx.fillStyle = '#ffd25b';
        ctx.font = FONT_BODY;
        ctx.fillText(`CITY BONUS  +${Number(entry.baseBonus || 0)}%`, rightX + 20, panelY + 98);

        ctx.fillStyle = '#7f94a8';
        ctx.font = FONT_TINY;
        ctx.fillText('BONUS CITY', rightX + 20, panelY + 137);
        ctx.fillStyle = '#d9e2ec';
        ctx.font = FONT_SMALL;
        ctx.fillText('Craft here for the best local bonus', rightX + 20, panelY + 160);

        drawCityBadge(ctx, city, rightX + rightW - 72, panelY + panelH - 86, 58);
        ctx.fillStyle = accent;
        ctx.font = FONT_TINY;
        ctx.textAlign = 'right';
        ctx.fillText(city.toUpperCase(), rightX + rightW - 20, panelY + panelH - 20);

        const noteY = panelY + panelH + 20;
        round(x + 22, noteY, cardW - 44, 76, 12, 'rgba(4,14,24,0.88)', '#29445f', 1);
        ctx.textAlign = 'left';
        ctx.fillStyle = '#9eb0c0';
        ctx.font = FONT_TINY;
        ctx.fillText(`BONUS #${index + 1}  •  +${entry.dailyBonus}% PRODUCTION`, x + 38, noteY + 27);
        ctx.fillStyle = '#e6edf5';
        ctx.font = FONT_SMALL;
        const note = `${title} receives today's production bonus.`;
        ctx.fillText(note, x + 38, noteY + 52);
    });

    const footerY = 804;
    round(42, footerY, width - 84, 58, 16, 'rgba(5,17,29,0.94)', '#c08d2f', 1.5);
    ctx.textAlign = 'left';
    ctx.fillStyle = '#ffd25b';
    ctx.font = FONT_TINY;
    ctx.fillText('BONUS TODAY', 62, footerY + 21);
    const summary = entries.map(e => `${String(e.category).toUpperCase()}  +${e.dailyBonus}%`).join('     •     ');
    ctx.fillStyle = '#ffffff';
    ctx.font = `900 ${fitText(summary, 650, 17, 11, 'Daily Text')}px "Daily Text", "Inter Display", sans-serif`;
    ctx.fillText(summary, 62, footerY + 43);

    ctx.textAlign = 'right';
    ctx.fillStyle = '#9fb2c4';
    ctx.font = FONT_TINY;
    ctx.fillText(`ASIA (EAST)  •  NEXT RESET ${nextReset.clock}`, width - 62, footerY + 21);
    ctx.fillStyle = '#f3f6fa';
    ctx.font = FONT_SMALL;
    ctx.fillText('POWERED BY  Boss Bot', width - 62, footerY + 43);

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

    for (const config of dailyAutoConfigs) {
        const serverKey = 'asia';
        const resetHour = DAILY_RESET_UTC_HOURS.asia;
        const afterDailyReset = utcHours > resetHour || (utcHours === resetHour && utcMinutes >= 5);
        const reportKey = `${config.guildId}:${serverKey}:${todayStr}`;
        if (!afterDailyReset) continue;

        try {
            const channel = await client.channels.fetch(config.channelId).catch(() => null);
            if (!channel) continue;

            console.log(`⏰ Triggering ${serverKey} daily bonus report...`);
            const card = await generateDailyBonusCard(serverKey);
            if (card) {
                const latest = loadDailyCache()?.[serverKey];
                const signature = dailyDataSignature(latest);
                if (signature && lastDailyReportDate[reportKey] === signature) continue;
                await channel.send({
                    content: `📢 **รายงานโบนัสรายวันอัตโนมัติประจำวันที่ ${todayStr}**${latest?.changed ? '\n🔄 ตรวจพบข้อมูลโบนัสเปลี่ยนแปลง' : ''}`,
                    files: [card]
                });
                lastDailyReportDate[reportKey] = signature || true;
            } else {
                console.warn(`⏳ ${serverKey} daily data is not ready; retrying next minute`);
            }
        } catch (err) {
            console.error(`❌ Automated Daily Report failed for channel ${config.channelId}:`, err.message);
        }
    }
}

function getDailyRetryDelayMs(serverKey = 'asia') {
    const now = new Date();
    const resetHour = DAILY_RESET_UTC_HOURS[serverKey] ?? 10;
    const minutesSinceReset = ((now.getUTCHours() - resetHour + 24) % 24) * 60 + now.getUTCMinutes();
    if (minutesSinceReset < 60) return 30 * 1000;
    if (minutesSinceReset < 180) return 60 * 1000;
    return 5 * 60 * 1000;
}

function scheduleDailyAutoCheck() {
    const delay = getDailyRetryDelayMs('asia');
    setTimeout(async () => {
        try { await checkAndSendDailyAutoReports(); }
        finally { scheduleDailyAutoCheck(); }
    }, delay);
}

// ----------------------------------------
// BANDIT ASSAULT (ASIA) SCHEDULE & ALERTS
// ----------------------------------------
const BANDIT_ASSAULT_SCHEDULE_UTC = [
    { hour: 5, chance: 30 }, { hour: 7, chance: 50 },
    { hour: 9, chance: 60 }, { hour: 11, chance: 40 }, { hour: 13, chance: 60 },
    { hour: 15, chance: 60 }, { hour: 17, chance: 60 }
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

function banditCountdownImageText(minutes) {
    const safeMinutes = Math.max(0, Math.ceil(minutes));
    if (safeMinutes >= 60) {
        const hours = Math.floor(safeMinutes / 60);
        const remaining = safeMinutes % 60;
        return remaining ? `${hours}H ${remaining}M` : `${hours}H`;
    }
    return `${safeMinutes} MIN`;
}

function banditEventKey(event) {
    return event ? event.start.toISOString() : '';
}

function getBanditChanceStyle(chance) {
    if (chance >= 60) return { label: 'HIGH CHANCE', fill: '#71320e', accent: '#f09a38', text: '#ffd18b' };
    if (chance >= 40) return { label: 'MEDIUM CHANCE', fill: '#66500d', accent: '#e0bd4c', text: '#ffed9b' };
    return { label: 'LOW CHANCE', fill: '#353b46', accent: '#a9b5c8', text: '#e5edf8' };
}

function drawBanditSword(ctx, x, y, size, color = '#d5a35b') {
    ctx.save(); ctx.translate(x, y); ctx.rotate(-0.18);
    ctx.fillStyle = color; ctx.strokeStyle = '#6e4323'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(size * 0.52, 0); ctx.lineTo(size * 0.68, size * 0.10); ctx.lineTo(size * 0.42, size * 0.72); ctx.lineTo(size * 0.32, size * 0.68); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#7e3e2d'; ctx.fillRect(size * 0.25, size * 0.64, size * 0.38, size * 0.09);
    ctx.fillStyle = '#c28b4d'; ctx.fillRect(size * 0.38, size * 0.70, size * 0.12, size * 0.22);
    ctx.fillStyle = '#8c5a32'; ctx.beginPath(); ctx.arc(size * 0.44, size * 0.95, size * 0.08, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
}

function drawCaerleonCrest(ctx, x, y, size) {
    ctx.save();
    ctx.fillStyle = '#171519'; ctx.strokeStyle = '#b88a54'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(x + size / 2, y); ctx.lineTo(x + size, y + size * 0.22); ctx.lineTo(x + size * 0.86, y + size * 0.78); ctx.lineTo(x + size / 2, y + size); ctx.lineTo(x + size * 0.14, y + size * 0.78); ctx.lineTo(x, y + size * 0.22); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#7d3027'; ctx.beginPath(); ctx.arc(x + size / 2, y + size * 0.5, size * 0.26, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#e1bd78'; ctx.font = `900 ${Math.floor(size * 0.23)}px 'Bandit Display'`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('C', x + size / 2, y + size * 0.51);
    ctx.restore();
}

const BANDIT_ICON_FILE = path.join(__dirname, 'assets', 'bandit-icon.webp');
const BANDIT_BACKGROUND_FILE = path.join(__dirname, 'assets', 'caerleon-background.jpeg');
const BANDIT_COIN_FILE = path.join(__dirname, 'assets', 'caerleon-coin-transparent.png');
let banditArtworkPromise = null;

function drawCoverImage(ctx, image, x, y, width, height) {
    const sourceRatio = image.width / image.height;
    const targetRatio = width / height;
    let sx = 0, sy = 0, sw = image.width, sh = image.height;
    if (sourceRatio > targetRatio) { sw = image.height * targetRatio; sx = (image.width - sw) / 2; }
    else { sh = image.width / targetRatio; sy = (image.height - sh) / 2; }
    ctx.drawImage(image, sx, sy, sw, sh, x, y, width, height);
}

function drawBanditCoin(ctx, image, x, y, size, alpha = 1) {
    if (!image) return false;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.drawImage(image, x, y, size, size);
    ctx.restore();
    return true;
}

function drawBanditIcon(ctx, image, x, y, size) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = '#130e12';
    ctx.fillRect(x, y, size, size);
    if (image) {
        ctx.drawImage(image, 32, 30, 120, 120, x, y, size, size);
    } else {
        drawCaerleonCrest(ctx, x + 4, y + 4, size - 8);
    }
    ctx.restore();
    ctx.save();
    ctx.strokeStyle = '#d6a34f';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x + size / 2, y + size / 2, size / 2 - 1, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
}

function loadBanditArtwork() {
    if (!banditArtworkPromise) {
        banditArtworkPromise = Promise.all([
            fs.existsSync(BANDIT_ICON_FILE) ? loadImage(BANDIT_ICON_FILE) : null,
            fs.existsSync(BANDIT_BACKGROUND_FILE) ? loadImage(BANDIT_BACKGROUND_FILE) : null,
            fs.existsSync(BANDIT_COIN_FILE) ? loadImage(BANDIT_COIN_FILE) : null
        ]).catch(err => {
            console.warn('⚠️ Bandit artwork load failed:', err.message);
            return [null, null, null];
        });
    }
    return banditArtworkPromise;
}

async function generateBanditCard(event, minutesUntil) {
    const width = 900;
    const height = 1200;
    const scale = 1.35;
    const canvas = createCanvas(Math.round(width * scale), Math.round(height * scale));
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);

    const style = getBanditChanceStyle(event.chance);
    const [banditIcon, caerleonBackground, caerleonCoin] = await loadBanditArtwork();
    const localHeroPath = path.join(__dirname, 'assets', 'caerleon-bandit-hero.png');
    let hero = null;
    try {
        if (fs.existsSync(localHeroPath)) hero = await loadImage(localHeroPath);
        else if (caerleonBackground) hero = caerleonBackground;
    } catch (_) { hero = caerleonBackground || null; }

    const ictTime = event.start.toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', hour12: false });
    const dateText = event.start.toLocaleDateString('en-GB', { timeZone: 'Asia/Bangkok', day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase();
    const countdown = banditCountdownImageText(minutesUntil);
    const statusLabel = minutesUntil <= 15 ? 'UPCOMING' : 'SCHEDULED';
    const threatLabel = event.chance >= 60 ? 'HIGH' : event.chance >= 40 ? 'MEDIUM' : 'LOW';

    const rr = (x, y, w, h, r, fill, stroke = null, lw = 1) => {
        drawRoundRect(ctx, x, y, w, h, r);
        ctx.fillStyle = fill; ctx.fill();
        if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke(); }
    };
    const fit = (text, maxW, startSize, minSize = 12, weight = 900, family = 'Arial') => {
        let size = startSize;
        while (size > minSize) {
            ctx.font = `${weight} ${size}px "${family}"`;
            if (ctx.measureText(text).width <= maxW) return size;
            size -= 1;
        }
        return minSize;
    };
    const text = (value, x, y, font, fill, align = 'left') => {
        ctx.font = font; ctx.fillStyle = fill; ctx.textAlign = align; ctx.textBaseline = 'alphabetic';
        ctx.fillText(value, x, y);
    };

    if (hero) drawCoverImage(ctx, hero, 0, 0, width, 760);
    else {
        const bg = ctx.createLinearGradient(0, 0, width, 760);
        bg.addColorStop(0, '#190609'); bg.addColorStop(0.6, '#3a090d'); bg.addColorStop(1, '#09050a');
        ctx.fillStyle = bg; ctx.fillRect(0, 0, width, 760);
    }

    ctx.fillStyle = 'rgba(5,2,6,0.34)'; ctx.fillRect(0, 0, width, 760);
    const heroFade = ctx.createLinearGradient(0, 0, 0, 760);
    heroFade.addColorStop(0, 'rgba(0,0,0,0.28)');
    heroFade.addColorStop(0.55, 'rgba(0,0,0,0.04)');
    heroFade.addColorStop(0.78, 'rgba(10,2,5,0.74)');
    heroFade.addColorStop(1, '#100509');
    ctx.fillStyle = heroFade; ctx.fillRect(0, 0, width, 760);

    ctx.strokeStyle = '#ef242d'; ctx.lineWidth = 2; ctx.strokeRect(18, 18, width - 36, height - 36);
    ctx.strokeStyle = 'rgba(250,75,74,0.55)'; ctx.lineWidth = 1; ctx.strokeRect(27, 27, width - 54, height - 54);
    ctx.strokeStyle = 'rgba(245,145,70,0.28)'; ctx.lineWidth = 1; ctx.strokeRect(34, 34, width - 68, height - 68);

    ctx.save();
    text('Albion', 48, 78, '900 42px Georgia', '#f4f1ec');
    text('ONLINE', 64, 98, '700 10px Arial', '#d5c7c1');
    ctx.restore();

    rr(315, 42, 240, 50, 25, 'rgba(25,5,10,0.80)', '#e51f29', 2);
    if (!drawBanditCoin(ctx, caerleonCoin, 328, 47, 40, 0.95)) drawCaerleonCrest(ctx, 328, 49, 34);
    text('ASIA (EAST)', 447, 74, '900 18px Arial', '#ff6a65', 'center');

    rr(585, 42, 270, 62, 17, 'rgba(18,4,9,0.90)', '#ef3038', 2);
    text('LIVE ALERT', 720, 66, '900 18px Arial', '#ffb2a9', 'center');
    text(`แจ้งเตือนล่วงหน้า ${Math.max(1, Math.ceil(minutesUntil))} นาที`, 720, 87, '700 12px Arial', '#eee3df', 'center');

    text('BANDIT', 450, 250, `900 ${fit('BANDIT', 720, 106, 78, 900, 'Arial Black')}px "Arial Black"`, '#ef262f', 'center');
    text('ASSAULT', 450, 350, `900 ${fit('ASSAULT', 780, 96, 68, 900, 'Arial Black')}px "Arial Black"`, '#f2eee9', 'center');
    
    ctx.strokeStyle = '#ef222c'; ctx.lineWidth = 8; ctx.beginPath(); ctx.moveTo(170, 366); ctx.lineTo(730, 292); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,230,220,0.65)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(190, 375); ctx.lineTo(705, 308); ctx.stroke();

    text('⚔  AMBUSH', 280, 438, '800 18px Arial', '#f1d4cc', 'center');
    text('•', 450, 438, '900 20px Arial', '#ef353a', 'center');
    text('RAID', 510, 438, '800 18px Arial', '#f1d4cc', 'center');
    text('•', 610, 438, '900 20px Arial', '#ef353a', 'center');
    text('SURVIVE', 690, 438, '800 18px Arial', '#f1d4cc', 'center');

    ctx.fillStyle = '#100509'; ctx.fillRect(0, 485, width, 275);

    const gap = 16;
    const leftX = 42;
    const rightX = 462;
    const boxW = 396;
    const boxH = 145;

    rr(leftX, 510, boxW, boxH, 20, 'rgba(18,8,11,0.96)', '#b51e27', 2);
    drawSkullIcon(ctx, leftX + 55, 582, 40, '#ff3039');
    text('THREAT LEVEL', leftX + 105, 555, '700 15px Arial', '#c7aaa5');
    text(threatLabel, leftX + 105, 598, '900 32px Arial', '#ff3d45');
    
    const meterX = leftX + 105, meterY = 618, meterW = 250, meterH = 14;
    rr(meterX, meterY, meterW, meterH, 7, '#26171a', '#4a2a2e', 1);
    const fillW = Math.max(30, meterW * Math.min(100, event.chance) / 100);
    rr(meterX, meterY, fillW, meterH, 7, style.accent);
    for (let i = 1; i < 5; i++) {
        ctx.strokeStyle = 'rgba(255,255,255,0.16)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(meterX + i * meterW / 5, meterY + 1); ctx.lineTo(meterX + i * meterW / 5, meterY + meterH - 1); ctx.stroke();
    }

    rr(rightX, 510, boxW, boxH, 20, 'rgba(18,8,11,0.96)', '#7f5a1b', 2);
    drawTargetIcon(ctx, rightX + 58, 582, 42, '#e9b33f');
    text('EVENT STATUS', rightX + 110, 555, '700 15px Arial', '#c7aaa5');
    text(statusLabel, rightX + 110, 598, '900 31px Arial', '#ffc83d');
    text(`${dateText}  •  ${ictTime} ICT`, rightX + 110, 627, '700 12px Arial', '#c9b5ae');

    rr(leftX, 671, boxW, 170, 20, 'rgba(15,5,8,0.98)', '#b51e27', 2);
    drawClockIcon(ctx, leftX + 58, 746, 40, '#f3f1ee');
    text('STARTS IN', leftX + 105, 714, '800 15px Arial', '#d6c7c2');
    text(countdown, leftX + 105, 777, `900 ${fit(countdown, 260, 54, 36, 900, 'Arial')}px Arial`, '#ff2631');
    text(`${ictTime} ICT`, leftX + 105, 812, '800 15px Arial', '#e6b85a');

    rr(rightX, 671, boxW, 170, 20, 'rgba(15,5,8,0.98)', '#6c282d', 2);
    if (!drawBanditCoin(ctx, caerleonCoin, rightX + 24, 708, 86, 0.95)) drawCaerleonCrest(ctx, rightX + 32, 716, 68);
    text('EVENT', rightX + 125, 708, '700 14px Arial', '#bfa9a4');
    text('BANDIT ASSAULT', rightX + 125, 743, `900 ${fit('BANDIT ASSAULT', 235, 27, 20, 900, 'Arial')}px Arial`, '#f5efeb');
    text(`CHANCE  ${event.chance}%`, rightX + 125, 784, '900 23px Arial', '#ff3840');
    rr(rightX + 125, 802, 230, 10, 5, '#2c1b1e');
    rr(rightX + 125, 802, Math.max(12, 230 * Math.min(100, event.chance) / 100), 10, 5, '#ff3139');

    rr(42, 858, 816, 88, 18, 'rgba(28,7,10,0.98)', '#e53a3f', 2);
    drawWarningIcon(ctx, 70, 902, 34, '#ff3139');
    text('Prepare for combat!', 120, 891, '900 21px Arial', '#ff454b');
    text('Enter at your own risk.', 120, 920, '700 13px Arial', '#d2b8b4');

    ctx.fillStyle = '#0c0508'; ctx.fillRect(0, 946, width, 254);
    if (caerleonCoin) {
        ctx.save(); ctx.globalAlpha = 0.18; drawCoverImage(ctx, caerleonCoin, 690, 950, 170, 170); ctx.restore();
    }
    if (!drawBanditCoin(ctx, caerleonCoin, 665, 970, 110, 0.98)) drawCaerleonCrest(ctx, 665, 970, 110);
    text('CAERLEON', 820, 1008, '900 19px Arial', '#f2e5df', 'center');
    text('FACTION WARFARE', 820, 1032, '700 11px Arial', '#b49c96', 'center');

    ctx.strokeStyle = '#662126'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(42, 1068); ctx.lineTo(858, 1068); ctx.stroke();
    if (!drawBanditCoin(ctx, caerleonCoin, 58, 1085, 34, 0.9)) drawCaerleonCrest(ctx, 58, 1085, 34);
    text('ASIA (EAST)', 110, 1110, '900 16px Arial', '#efb23d');
    text('POWERED BY', 650, 1094, '700 11px Arial', '#a88f89', 'center');
    text('BOSS BOT', 650, 1120, '900 19px Arial', '#f4efec', 'center');
    
    ctx.strokeStyle = '#e6e0dc'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(750, 1085); ctx.lineTo(750, 1120); ctx.lineTo(774, 1120); ctx.stroke();
    ctx.beginPath(); ctx.arc(750, 1094, 11, -Math.PI/2, Math.PI/2); ctx.stroke();
    ctx.beginPath(); ctx.arc(750, 1111, 11, -Math.PI/2, Math.PI/2); ctx.stroke();

    return new AttachmentBuilder(canvas.toBuffer('image/png'), { name: 'bandit-assault-caerleon.png' });
}

function drawSkullIcon(ctx, cx, cy, size, color) {
    ctx.save(); ctx.fillStyle = color; ctx.strokeStyle = '#4b1116'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(cx, cy - 6, size * 0.36, Math.PI, 0); ctx.lineTo(cx + size*0.34, cy + size*0.25); ctx.lineTo(cx + size*0.18, cy + size*0.38); ctx.lineTo(cx - size*0.18, cy + size*0.38); ctx.lineTo(cx - size*0.34, cy + size*0.25); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#18070a'; ctx.beginPath(); ctx.arc(cx - size*0.13, cy - 4, size*0.08, 0, Math.PI*2); ctx.arc(cx + size*0.13, cy - 4, size*0.08, 0, Math.PI*2); ctx.fill();
    ctx.fillRect(cx - 2, cy + 8, 4, 10); ctx.restore();
}

function drawTargetIcon(ctx, cx, cy, size, color) {
    ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = 4;
    for (let r of [size*0.48,size*0.31,size*0.14]) { ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2); ctx.stroke(); }
    ctx.beginPath(); ctx.moveTo(cx-size*0.62,cy); ctx.lineTo(cx-size*0.2,cy); ctx.moveTo(cx+size*0.2,cy); ctx.lineTo(cx+size*0.62,cy); ctx.moveTo(cx,cy-size*0.62); ctx.lineTo(cx,cy-size*0.2); ctx.moveTo(cx,cy+size*0.2); ctx.lineTo(cx,cy+size*0.62); ctx.stroke();
    ctx.restore();
}

function drawClockIcon(ctx, cx, cy, size, color) {
    ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(cx,cy,size*0.46,0,Math.PI*2); ctx.stroke();
    ctx.lineCap='round'; ctx.beginPath(); ctx.moveTo(cx,cy); ctx.lineTo(cx,cy-size*0.23); ctx.moveTo(cx,cy); ctx.lineTo(cx+size*0.2,cy+size*0.08); ctx.stroke(); ctx.restore();
}

function drawWarningIcon(ctx, cx, cy, size, color) {
    ctx.save(); ctx.fillStyle=color; ctx.beginPath(); ctx.moveTo(cx,cy-size*0.55); ctx.lineTo(cx+size*0.52,cy+size*0.45); ctx.lineTo(cx-size*0.52,cy+size*0.45); ctx.closePath(); ctx.fill();
    ctx.fillStyle='#25070a'; ctx.fillRect(cx-2,cy-size*0.18,4,size*0.36); ctx.beginPath(); ctx.arc(cx,cy+size*0.29,3,0,Math.PI*2); ctx.fill(); ctx.restore();
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
    if (minutesUntil <= 15 && minutesUntil > -5) {
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


// ========================= DAILY FAME TRACKER =========================
const DAILY_FAME_SOURCE = 'Albion GameInfo Asia (East)';
const DAILY_FAME_SOURCE_URL = 'https://gameinfo-sgp.albiononline.com/api/gameinfo';
const DAILY_FAME_SECONDARY_SOURCE = 'AlbionDB East';
const DAILY_FAME_SECONDARY_URL = 'https://east.albiondb.net';
const DAILY_FAME_REPORT_HOUR_ICT = 9;

function getIctDateKey(date = new Date()) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(date);
}

function getIctHour(date = new Date()) {
    return Number(new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Bangkok', hour: '2-digit', hour12: false
    }).format(date));
}

function getDailyFameConfig(guildId) {
    if (!dailyFameConfigs[guildId]) {
        dailyFameConfigs[guildId] = {
            guildId,
            channelId: null,
            enabled: false,
            players: [],
            guilds: [],
            lastReportDate: null,
            snapshots: {}
        };
    }
    const c = dailyFameConfigs[guildId];
    c.players = Array.isArray(c.players) ? c.players : [];
    // DailyFame v3 is player-only. Ignore legacy guild tracking entries.
    c.guilds = [];
    c.snapshots = c.snapshots && typeof c.snapshots === 'object' ? c.snapshots : {};
    return c;
}

function normalizeTrackedName(name) {
    return String(name || '').trim().replace(/\s+/g, ' ');
}

async function dailyFameApiGet(pathname, params = {}) {
    const url = `${DAILY_FAME_SOURCE_URL}${pathname}`;
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const response = await axios.get(url, {
                params,
                timeout: 20000,
                headers: {
                    'User-Agent': 'BossBot/1.0 Albion DailyFame',
                    'Accept': 'application/json'
                },
                validateStatus: () => true
            });
            const status = Number(response.status || 0);
            if (status >= 200 && status < 300 && response.data) return response.data;
            const detail = typeof response.data === 'string' ? response.data.slice(0, 180) : JSON.stringify(response.data || {});
            lastError = new Error(`GameInfo HTTP ${status}${detail ? `: ${detail}` : ''}`);
            if (![429, 500, 502, 503, 504].includes(status)) break;
        } catch (err) {
            lastError = err;
        }
        await new Promise(resolve => setTimeout(resolve, attempt * 1000));
    }
    throw lastError || new Error('GameInfo request failed');
}

function pickExactSearchResult(list, name) {
    const target = normalizeTrackedName(name).toLowerCase();
    const arr = Array.isArray(list) ? list : [];
    return arr.find(x => String(x?.Name || x?.name || '').trim().toLowerCase() === target) || arr[0] || null;
}

async function resolveDailyFamePlayerId(name) {
    const payload = await dailyFameApiGet('/search', { q: normalizeTrackedName(name) });
    const players = Array.isArray(payload) ? payload : (payload?.players || payload?.Players || []);
    const hit = pickExactSearchResult(players, name);
    if (!hit?.Id && !hit?.id) throw new Error(`GameInfo ไม่พบผู้เล่น "${name}"`);
    return { id: hit.Id || hit.id, name: hit.Name || hit.name || name };
}

async function resolveDailyFameGuildId(name) {
    const payload = await dailyFameApiGet('/search', { q: normalizeTrackedName(name) });
    const guilds = Array.isArray(payload) ? [] : (payload?.guilds || payload?.Guilds || []);
    const hit = pickExactSearchResult(guilds, name);
    if (!hit?.Id && !hit?.id) throw new Error(`GameInfo ไม่พบกิลด์ "${name}"`);
    return { id: hit.Id || hit.id, name: hit.Name || hit.name || name };
}

function extractLifetimeStats(data) {
    const ls = data?.LifetimeStatistics || data?.lifetimeStatistics || {};
    const pve = ls.PvE || ls.Pve || ls.PVE || {};
    const gathering = ls.Gathering || ls.gathering || {};
    const crafting = ls.Crafting || ls.crafting || {};
    return {
        pveFame: Number(pve.Total ?? pve.total ?? 0) || 0,
        gatheringFame: Number(gathering.All ?? gathering.Total ?? gathering.total ?? 0) || 0,
        craftingFame: Number(crafting.Total ?? crafting.total ?? 0) || 0
    };
}

async function fetchDailyFamePlayerFromOfficial(name) {
    const resolved = await resolveDailyFamePlayerId(name);
    const data = await dailyFameApiGet(`/players/${encodeURIComponent(resolved.id)}`);
    const lifetime = extractLifetimeStats(data);
    const killFame = Number(data?.KillFame ?? data?.killFame ?? 0) || 0;
    const deathFame = Number(data?.DeathFame ?? data?.deathFame ?? 0) || 0;
    if (!killFame && !deathFame && !lifetime.pveFame && !lifetime.gatheringFame && !lifetime.craftingFame) {
        throw new Error(`GameInfo ไม่มี LifetimeStatistics ของ ${resolved.name}`);
    }
    return {
        name: data?.Name || data?.name || resolved.name,
        trackedName: normalizeTrackedName(name),
        guild: data?.GuildName || data?.guildName || data?.Guild?.Name || data?.guild?.Name || '',
        killFame,
        deathFame,
        ...lifetime,
        source: DAILY_FAME_SOURCE,
        sourceUrl: `${DAILY_FAME_SOURCE_URL}/players/${encodeURIComponent(resolved.id)}`,
        fetchedAt: new Date().toISOString()
    };
}

async function fetchDailyFameGuildFromOfficial(name) {
    const resolved = await resolveDailyFameGuildId(name);
    const data = await dailyFameApiGet(`/guilds/${encodeURIComponent(resolved.id)}`);

    const killFame = Number(data?.KillFame ?? data?.killFame ?? data?.Fame?.KillFame ?? 0) || 0;
    const deathFame = Number(data?.DeathFame ?? data?.deathFame ?? data?.Fame?.DeathFame ?? 0) || 0;
    let members = Number(
        data?.MemberCount ?? data?.memberCount ?? data?.MembersCount ?? data?.membersCount ??
        (Array.isArray(data?.Members) ? data.Members.length : Array.isArray(data?.members) ? data.members.length : 0)
    ) || 0;

    // Some GameInfo responses omit MemberCount. Fetch the official member list as a fallback.
    if (!members) {
        try {
            const memberPayload = await dailyFameApiGet(`/guilds/${encodeURIComponent(resolved.id)}/members`);
            if (Array.isArray(memberPayload)) members = memberPayload.length;
            else if (Array.isArray(memberPayload?.members)) members = memberPayload.members.length;
            else if (Array.isArray(memberPayload?.Members)) members = memberPayload.Members.length;
        } catch (err) {
            console.warn(`⚠️ DailyFame guild members fallback failed (${resolved.name}): ${err.message}`);
        }
    }

    // A guild can legitimately have 0 Kill/Death Fame. Do not reject a valid guild just because
    // its numeric statistics are zero; the Name/Id response itself is sufficient to track it.
    const actualName = data?.Name || data?.name || resolved.name;
    if (!actualName) throw new Error(`GameInfo ไม่พบข้อมูลกิลด์ "${name}"`);

    return {
        id: data?.Id || data?.id || resolved.id,
        name: actualName,
        trackedName: normalizeTrackedName(name),
        killFame,
        deathFame,
        members,
        kd: deathFame > 0 ? Number((killFame / deathFame).toFixed(2)) : 0,
        source: DAILY_FAME_SOURCE,
        sourceUrl: `${DAILY_FAME_SOURCE_URL}/guilds/${encodeURIComponent(resolved.id)}`,
        fetchedAt: new Date().toISOString()
    };
}

// Secondary webpage fallback. AlbionDB is useful when GameInfo is temporarily incomplete,
// but the bot no longer depends on it as the primary source (its Cloudflare protection can block bots).
async function fetchAlbionDbPage(type, name) {
    const clean = normalizeTrackedName(name);
    const url = `${DAILY_FAME_SECONDARY_URL}/${type}/${encodeURIComponent(clean)}`;
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
    };
    try {
        const r = await axios.get(url, { timeout: 20000, headers, validateStatus: () => true });
        if (r.status >= 200 && r.status < 300 && typeof r.data === 'string' && r.data.length > 1000 && !/Just a moment|challenge|cf-chl/i.test(r.data)) {
            return { url, html: r.data };
        }
    } catch (_) {}
    try {
        const r = await cloudscraper.get({ uri: url, timeout: 20000, headers });
        const body = String(r?.body || r || '');
        if (body.length > 1000 && !/Just a moment|challenge|cf-chl/i.test(body)) return { url, html: body };
    } catch (_) {}
    throw new Error(`AlbionDB ถูกบล็อก/ไม่พร้อมใช้งาน (${type})`);
}

function extractFameLabel(text, label) {
    const re = new RegExp(`${label.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\s*[:]?\\s*([0-9][0-9,.]*(?:[KMBT])?)`, 'i');
    const match = String(text || '').match(re);
    return match ? parseFameValue(match[1]) : null;
}

function extractFirstHeading($) {
    const candidates = [];
    $('h1,h2').each((_, el) => {
        const t = cleanDailyText($(el).text());
        if (t) candidates.push(t);
    });
    return candidates[0] || '';
}

async function fetchDailyFamePlayer(name) {
    try {
        return await fetchDailyFamePlayerFromOfficial(name);
    } catch (primaryErr) {
        console.warn(`⚠️ GameInfo player failed (${name}): ${primaryErr.message}`);
        try {
            const page = await fetchAlbionDbPage('player', name);
            const $ = cheerio.load(page.html);
            const text = cleanDailyText($('body').text());
            const actualName = extractFirstHeading($) || normalizeTrackedName(name);
            const killFame = extractFameLabel(text, 'Kill Fame');
            const deathFame = extractFameLabel(text, 'Death Fame');
            const pveFame = extractFameLabel(text, 'PvE Fame');
            const gatheringFame = extractFameLabel(text, 'Gathering Fame');
            const craftingFame = extractFameLabel(text, 'Crafting Fame');
            if ([killFame, deathFame, pveFame, gatheringFame, craftingFame].every(v => v === null)) throw primaryErr;
            let guild = '';
            $('a[href*="/guild/"]').each((_, el) => {
                if (guild) return;
                const t = cleanDailyText($(el).text());
                if (t && !/^guild$/i.test(t) && t.length < 100) guild = t;
            });
            return { name: actualName, trackedName: normalizeTrackedName(name), guild, killFame: killFame || 0, deathFame: deathFame || 0, pveFame: pveFame || 0, gatheringFame: gatheringFame || 0, craftingFame: craftingFame || 0, source: DAILY_FAME_SECONDARY_SOURCE, sourceUrl: page.url, fetchedAt: new Date().toISOString() };
        } catch (secondaryErr) {
            throw new Error(`GameInfo: ${primaryErr.message} | AlbionDB: ${secondaryErr.message}`);
        }
    }
}

async function fetchDailyFameGuild(name) {
    try {
        return await fetchDailyFameGuildFromOfficial(name);
    } catch (primaryErr) {
        console.warn(`⚠️ GameInfo guild failed (${name}): ${primaryErr.message}`);
        try {
            const page = await fetchAlbionDbPage('guild', name);
            const $ = cheerio.load(page.html);
            const text = cleanDailyText($('body').text());
            const actualName = extractFirstHeading($) || normalizeTrackedName(name);
            const killFame = extractFameLabel(text, 'Kill Fame');
            const deathFame = extractFameLabel(text, 'Death Fame');
            const memberMatch = text.match(/Current Members\s*([0-9][0-9,]*)/i);
            const kdMatch = text.match(/K\/D Ratio\s*([0-9.]+)/i);
            if (killFame === null && deathFame === null && !memberMatch) throw primaryErr;
            return { name: actualName, trackedName: normalizeTrackedName(name), killFame: killFame || 0, deathFame: deathFame || 0, members: memberMatch ? Number(memberMatch[1].replace(/,/g, '')) : 0, kd: kdMatch ? Number(kdMatch[1]) : 0, source: DAILY_FAME_SECONDARY_SOURCE, sourceUrl: page.url, fetchedAt: new Date().toISOString() };
        } catch (secondaryErr) {
            throw new Error(`GameInfo: ${primaryErr.message} | AlbionDB: ${secondaryErr.message}`);
        }
    }
}

function safeGain(current, previous) {
    if (previous === null || previous === undefined) return null;
    const gain = Number(current || 0) - Number(previous || 0);
    return Math.max(0, Math.round(gain));
}

function playerDailyDelta(current, previous) {
    return {
        killFame: safeGain(current.killFame, previous?.killFame),
        deathFame: safeGain(current.deathFame, previous?.deathFame),
        pveFame: safeGain(current.pveFame, previous?.pveFame),
        gatheringFame: safeGain(current.gatheringFame, previous?.gatheringFame),
        craftingFame: safeGain(current.craftingFame, previous?.craftingFame)
    };
}

function guildDailyDelta(current, previous) {
    return {
        killFame: safeGain(current.killFame, previous?.killFame),
        deathFame: safeGain(current.deathFame, previous?.deathFame),
        members: previous?.members == null ? null : Number(current.members || 0) - Number(previous.members || 0)
    };
}

function totalPlayerGain(delta) {
    return ['killFame', 'pveFame', 'gatheringFame', 'craftingFame']
        .reduce((sum, k) => sum + (delta?.[k] || 0), 0);
}

function sumPlayerCurrent(players, key) {
    return players.reduce((sum, p) => sum + (Number(p[key]) || 0), 0);
}

function sumPlayerDelta(players, key) {
    return players.reduce((sum, p) => sum + (Number(p.delta?.[key]) || 0), 0);
}

function dailyFameTextGain(value, fallback = '—') {
    if (value === null || value === undefined) return fallback;
    return value > 0 ? `+${formatFame(value)}` : '0';
}

function dailyFameIcon(ctx, cx, cy, type, color = '#f5c451', scale = 1) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = Math.max(2, 3 * scale);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const s = scale;
    if (type === 'pve') {
        ctx.beginPath(); ctx.arc(0, 0, 15*s, 0, Math.PI*2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(-8*s, 0); ctx.lineTo(8*s, 0); ctx.moveTo(0, -8*s); ctx.lineTo(0, 8*s); ctx.stroke();
        ctx.beginPath(); ctx.arc(0, 0, 4*s, 0, Math.PI*2); ctx.fill();
    } else if (type === 'gathering') {
        ctx.beginPath(); ctx.moveTo(-10*s, 13*s); ctx.lineTo(7*s, -12*s); ctx.stroke();
        ctx.beginPath(); ctx.arc(9*s, -11*s, 7*s, 0, Math.PI*2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(-3*s, 7*s); ctx.lineTo(4*s, 14*s); ctx.stroke();
    } else if (type === 'crafting') {
        ctx.beginPath(); ctx.arc(0, 0, 7*s, 0, Math.PI*2); ctx.stroke();
        for (let i=0;i<8;i++) { const a=i*Math.PI/4; ctx.beginPath(); ctx.moveTo(Math.cos(a)*9*s, Math.sin(a)*9*s); ctx.lineTo(Math.cos(a)*15*s, Math.sin(a)*15*s); ctx.stroke(); }
    } else if (type === 'kill') {
        ctx.beginPath(); ctx.moveTo(-12*s, -12*s); ctx.lineTo(12*s, 12*s); ctx.moveTo(12*s, -12*s); ctx.lineTo(-12*s, 12*s); ctx.stroke();
        ctx.beginPath(); ctx.arc(0,0,15*s,0,Math.PI*2); ctx.stroke();
    } else if (type === 'death') {
        ctx.beginPath(); ctx.arc(0, 0, 14*s, 0, Math.PI*2); ctx.stroke();
        ctx.fillStyle = color; ctx.fillRect(-7*s,-5*s,4*s,4*s); ctx.fillRect(3*s,-5*s,4*s,4*s);
        ctx.beginPath(); ctx.moveTo(-7*s,7*s); ctx.lineTo(7*s,7*s); ctx.stroke();
    } else if (type === 'guild') {
        ctx.beginPath(); ctx.moveTo(0,-16*s); ctx.lineTo(14*s,-8*s); ctx.lineTo(11*s,9*s); ctx.lineTo(0,16*s); ctx.lineTo(-11*s,9*s); ctx.lineTo(-14*s,-8*s); ctx.closePath(); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(-6*s,0); ctx.lineTo(6*s,0); ctx.moveTo(0,-6*s); ctx.lineTo(0,6*s); ctx.stroke();
    } else {
        ctx.beginPath(); ctx.arc(0,0,14*s,0,Math.PI*2); ctx.stroke();
        ctx.font = `900 ${14*s}px "Daily Display", sans-serif`; ctx.textAlign='center'; ctx.textBaseline='middle'; ctx.fillText('F',0,1*s);
    }
    ctx.restore();
}

function drawDailyFamePanel(ctx, x, y, w, h, title, iconType = 'fame') {
    const grad = ctx.createLinearGradient(x, y, x, y+h);
    grad.addColorStop(0, '#0d1a2c'); grad.addColorStop(1, '#07101c');
    drawRoundRect(ctx, x, y, w, h, 18); ctx.fillStyle = grad; ctx.fill();
    ctx.strokeStyle = '#8b6a28'; ctx.lineWidth = 2; ctx.stroke();
    ctx.strokeStyle = 'rgba(80,145,210,.35)'; ctx.lineWidth = 1;
    drawRoundRect(ctx, x+6, y+6, w-12, h-12, 14); ctx.stroke();
    dailyFameIcon(ctx, x+30, y+30, iconType, '#f5c451', .75);
    ctx.font = '900 23px "Daily Display", "Inter Display", sans-serif'; ctx.fillStyle='#f7e5ad'; ctx.textAlign='left'; ctx.textBaseline='middle'; ctx.fillText(title, x+55, y+30);
}

function drawDailyFameMetric(ctx, x, y, w, label, value, gain, iconType, color) {
    ctx.fillStyle = '#0a1422'; drawRoundRect(ctx, x, y, w, 86, 13); ctx.fill();
    ctx.strokeStyle = 'rgba(120,160,200,.22)'; ctx.stroke();
    dailyFameIcon(ctx, x+28, y+43, iconType, color, .62);
    ctx.font = '800 13px "Daily Text", sans-serif'; ctx.fillStyle='#9db2c9'; ctx.textAlign='left'; ctx.fillText(label, x+53, y+27);
    ctx.font = '900 20px "Daily Display", sans-serif'; ctx.fillStyle='#ffffff'; ctx.fillText(formatFame(value || 0), x+53, y+51);
    ctx.font = '800 12px "Daily Text", sans-serif'; ctx.fillStyle = gain === null ? '#77879a' : gain > 0 ? '#61df8b' : '#8fa0b2'; ctx.fillText(gain === null ? 'BASELINE' : dailyFameTextGain(gain), x+53, y+70);
}

function drawDailyFameRank(ctx, x, y, w, rank, player, gain) {
    const rowH = 66;
    ctx.fillStyle = '#0a1625'; drawRoundRect(ctx, x, y, w, rowH, 12); ctx.fill();
    ctx.strokeStyle = rank <= 3 ? '#a88336' : '#263c56'; ctx.lineWidth = rank <= 3 ? 1.5 : 1; ctx.stroke();
    const medal = rank === 1 ? '#f5c451' : rank === 2 ? '#c9d3df' : rank === 3 ? '#d18a55' : '#70839a';
    ctx.fillStyle = medal; ctx.beginPath(); ctx.arc(x+28, y+33, 18, 0, Math.PI*2); ctx.fill();
    ctx.font = '900 15px "Daily Display", sans-serif'; ctx.fillStyle='#08111d'; ctx.textAlign='center'; ctx.textBaseline='middle'; ctx.fillText(String(rank), x+28, y+34);
    ctx.fillStyle='#dce8f5'; ctx.font='900 17px "Daily Display", sans-serif'; ctx.textAlign='left'; ctx.fillText(player.name, x+57, y+26);
    ctx.font='700 11px "Daily Text", sans-serif'; ctx.fillStyle='#7691ad'; ctx.fillText(player.guild ? `<${player.guild}>` : 'No Guild', x+57, y+46);
    ctx.textAlign='right'; ctx.font='900 17px "Daily Display", sans-serif'; ctx.fillStyle='#f5c451'; ctx.fillText(dailyFameTextGain(gain), x+w-16, y+27);
    ctx.font='700 10px "Daily Text", sans-serif'; ctx.fillStyle='#8fa0b3'; ctx.fillText('DAILY TOTAL FAME', x+w-16, y+46);
}

async function generateDailyFameReportImage(config, reportDate, players) {
    const width = 1536, height = 1024;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // Cinematic Albion-style background with a darker glass treatment for readability.
    const bgPath = path.join(__dirname, 'assets', 'dailyfame-bg.png');
    if (fs.existsSync(bgPath)) {
        try {
            const bgImage = await loadImage(bgPath);
            const scale = Math.max(width / bgImage.width, height / bgImage.height);
            const bw = bgImage.width * scale, bh = bgImage.height * scale;
            ctx.drawImage(bgImage, (width - bw) / 2, (height - bh) / 2, bw, bh);
        } catch (err) {
            console.warn('⚠️ DailyFame background load failed:', err.message);
        }
    }

    const dark = ctx.createLinearGradient(0, 0, width, height);
    dark.addColorStop(0, 'rgba(1,6,15,.68)');
    dark.addColorStop(.45, 'rgba(3,11,24,.84)');
    dark.addColorStop(1, 'rgba(0,4,11,.93)');
    ctx.fillStyle = dark; ctx.fillRect(0, 0, width, height);

    // Decorative blue/gold atmosphere.
    for (let i = 0; i < 34; i++) {
        const x = (i * 211) % width;
        const y = 105 + ((i * 149) % 830);
        const r = 12 + (i % 6) * 7;
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, i % 3 === 0 ? 'rgba(245,196,81,.16)' : 'rgba(83,184,255,.09)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }

    const gold = '#f5c451', cream = '#fff4cf', muted = '#8da6bf';
    const green = '#61df8b', blue = '#53b8ff', purple = '#bd7cff', red = '#ff5d68', amber = '#ffb84d';
    const white = '#f4f8fc';
    const titleFont = '900 35px "Daily Display", "Inter Display", "Daily Thai Display", "Noto Sans Thai", sans-serif';
    const headFont = '900 20px "Daily Display", "Inter Display", "Daily Thai Display", "Noto Sans Thai", sans-serif';
    const bodyFont = '700 12px "Daily Text", "Daily Thai Text", "Noto Sans Thai", sans-serif';
    const smallFont = '700 10px "Daily Text", "Daily Thai Text", "Noto Sans Thai", sans-serif';

    const shadowedRoundRect = (x, y, w, h, r, fill, stroke, lineWidth = 1) => {
        ctx.save();
        ctx.shadowColor = 'rgba(0,0,0,.38)';
        ctx.shadowBlur = 18;
        ctx.shadowOffsetY = 5;
        drawRoundRect(ctx, x, y, w, h, r);
        ctx.fillStyle = fill; ctx.fill();
        ctx.shadowColor = 'transparent';
        if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lineWidth; ctx.stroke(); }
        ctx.restore();
    };

    const panel = (x, y, w, h, title, icon = 'fame', accent = gold) => {
        const grad = ctx.createLinearGradient(x, y, x, y + h);
        grad.addColorStop(0, 'rgba(9,28,48,.96)');
        grad.addColorStop(.55, 'rgba(5,18,33,.97)');
        grad.addColorStop(1, 'rgba(2,10,20,.98)');
        shadowedRoundRect(x, y, w, h, 18, grad, 'rgba(245,196,81,.78)', 1.5);
        ctx.save();
        ctx.strokeStyle = 'rgba(83,184,255,.22)'; ctx.lineWidth = 1;
        drawRoundRect(ctx, x + 6, y + 6, w - 12, h - 12, 14); ctx.stroke();
        // Header accent rail.
        const rail = ctx.createLinearGradient(x + 20, y, x + 165, y);
        rail.addColorStop(0, accent); rail.addColorStop(1, 'rgba(245,196,81,0)');
        ctx.strokeStyle = rail; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(x + 20, y + 61); ctx.lineTo(x + 165, y + 61); ctx.stroke();
        ctx.restore();
        dailyFameIcon(ctx, x + 31, y + 30, icon, accent, .72);
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillStyle = cream; ctx.font = headFont;
        ctx.fillText(title, x + 57, y + 30);
    };

    const glowText = (text, x, y, font, fill, align = 'left') => {
        ctx.save();
        ctx.textAlign = align; ctx.textBaseline = 'alphabetic'; ctx.font = font;
        ctx.shadowColor = fill; ctx.shadowBlur = 12;
        ctx.fillStyle = fill; ctx.fillText(text, x, y);
        ctx.restore();
    };

    const drawMiniBadge = (x, y, label, color) => {
        ctx.save();
        drawRoundRect(ctx, x, y, 88, 22, 11);
        ctx.fillStyle = `${color}18`; ctx.fill();
        ctx.strokeStyle = `${color}66`; ctx.lineWidth = 1; ctx.stroke();
        ctx.fillStyle = color; ctx.font = '900 9px "Daily Display", sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(label, x + 44, y + 11);
        ctx.restore();
    };

    const drawGain = (x, y, w, h, label, gain, icon, color, isTotal = false) => {
        const grad = ctx.createLinearGradient(x, y, x + w, y + h);
        grad.addColorStop(0, isTotal ? 'rgba(47,35,12,.92)' : 'rgba(8,23,39,.98)');
        grad.addColorStop(1, isTotal ? 'rgba(18,13,5,.98)' : 'rgba(3,12,23,.99)');
        shadowedRoundRect(x, y, w, h, 14, grad, `${color}B0`, isTotal ? 1.8 : 1.2);

        // Color strip.
        ctx.fillStyle = color;
        drawRoundRect(ctx, x + 1, y + 1, 5, h - 2, 3); ctx.fill();
        dailyFameIcon(ctx, x + 34, y + h / 2, icon, color, isTotal ? .82 : .67);

        ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = '#b9cce0';
        ctx.font = '900 11px "Daily Text", "Daily Thai Text", "Noto Sans Thai", sans-serif';
        ctx.fillText(label.toUpperCase(), x + 64, y + 27);

        const valueText = gain === null ? 'รอข้อมูลวันก่อน' : dailyFameTextGain(gain, '0');
        ctx.fillStyle = gain === null ? '#8497aa' : gain > 0 ? color : white;
        ctx.font = isTotal ? '900 27px "Daily Display", "Inter Display", sans-serif' : '900 23px "Daily Display", "Inter Display", sans-serif';
        ctx.fillText(valueText, x + 64, y + 59);

        ctx.fillStyle = gain === null ? '#687b90' : '#728aa1';
        ctx.font = smallFont;
        ctx.fillText(gain === null ? 'BASELINE • เริ่มเก็บ Snapshot' : 'เพิ่มจาก Snapshot วันก่อน', x + 64, y + h - 13);

        if (gain !== null && gain > 0) {
            glowText('▲', x + w - 18, y + 31, '900 17px "Daily Display", sans-serif', color, 'right');
        }
        if (isTotal) drawMiniBadge(x + w - 103, y + h - 30, 'ALL CATEGORIES', color);
    };

    // HEADER — stronger hierarchy and more game-like identity.
    ctx.fillStyle = 'rgba(2,7,15,.94)'; ctx.fillRect(0, 0, width, 116);
    ctx.strokeStyle = gold; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(0, 114); ctx.lineTo(width, 114); ctx.stroke();
    ctx.strokeStyle = 'rgba(83,184,255,.28)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, 118); ctx.lineTo(width, 118); ctx.stroke();

    glowText('♛  BOSS BOT', 30, 46, '900 37px "Daily Display", "Inter Display", sans-serif', gold);
    ctx.fillStyle = white; ctx.font = titleFont; ctx.textAlign = 'left'; ctx.fillText('DAILY FAME REPORT', 410, 44);
    ctx.fillStyle = '#c5d5e5'; ctx.font = '700 13px "Daily Text", "Daily Thai Text", "Noto Sans Thai", sans-serif';
    ctx.fillText(`สรุป Fame ที่เพิ่มขึ้นจาก Snapshot ก่อนหน้า  •  ${reportDate}`, 412, 69);
    drawMiniBadge(412, 82, 'ASIA • EAST', green);
    drawMiniBadge(507, 82, '09:00 ICT', gold);
    drawMiniBadge(602, 82, 'DAILY DELTA', blue);

    ctx.textAlign = 'right'; ctx.fillStyle = green; ctx.font = '900 12px "Daily Display", sans-serif';
    ctx.fillText(`${players.length} PLAYERS`, 1505, 42);
    ctx.fillStyle = muted; ctx.font = smallFont; ctx.fillText('TRACKED PLAYERS', 1505, 63);
    ctx.fillStyle = gold; ctx.font = '900 12px "Daily Display", sans-serif'; ctx.fillText('AUTO REPORT • 09:00', 1505, 88);

    const metricKeys = [
        ['PvE Fame', 'pveFame', 'pve', green],
        ['Gathering Fame', 'gatheringFame', 'gathering', blue],
        ['Crafting Fame', 'craftingFame', 'crafting', purple],
        ['Kill Fame', 'killFame', 'kill', red],
        ['Death Fame', 'deathFame', 'death', amber]
    ];
    const sums = Object.fromEntries(metricKeys.map(m => [m[1], sumPlayerDelta(players, m[1])]));
    const baseline = players.some(p => metricKeys.some(m => p.delta?.[m[1]] === null));
    const totalGain = metricKeys.reduce((n, m) => n + (Number(sums[m[1]]) || 0), 0);
    const ranked = [...players].sort((a, b) => totalPlayerGain(b.delta) - totalPlayerGain(a.delta));

    // LEFT — tracked players leaderboard.
    panel(24, 140, 340, 824, 'PLAYERS • DAILY GAIN', 'fame', gold);
    ctx.textAlign = 'left'; ctx.fillStyle = '#8199b0'; ctx.font = smallFont;
    ctx.fillText('ผู้เล่นที่ติดตาม • เรียงตาม Fame ที่เพิ่มขึ้น', 48, 181);

    let py = 207;
    ranked.slice(0, 16).forEach((p, i) => {
        const gain = totalPlayerGain(p.delta);
        const rowGrad = ctx.createLinearGradient(42, py - 19, 346, py + 29);
        rowGrad.addColorStop(0, i === 0 ? 'rgba(245,196,81,.15)' : 'rgba(9,27,45,.82)');
        rowGrad.addColorStop(1, 'rgba(4,14,25,.84)');
        shadowedRoundRect(42, py - 19, 304, 48, 10, rowGrad, i === 0 ? 'rgba(245,196,81,.55)' : 'rgba(83,184,255,.16)', 1);

        const medal = i === 0 ? gold : i === 1 ? '#d5dde6' : i === 2 ? '#d18a55' : '#637a91';
        ctx.fillStyle = medal; ctx.beginPath(); ctx.arc(62, py + 5, 13, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#07111c'; ctx.font = '900 10px "Daily Display", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(i + 1), 62, py + 6);

        ctx.textAlign = 'left'; ctx.fillStyle = '#edf5fb';
        ctx.font = '900 12px "Daily Display", "Daily Thai Display", "Noto Sans Thai", sans-serif';
        ctx.fillText(String(p.name).slice(0, 25), 84, py + 1);
        ctx.fillStyle = gain > 0 ? green : '#7f91a4'; ctx.font = '900 11px "Daily Display", sans-serif';
        ctx.fillText(p.delta?.pveFame === null ? 'BASELINE' : dailyFameTextGain(gain, '0'), 84, py + 18);
        ctx.textAlign = 'right'; ctx.fillStyle = gain > 0 ? '#91a9c0' : '#667c91'; ctx.font = smallFont;
        ctx.fillText(gain > 0 ? 'DAILY GAIN' : 'WAITING', 329, py + 18);
        py += 55;
    });
    if (!players.length) { ctx.textAlign = 'left'; ctx.fillStyle = '#8398ac'; ctx.font = bodyFont; ctx.fillText('ยังไม่มีผู้เล่นที่ติดตาม', 48, 220); }

    // Bottom summary chip inside left panel.
    ctx.fillStyle = 'rgba(245,196,81,.07)'; drawRoundRect(ctx, 42, 899, 304, 46, 10); ctx.fill();
    ctx.strokeStyle = 'rgba(245,196,81,.30)'; ctx.lineWidth = 1; ctx.stroke();
    ctx.textAlign = 'left'; ctx.fillStyle = '#9db2c9'; ctx.font = smallFont; ctx.fillText('TOTAL DAILY FAME', 57, 918);
    ctx.textAlign = 'right'; ctx.fillStyle = baseline ? '#8497aa' : gold; ctx.font = '900 18px "Daily Display", sans-serif';
    ctx.fillText(baseline ? 'BASELINE' : dailyFameTextGain(totalGain, '0'), 329, 932);

    // CENTER TOP — exactly 6 tiles in a clean 2 × 3 grid. No overlap.
    panel(384, 140, 730, 435, 'DAILY FAME GAIN • ALL PLAYERS', 'fame', blue);
    ctx.textAlign = 'left'; ctx.fillStyle = '#7f9ab3'; ctx.font = smallFont;
    ctx.fillText('เฉพาะ Delta • ไม่แสดง Lifetime Fame', 410, 181);

    const centerTiles = [
        ...metricKeys.map(m => ({ label: m[0], key: m[1], icon: m[2], color: m[3] })),
        { label: 'TOTAL FAME GAIN', key: '__total', icon: 'fame', color: gold, total: true }
    ];
    centerTiles.forEach((m, i) => {
        const col = i % 2, row = Math.floor(i / 2);
        const x = 410 + col * 350, y = 198 + row * 113;
        const value = m.total ? totalGain : sums[m.key];
        const isNull = m.total ? baseline : (baseline && players.some(p => p.delta?.[m.key] === null));
        drawGain(x, y, 334, 96, m.label, isNull ? null : value, m.icon, m.color, !!m.total);
    });

    // RIGHT TOP — top performers.
    panel(1134, 140, 378, 435, 'TOP PERFORMERS', 'fame', gold);
    ctx.textAlign = 'left'; ctx.fillStyle = '#7f9ab3'; ctx.font = smallFont;
    ctx.fillText('อันดับจาก Total Fame ที่เพิ่มขึ้นวันนี้', 1160, 181);
    ranked.slice(0, 6).forEach((p, i) => {
        const y = 204 + i * 55, gain = totalPlayerGain(p.delta);
        const rowGrad = ctx.createLinearGradient(1154, y - 18, 1492, y + 27);
        rowGrad.addColorStop(0, i < 3 ? 'rgba(245,196,81,.11)' : 'rgba(7,20,34,.78)');
        rowGrad.addColorStop(1, 'rgba(3,12,22,.82)');
        shadowedRoundRect(1154, y - 18, 338, 45, 9, rowGrad, i < 3 ? 'rgba(245,196,81,.36)' : 'rgba(83,184,255,.14)', 1);
        const medal = i === 0 ? gold : i === 1 ? '#d5dde6' : i === 2 ? '#d18a55' : '#61778d';
        ctx.fillStyle = medal; ctx.beginPath(); ctx.arc(1176, y + 4, 12, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#06101b'; ctx.font = '900 9px "Daily Display", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(i + 1), 1176, y + 5);
        ctx.textAlign = 'left'; ctx.fillStyle = '#e9f2f8'; ctx.font = '900 11px "Daily Display", "Daily Thai Display", "Noto Sans Thai", sans-serif';
        ctx.fillText(String(p.name).slice(0, 21), 1197, y + 1);
        ctx.textAlign = 'right'; ctx.fillStyle = gain > 0 ? gold : '#8296a9'; ctx.font = '900 12px "Daily Display", sans-serif';
        ctx.fillText(p.delta?.pveFame === null ? 'BASELINE' : dailyFameTextGain(gain, '0'), 1479, y + 7);
    });
    if (!ranked.length) {
        ctx.textAlign = 'center'; ctx.fillStyle = '#7d91a6'; ctx.font = bodyFont; ctx.fillText('ยังไม่มีข้อมูลผู้เล่น', 1323, 270);
    }

    // BOTTOM — player-by-player delta matrix, fully separated from the cards above.
    panel(384, 600, 1128, 364, 'PLAYER DAILY BREAKDOWN • DELTA ONLY', 'fame', purple);
    ctx.textAlign = 'left'; ctx.fillStyle = '#7f9ab3'; ctx.font = smallFont;
    ctx.fillText('ทุกตัวเลขคือ Fame ที่เพิ่มขึ้นจาก Snapshot ก่อนหน้า', 414, 640);

    const cols = [
        { x: 595, label: 'PvE', key: 'pveFame', color: green, icon: 'pve' },
        { x: 786, label: 'Gathering', key: 'gatheringFame', color: blue, icon: 'gathering' },
        { x: 977, label: 'Crafting', key: 'craftingFame', color: purple, icon: 'crafting' },
        { x: 1168, label: 'Kill', key: 'killFame', color: red, icon: 'kill' },
        { x: 1359, label: 'Death', key: 'deathFame', color: amber, icon: 'death' }
    ];
    ctx.fillStyle = 'rgba(83,184,255,.06)'; drawRoundRect(ctx, 408, 651, 1072, 30, 7); ctx.fill();
    ctx.textAlign = 'left'; ctx.fillStyle = '#9ab0c5'; ctx.font = '900 10px "Daily Display", sans-serif'; ctx.fillText('PLAYER', 425, 670);
    cols.forEach(c => {
        dailyFameIcon(ctx, c.x, 666, c.icon, c.color, .30);
        ctx.fillStyle = c.color; ctx.font = '900 9px "Daily Display", sans-serif'; ctx.fillText(c.label.toUpperCase(), c.x + 15, 670);
    });

    let ry = 693;
    ranked.slice(0, 6).forEach((p, i) => {
        ctx.fillStyle = i % 2 ? 'rgba(6,17,30,.70)' : 'rgba(10,27,45,.82)';
        drawRoundRect(ctx, 408, ry - 18, 1072, 37, 8); ctx.fill();
        ctx.strokeStyle = i === 0 ? 'rgba(245,196,81,.28)' : 'rgba(83,184,255,.10)'; ctx.lineWidth = 1; ctx.stroke();
        ctx.fillStyle = '#e7f1f8'; ctx.font = '900 11px "Daily Display", "Daily Thai Display", "Noto Sans Thai", sans-serif'; ctx.textAlign = 'left';
        ctx.fillText(String(p.name).slice(0, 25), 425, ry + 5);
        cols.forEach(c => {
            const d = p.delta?.[c.key];
            ctx.textAlign = 'right'; ctx.fillStyle = d === null ? '#7d8fa1' : d > 0 ? c.color : '#9eafbf';
            ctx.font = '900 11px "Daily Display", sans-serif';
            ctx.fillText(d === null ? 'BASELINE' : dailyFameTextGain(d, '0'), c.x + 145, ry + 5);
        });
        ry += 43;
    });
    if (!ranked.length) {
        ctx.textAlign = 'center'; ctx.fillStyle = '#7d91a6'; ctx.font = bodyFont; ctx.fillText('ยังไม่มีข้อมูลสำหรับแสดงผล', 944, 740);
    }
    if (ranked.length > 6) {
        ctx.textAlign = 'left'; ctx.fillStyle = '#72879c'; ctx.font = smallFont;
        ctx.fillText(`และอีก ${ranked.length - 6} คน • ดูรายชื่อเต็มด้วย /dailyfame list`, 425, 957);
    }
    if (baseline) {
        ctx.textAlign = 'right'; ctx.fillStyle = '#8497aa'; ctx.font = smallFont;
        ctx.fillText('หมายเหตุ: ผู้เล่นที่ยังไม่มี Snapshot ก่อนหน้าจะแสดง BASELINE', 1480, 957);
    }

    // FOOTER.
    ctx.fillStyle = 'rgba(1,5,11,.98)'; ctx.fillRect(0, 980, width, 44);
    ctx.strokeStyle = 'rgba(245,196,81,.48)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, 980); ctx.lineTo(width, 980); ctx.stroke();
    ctx.textAlign = 'left'; ctx.fillStyle = '#6f859a'; ctx.font = '700 9px "Daily Text", "Daily Thai Text", "Noto Sans Thai", sans-serif';
    ctx.fillText('SOURCE • Official Albion GameInfo Asia (East)   |   DAILY DELTA = CURRENT − PREVIOUS SNAPSHOT', 28, 1007);
    glowText('♛  POWERED BY  BOSS BOT', 1505, 1007, '900 12px "Daily Display", "Inter Display", sans-serif', gold, 'right');

    return new AttachmentBuilder(canvas.toBuffer('image/png'), { name: `daily-fame-${reportDate}.png` });
}

async function collectDailyFameSnapshot(config) {
    const reportDate = getIctDateKey();
    const playerResults = await Promise.all(config.players.map(async name => {
        try { return await fetchDailyFamePlayer(name); }
        catch (err) { console.warn(`⚠️ DailyFame player failed (${name}): ${err.message}`); return { name, trackedName: name, error: err.message }; }
    }));
    // Compare against the most recent snapshot from a PREVIOUS day, never against the
    // same-day snapshot. This keeps manual /dailyfame report and the 09:00 auto report
    // consistent and prevents the second report on the same day from becoming +0.
    const history = config.snapshots?.history || {};
    const previousDates = Object.keys(history).filter(k => k < reportDate).sort();
    const previous = previousDates.length ? history[previousDates[previousDates.length - 1]] : null;

    const players = playerResults.filter(x => !x.error).map(current => {
        const prev = previous?.players?.find(p => String(p.trackedName).toLowerCase() === String(current.trackedName).toLowerCase());
        return { ...current, delta: playerDailyDelta(current, prev) };
    });
    if (!players.length) {
        const failedPlayers = playerResults.filter(x => x.error).map(x => `${x.name}: ${x.error}`).join(' | ');
        throw new Error(`ไม่สามารถดึงข้อมูลผู้เล่นที่ติดตามได้${failedPlayers ? ` — ${failedPlayers}` : ''}`);
    }

    const snapshot = {
        date: reportDate,
        fetchedAt: new Date().toISOString(),
        players,
        source: DAILY_FAME_SOURCE
    };
    config.snapshots.latest = snapshot;
    // Keep a compact 31-day history for weekly/monthly expansion without growing tracking.json forever.
    config.snapshots.history = config.snapshots.history || {};
    config.snapshots.history[reportDate] = snapshot;
    const keys = Object.keys(config.snapshots.history).sort();
    while (keys.length > 31) delete config.snapshots.history[keys.shift()];
    return { reportDate, players, snapshot };
}

async function generateAndSendDailyFameReport(config, channel, isAutomatic = false) {
    const { reportDate, players } = await collectDailyFameSnapshot(config);
    const card = await generateDailyFameReportImage(config, reportDate, players);
    const text = `🏆 **DailyFame Report — Asia (East)**\n📅 **${reportDate}** • ⏰ **09:00 ICT**\n👤 ผู้เล่น: **${players.length}**\n📊 Daily Delta: PvE • Gathering • Crafting • Kill Fame • Death Fame`;
    await channel.send({ content: text, files: [card] });
    if (isAutomatic) config.lastReportDate = reportDate;
    saveData();
}

async function checkAndSendDailyFameReports() {
    const now = new Date();
    const dateKey = getIctDateKey(now);
    const hour = getIctHour(now);
    if (hour < DAILY_FAME_REPORT_HOUR_ICT) return;
    for (const config of Object.values(dailyFameConfigs)) {
        if (!config?.enabled || !config.channelId || config.lastReportDate === dateKey) continue;
        try {
            const channel = await client.channels.fetch(config.channelId);
            if (!channel || !channel.isTextBased()) continue;
            console.log(`⏰ DailyFame auto report -> guild ${config.guildId} (${dateKey})`);
            await generateAndSendDailyFameReport(config, channel, true);
        } catch (err) {
            console.error(`❌ DailyFame auto report failed (${config.guildId}):`, err.message);
        }
    }
}

function scheduleDailyFameAutoCheck() {
    setTimeout(async () => {
        try { await checkAndSendDailyFameReports(); }
        catch (err) { console.error('❌ DailyFame scheduler error:', err.message); }
        finally { scheduleDailyFameAutoCheck(); }
    }, 60 * 1000);
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
    new SlashCommandBuilder().setName('daily').setDescription('ดึงข้อมูลหรือตั้งค่ารายงานโบนัสประจำวัน Asia (East)')
        .addSubcommand(s => s.setName('get').setDescription('ดึงข้อมูลโบนัสประจำวัน Asia (East) ทันที')
            .addChannelOption(o => o.setName('channel').setDescription('ส่งรายงานไปยังห้องที่เลือก (ไม่เลือกจะส่งห้องนี้)').addChannelTypes(ChannelType.GuildText)))
        .addSubcommand(s => s.setName('setup').setDescription('ตั้งค่าแจ้งเตือน Daily Bonus Asia (East) อัตโนมัติหลังรีเซ็ตทุกวัน')
            .addChannelOption(o => o.setName('channel').setDescription('ห้องที่ต้องการให้แจ้งเตือนอัตโนมัติ').addChannelTypes(ChannelType.GuildText).setRequired(true)))
        .addSubcommand(s => s.setName('confirm').setDescription('ยืนยันโบนัส Asia จากข้อมูลที่เห็นในเกม')
            .addStringOption(o => o.setName('category').setDescription('ชื่อหมวดโบนัส เช่น Cloth Robes').setRequired(true))
            .addStringOption(o => o.setName('city').setDescription('เมืองที่ได้โบนัส เช่น Fort Sterling').setRequired(true))
            .addIntegerOption(o => o.setName('bonus').setDescription('เปอร์เซ็นต์โบนัส เช่น 10 หรือ 20').setRequired(true).setMinValue(1).setMaxValue(100)))
        .addSubcommand(s => s.setName('status').setDescription('ตรวจสถานะแหล่งข้อมูลและเวลาตรวจล่าสุด'))
        .addSubcommand(s => s.setName('refresh').setDescription('ดึงข้อมูล Daily ใหม่ทันที'))
        .addSubcommand(s => s.setName('remove').setDescription('ยกเลิกการส่งรายงานโบนัสประจำวันอัตโนมัติในเซิร์ฟเวอร์นี้'))
    ,new SlashCommandBuilder().setName('dailyfame').setDescription('สรุป Fame ที่เพิ่มขึ้นรายวันของผู้เล่นเวลา 09:00 Asia (East)')
        .addSubcommand(s => s.setName('addplayer').setDescription('เพิ่มผู้เล่นที่ต้องการติดตาม')
            .addStringOption(o => o.setName('name').setDescription('ชื่อผู้เล่น Albion').setRequired(true)))
        .addSubcommand(s => s.setName('removeplayer').setDescription('ลบผู้เล่นออกจาก DailyFame')
            .addStringOption(o => o.setName('name').setDescription('ชื่อผู้เล่น Albion').setRequired(true)))
        .addSubcommand(s => s.setName('list').setDescription('ดูรายชื่อผู้เล่นที่ติดตาม'))
        .addSubcommand(s => s.setName('setup').setDescription('ตั้งค่าห้องส่งรายงานอัตโนมัติทุกวันเวลา 09:00 ICT')
            .addChannelOption(o => o.setName('channel').setDescription('ห้องที่จะส่งรายงาน').addChannelTypes(ChannelType.GuildText).setRequired(true)))
        .addSubcommand(s => s.setName('remove').setDescription('ยกเลิกการส่งรายงาน DailyFame อัตโนมัติ'))
        .addSubcommand(s => s.setName('report').setDescription('สร้างรายงาน DailyFame ตอนนี้'))
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
    scheduleDailyAutoCheck();
    scheduleDailyFameAutoCheck();
    setTimeout(() => checkAndSendDailyAutoReports().catch(err => console.error('❌ Startup Daily check failed:', err.message)), 10000);
    setTimeout(() => checkAndSendDailyFameReports().catch(err => console.error('❌ Startup DailyFame check failed:', err.message)), 15000);
    setTimeout(() => checkAndSendBanditAlerts().catch(err => console.error('❌ Startup Bandit check failed:', err.message)), 5000);
    setInterval(checkAndSendBanditAlerts, 30 * 1000);
    preloadDailyIcons().catch(err => console.warn('⚠️ Daily icon preload failed:', err.message));
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

    if (commandName === 'dailyfame') {
        const sub = interaction.options.getSubcommand();
        const config = getDailyFameConfig(interaction.guildId);

        if (sub === 'addplayer') {
            const rawName = interaction.options.getString('name');
            const name = normalizeTrackedName(rawName);
            if (!name) return interaction.reply({ content: '❌ กรุณาระบุชื่อผู้เล่น Albion', flags: 64 });

            const exists = config.players.some(x => normalizeTrackedName(x).toLowerCase() === name.toLowerCase());
            if (exists) {
                return interaction.reply({ content: `⚠️ ผู้เล่น **${name}** อยู่ในรายการ DailyFame แล้ว`, flags: 64 });
            }

            config.players.push(name);
            // Keep the player list immediately even if the external API is temporarily unavailable.
            // The next /dailyfame report (or the 09:00 auto report) will fetch the snapshot.
            saveData();
            return interaction.reply(`✅ เพิ่มผู้เล่น **${name}** ใน DailyFame แล้ว\n📊 จะติดตาม PvE Fame • Gathering Fame • Crafting Fame • Kill Fame • Death Fame\n🌏 เซิร์ฟเวอร์: **Asia (East)**\n⏰ รายงานอัตโนมัติ: **09:00 ICT**`);
        }

        if (sub === 'removeplayer') {
            const rawName = interaction.options.getString('name');
            const name = normalizeTrackedName(rawName);
            const before = config.players.length;
            config.players = config.players.filter(x => normalizeTrackedName(x).toLowerCase() !== name.toLowerCase());
            if (before === config.players.length) {
                return interaction.reply({ content: `❌ ไม่พบผู้เล่น **${name}** ใน DailyFame`, flags: 64 });
            }
            saveData();
            return interaction.reply(`🗑️ ลบผู้เล่น **${name}** ออกจาก DailyFame แล้ว`);
        }

        if (sub === 'list') {
            const playersText = config.players.length
                ? config.players.map((x, i) => `${i + 1}. ${x}`).join('\n')
                : '— ไม่มี —';
            return interaction.reply({ embeds: [new EmbedBuilder()
                .setColor(0xf5c451)
                .setTitle('🏆 DailyFame Tracker — Asia (East)')
                .setDescription(`⏰ รายงานอัตโนมัติ: **09:00 ICT**\n📢 ห้อง: ${config.channelId ? `<#${config.channelId}>` : 'ยังไม่ได้ตั้งค่า'}\n⚙️ สถานะ: **${config.enabled ? 'ON' : 'OFF'}**\n📊 รายงานแสดงเฉพาะ Fame ที่เพิ่มขึ้นจากวันก่อน`)
                .addFields({ name: `👤 Players (${config.players.length})`, value: playersText.slice(0, 1024) })
                .setFooter({ text: 'Powered by Boss Bot' })] });
        }

        if (sub === 'setup') {
            const channel = interaction.options.getChannel('channel');
            config.channelId = channel.id;
            config.enabled = true;
            saveData();
            return interaction.reply(`✅ **DailyFame Auto Report เปิดใช้งานแล้ว**\n📢 ห้อง: <#${channel.id}>\n⏰ เวลา: **ทุกวัน 09:00 น. ICT**\n🌏 เซิร์ฟเวอร์: **Asia (East)**\n📊 รายงาน: Daily Delta ของ PvE • Gathering • Crafting • Kill Fame • Death Fame`);
        }

        if (sub === 'remove') {
            config.enabled = false;
            saveData();
            return interaction.reply('🗑️ ยกเลิกการส่ง DailyFame อัตโนมัติแล้ว แต่รายชื่อผู้เล่นและประวัติ Snapshot ยังเก็บไว้');
        }

        if (sub === 'report') {
            await interaction.deferReply();
            if (!config.players.length) return interaction.editReply('❌ ยังไม่มีผู้เล่นที่ติดตาม ใช้ `/dailyfame addplayer` ก่อน');
            try {
                const { reportDate, players } = await collectDailyFameSnapshot(config);
                const card = await generateDailyFameReportImage(config, reportDate, players);
                saveData();
                return interaction.editReply({ content: `🏆 **DailyFame Report** — ${reportDate}\n📊 Source: **Official Albion GameInfo Asia (East)**`, files: [card] });
            } catch (err) {
                console.error('❌ Manual DailyFame report failed:', err.message);
                return interaction.editReply(`❌ สร้าง DailyFame Report ไม่สำเร็จ: **${err.message}**`);
            }
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
            const playersText = config.players.length ? config.players.map((x,i)=>`${i+1}. ${x}`).join('\n') : '— ไม่มี —';
            return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xf5c451).setTitle('🏆 DailyFame Tracker — Asia (East)').setDescription(`⏰ รายงานอัตโนมัติ: **09:00 ICT**\n📢 ห้อง: ${config.channelId ? `<#${config.channelId}>` : 'ยังไม่ได้ตั้งค่า'}\n⚙️ สถานะ: **${config.enabled ? 'ON' : 'OFF'}**\n📊 รายงานแสดงเฉพาะ Fame ที่เพิ่มขึ้นจากวันก่อน`).addFields(
                { name: `👤 Players (${config.players.length})`, value: playersText.slice(0,1024) }
            ).setFooter({ text: 'Powered by Boss Bot' })] });
        }
        if (sub === 'setup')        if (sub === 'setup') {
            const channel = interaction.options.getChannel('channel');
            config.channelId = channel.id; config.enabled = true; saveData();
            return interaction.reply(`✅ **DailyFame Auto Report เปิดใช้งานแล้ว**\n📢 ห้อง: <#${channel.id}>\n⏰ เวลา: **ทุกวัน 09:00 น. ICT**\n🌏 เซิร์ฟเวอร์: **Asia (East)**\n📊 รายงาน: Daily Delta ของ PvE • Gathering • Crafting • Kill Fame • Death Fame`);
        }
        if (sub === 'remove') {
            config.enabled = false; saveData();
            return interaction.reply('🗑️ ยกเลิกการส่ง DailyFame อัตโนมัติแล้ว แต่รายชื่อผู้เล่นและประวัติ Snapshot ยังเก็บไว้');
        }
        if (sub === 'report') {
            await interaction.deferReply();
            if (!config.players.length) return interaction.editReply('❌ ยังไม่มีผู้เล่นที่ติดตาม ใช้ `/dailyfame addplayer` ก่อน');
            try {
                const { reportDate, players } = await collectDailyFameSnapshot(config);
                const card = await generateDailyFameReportImage(config, reportDate, players);
                saveData();
                return interaction.editReply({ content: `🏆 **DailyFame Report** — ${reportDate}\n📊 Source: **Official Albion GameInfo Asia (East)**`, files: [card] });
            } catch (err) {
                console.error('❌ Manual DailyFame report failed:', err.message);
                return interaction.editReply(`❌ สร้าง DailyFame Report ไม่สำเร็จ: **${err.message}**`);
            }
        }
    }

    if (commandName === 'daily') {
        const sub = interaction.options.getSubcommand();

        if (sub === 'confirm') {
            const category = interaction.options.getString('category').trim();
            const city = interaction.options.getString('city').trim();
            const dailyBonus = interaction.options.getInteger('bonus');
            const meta = Object.values(DAILY_CATEGORY_META).find(x => x.label.toLowerCase() === category.toLowerCase());
            const normalizedCategory = meta?.label || category;
            const normalizedCity = meta?.city || city;
            dailyPlayerConfirmations = dailyPlayerConfirmations.filter(x => !(x.server === 'asia' && x.date === getExpectedDailyDate() && x.category.toLowerCase() === normalizedCategory.toLowerCase() && x.userId === interaction.user.id));
            dailyPlayerConfirmations.push({ server: 'asia', date: getExpectedDailyDate(), category: normalizedCategory, city: normalizedCity, baseBonus: meta?.baseBonus || 15, dailyBonus, userId: interaction.user.id, userName: interaction.user.tag, confirmedAt: new Date().toISOString() });
            saveData();
            const total = dailyPlayerConfirmations.filter(x => x.server === 'asia' && x.date === getExpectedDailyDate()).length;
            return interaction.reply(`✅ บันทึกการยืนยันโบนัส Asia แล้ว\n**${normalizedCategory}** +${dailyBonus}% — ${normalizedCity}\n👥 จำนวนการยืนยันวันนี้: **${total}** คน/รายการ`);
        }

        if (sub === 'status') {
            const status = dailySourceStatus.asia || {};
            const communityCount = dailyPlayerConfirmations.filter(x => x.server === 'asia' && x.date === getExpectedDailyDate()).length;
            return interaction.reply({ ephemeral: true, content: `📊 **DAILY STATUS — ASIA**\nAO-SAGE: **${status.aoSage || 'ยังไม่ตรวจ'}**\nAlbion Database: **${status.albionDatabase || 'ยังไม่ตรวจ'}**${status.albionDatabaseUpdated ? ` (Updated ${status.albionDatabaseUpdated})` : ''}\nAODP: **${status.aodp || 'ยังไม่ตรวจ'}**\nExternal Feed: **${status.externalFeed || 'ไม่ได้ตั้งค่า'}**\nCommunity: **${communityCount}** การยืนยันวันนี้\nตรวจล่าสุด: **${status.checkedAt ? formatIctTime(status.checkedAt) : 'ยังไม่มีข้อมูล'} น. ICT**\nสถานะ: **${status.aoSage === 'confirmed' || status.aodp === 'confirmed' || status.externalFeed === 'confirmed' ? 'CONFIRMED' : communityCount ? 'COMMUNITY CONFIRMED' : 'WAITING'}**` });
        }

        if (sub === 'refresh') {
            await interaction.deferReply();
            const refreshed = await generateDailyBonusCard('asia');
            return refreshed ? interaction.editReply({ content: '✅ ดึง Daily Bonus Asia ใหม่แล้ว', files: [refreshed] }) : interaction.editReply('⏳ ยังไม่มีข้อมูลของวันนี้จากแหล่งข้อมูลที่เชื่อมต่ออยู่ และยังไม่มีการยืนยันจากผู้เล่น');
        }

        if (sub === 'get') {
            await interaction.deferReply();
            const targetChannel1 = interaction.options.getChannel('channel') || interaction.channel;

            const cardAsia = await generateDailyBonusCard('asia');

            if (!cardAsia) {
                const status = dailySourceStatus.asia || {};
                const checkedAt = status.checkedAt ? formatIctTime(status.checkedAt) : 'ไม่ทราบเวลา';
                return interaction.editReply(
                    `⏳ **ยังไม่มี Daily Bonus ที่ยืนยันได้สำหรับ Asia (East) วันนี้**\n` +
                    `AO-SAGE ยังไม่มี snapshot และ AODP ยังไม่ยืนยันข้อมูลหลังรีเซ็ต\n` +
                    `ตรวจสอบล่าสุด: ${checkedAt} น. — ลองใช้คำสั่งนี้อีกครั้งภายหลัง`
                );
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
            const serverChoice = 'asia';

            const existingIndex = dailyAutoConfigs.findIndex(c => c.guildId === interaction.guildId);
            const configData = {
                guildId: interaction.guildId,
                channelId: channel.id,
                serverChoice: 'asia'
            };

            if (existingIndex >= 0) {
                dailyAutoConfigs[existingIndex] = configData;
            } else {
                dailyAutoConfigs.push(configData);
            }
            saveData();

            const setupCard = await generateDailyBonusCard(serverChoice);
            const setupMessage = `✅ **ตั้งค่ารายงานโบนัสรายวันอัตโนมัติสำเร็จ!**\n- 🌐 เซิร์ฟเวอร์: **Asia (East)** เท่านั้น\n- 📢 ห้องแจ้งเตือน: <#${channel.id}>\n- ⏰ เวลาแจ้งเตือน: **หลัง ${getDailyResetText('asia')}** ของทุกวัน\n- 🔎 ระบบจะลอง AO-SAGE + แหล่งสำรอง/Community และไม่ส่งข้อมูลของเมื่อวานแทนวันนี้`;
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

console.log('🛡️ AUTO-BATTLE FIX V3 LOADED: Auto-Battle + /daily + /dailyfame enabled');

client.login(BOT_TOKEN);