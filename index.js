// AUTO-BATTLE FIX V3 (STABLE CANVAS) + DAILY BONUS COMMAND & AUTOMATION + AVA FIX
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
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const express = require('express');

const BANDIT_SERIF_FONT = '/usr/share/fonts/truetype/noto/NotoSerifDisplay-Black.ttf';
const BANDIT_DISPLAY_FONT = '/usr/share/fonts/truetype/noto/NotoSansDisplay-CondensedExtraBold.ttf';
if (fs.existsSync(BANDIT_SERIF_FONT)) GlobalFonts.registerFromPath(BANDIT_SERIF_FONT, 'Bandit Serif');
if (fs.existsSync(BANDIT_DISPLAY_FONT)) GlobalFonts.registerFromPath(BANDIT_DISPLAY_FONT, 'Bandit Display');

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
let dailyAutoConfigs = []; 
let dailyPlayerConfirmations = []; 
let dailySourceStatus = {};
let banditAutoConfigs = []; 
let avaAutoConfigs = []; 
let avaProcessedMessages = new Set();
let processedBattles = new Set();
let autoBattleCheckRunning = false;
let lastDailyReportDate = {}; 
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
        dailyPlayerConfirmations = Array.isArray(data.dailyConfirmations) ? data.dailyConfirmations : [];
        dailySourceStatus = data.dailySourceStatus && typeof data.dailySourceStatus === 'object' ? data.dailySourceStatus : {};
        banditAutoConfigs = Array.isArray(data.banditAuto) ? data.banditAuto : [];
        avaAutoConfigs = Array.isArray(data.avaAuto) ? data.avaAuto : [];

        console.log(`📁 Tracking restored: ${targetGuilds.length} guilds, ${targetPlayers.length} players, ${autoBattleConfigs.length} auto-battle configs, ${dailyAutoConfigs.length} daily auto configs, ${banditAutoConfigs.length} bandit configs, ${avaAutoConfigs.length} ava configs`);
    } catch (err) {
        console.error('❌ tracking.json load error:', err.message);
        targetPlayers = [];
        targetGuilds = [];
        autoBattleConfigs = [];
        dailyAutoConfigs = [];
        dailyPlayerConfirmations = [];
        dailySourceStatus = {};
        banditAutoConfigs = [];
        avaAutoConfigs = [];
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
            avaAuto: avaAutoConfigs
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

function extractAvaCount(bodyText, label) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [
        new RegExp(`${escaped}\\s*[:×x*]?\\s*(\\d+)`, 'i'),
        new RegExp(`(\\d+)\\s*${escaped}`, 'i'),
        new RegExp(`${escaped}[\\s\\S]{0,24}?[×x*:]\\s*(\\d+)`, 'i')
    ];
    for (const re of patterns) {
        const m = bodyText.match(re);
        if (m) return Number(m[1]) || 0;
    }
    return 0;
}

// ----------------------------------------------------
// FILTER LOGIC FOR AUTOBATTLE (PLAYER/GUILD & FAME CHECK)
// ----------------------------------------------------
function filterTrackedBattlePlayers(playersList, minFameThreshold = 0) {
    if (!Array.isArray(playersList)) return [];

    const trackedPlayerNames = new Set(
        targetPlayers.map(p => (typeof p === 'string' ? p : p.name || '').trim().toLowerCase())
    );
    const trackedGuildNames = new Set(
        targetGuilds.map(g => (typeof g === 'string' ? g : g.name || '').trim().toLowerCase())
    );

    return playersList.filter(player => {
        const playerName = String(player.name || player.Name || '').trim().toLowerCase();
        const guildName = String(player.guildName || player.GuildName || player.guild || '').trim().toLowerCase();
        const playerFame = parseFameValue(player.killFame ?? player.fame ?? player.kill_fame ?? 0);

        const isTrackedPlayer = trackedPlayerNames.has(playerName);
        const isTrackedGuild = guildName && trackedGuildNames.has(guildName);

        // ต้องเป็นผู้เล่น หรือกิลด์ที่ถูกลงทะเบียนไว้เท่านั้น
        if (!isTrackedPlayer && !isTrackedGuild) {
            return false;
        }

        // ต้องมีค่า Fame ถึงเกณฑ์ที่กำหนด
        return playerFame >= minFameThreshold;
    });
}

// ----------------------------------------
// UPDATED AVA PARSER (FIX NUMBERS & ICONS)
// ----------------------------------------
async function fetchAvalonTrackerMapData(mapName) {
    const slug = normalizeMapNameText(mapName).toLowerCase().replace(/\s+/g, '-');
    const url = `https://avalonroads-97617.web.app/mapas/${encodeURIComponent(slug)}.html`;
    const response = await axios.get(url, {
        timeout: 15000,
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html,application/xhtml+xml' },
        validateStatus: status => status >= 200 && status < 400
    });
    const html = String(response.data || '');
    const $ = cheerio.load(html);
    const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
    const name = $('h1').first().text().trim() || mapName;
    if (!name || (!/Resources|Chests|Tier/i.test(bodyText) && $('img').length === 0)) {
        throw new Error(`Avalon Tracker ไม่พบแมพ ${mapName}`);
    }

    const countBySelectorOrAlt = (patterns) => {
        let count = 0;
        $('img, div, span, li').each((_, el) => {
            const src = $(el).attr('src') || '';
            const alt = $(el).attr('alt') || '';
            const className = $(el).attr('class') || '';
            const text = $(el).text().trim();

            for (const p of patterns) {
                if (p.test(src) || p.test(alt) || p.test(className) || p.test(text)) {
                    count++;
                    break;
                }
            }
        });
        return count;
    };

    const parseCountText = (regexes) => {
        for (const re of regexes) {
            const m = bodyText.match(re);
            if (m) return Number(m[1]) || 0;
        }
        return 0;
    };

    const goldChest = countBySelectorOrAlt([/chest_gold/i, /gold_chest/i, /bau_ouro/i]) || parseCountText([/Gold\s*Chest[s]?\s*[:×x*]?\s*(\d+)/i, /(\d+)\s*Gold\s*Chest[s]?/i]);
    const blueChest = countBySelectorOrAlt([/chest_blue/i, /blue_chest/i, /bau_azul/i]) || parseCountText([/Blue\s*Chest[s]?\s*[:×x*]?\s*(\d+)/i, /(\d+)\s*Blue\s*Chest[s]?/i]);
    const greenChest = countBySelectorOrAlt([/chest_green/i, /green_chest/i, /bau_verde/i]) || parseCountText([/Green\s*Chest[s]?\s*[:×x*]?\s*(\d+)/i, /(\d+)\s*Green\s*Chest[s]?/i]);
    
    const groupDungeon = countBySelectorOrAlt([/dungeon_group/i, /dg_group/i, /group_dungeon/i]) || parseCountText([/Group\s*Dungeon[s]?\s*[:×x*]?\s*(\d+)/i, /(\d+)\s*Group\s*Dungeon/i]);
    const soloDungeon = countBySelectorOrAlt([/dungeon_solo/i, /dg_solo/i, /solo_dungeon/i]) || parseCountText([/Solo\s*Dungeon[s]?\s*[:×x*]?\s*(\d+)/i, /(\d+)\s*Solo\s*Dungeon/i]);

    const wood = countBySelectorOrAlt([/res_wood/i, /node_wood/i, /madeira/i]) || parseCountText([/Wood\s*[:×x*]?\s*(\d+)/i, /(\d+)\s*Wood/i]);
    const ore = countBySelectorOrAlt([/res_ore/i, /node_ore/i, /minerio/i]) || parseCountText([/Ore\s*[:×x*]?\s*(\d+)/i, /(\d+)\s*Ore/i]);
    const stone = countBySelectorOrAlt([/res_stone/i, /node_stone/i, /pedra/i]) || parseCountText([/Stone\s*[:×x*]?\s*(\d+)/i, /(\d+)\s*Stone/i]);
    const hide = countBySelectorOrAlt([/res_hide/i, /node_hide/i, /couro/i]) || parseCountText([/Hide\s*[:×x*]?\s*(\d+)/i, /(\d+)\s*Hide/i]);
    const fiber = countBySelectorOrAlt([/res_fiber/i, /node_fiber/i, /fibra/i]) || parseCountText([/Fiber\s*[:×x*]?\s*(\d+)/i, /(\d+)\s*Fiber/i]);

    const counts = {
        'Gold chest': goldChest,
        'Blue chest': blueChest,
        'Green chest': greenChest,
        'Group dungeon': groupDungeon,
        'Solo dungeon': soloDungeon,
        Wood: wood,
        Ore: ore,
        Stone: stone,
        Hide: hide,
        Fiber: fiber
    };

    const tier = bodyText.match(/\bT([468])\b/i);
    const imageRaw = $('a[href*="img_webp"], img[src*="img_webp"], meta[property="og:image"]').first().attr('href') || 
                     $('a[href*="img_webp"], img[src*="img_webp"], meta[property="og:image"]').first().attr('src') || 
                     $('meta[property="og:image"]').attr('content') || '';
    const mapImage = imageRaw ? new URL(imageRaw, url).href : '';

    return { 
        name, 
        tier: tier ? `T${tier[1]}` : 'T4', 
        layout: '', 
        connection: null, 
        counts, 
        mapImage, 
        sourceUrl: url, 
        source: 'Avalon Roads Tracker' 
    };
}