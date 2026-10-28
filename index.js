
// AUTO-BATTLE FIX V3 (STABLE CANVAS) + AVA + BANDIT AUTOMATION
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
    StringSelectMenuBuilder,
    PermissionsBitField
} = require('discord.js');

const cloudscraper = require('cloudscraper');
const axios = require('axios');
// Global safety net: every Axios request has a finite timeout unless a call sets a stricter one.
axios.defaults.timeout = 20000;
const cheerio = require('cheerio');
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { AsyncLocalStorage } = require('node:async_hooks');
const ctaModule = require('./cta');
let Fuse; try { Fuse = require('fuse.js'); } catch(e) { console.warn('fuse.js not installed, using fallback'); }

const BANDIT_SERIF_FONT = '/usr/share/fonts/truetype/noto/NotoSerifDisplay-Black.ttf';
const BANDIT_DISPLAY_FONT = '/usr/share/fonts/truetype/noto/NotoSansDisplay-CondensedExtraBold.ttf';
if (fs.existsSync(BANDIT_SERIF_FONT)) GlobalFonts.registerFromPath(BANDIT_SERIF_FONT, 'Bandit Serif');
if (fs.existsSync(BANDIT_DISPLAY_FONT)) GlobalFonts.registerFromPath(BANDIT_DISPLAY_FONT, 'Bandit Display');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.get('/', (_, res) => res.status(200).send('Albion Discord Bot is running.'));

const webServer = app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Web server listening on port ${PORT}`);
});
webServer.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
        console.warn(`⚠️ Port ${PORT} already in use - web server disabled, bot continues running`);
    } else {
        console.error('❌ Web server error:', err.message);
    }
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

const DATA_DIR = String(process.env.DATA_DIR || __dirname).trim();
const DATA_FILE = String(process.env.TRACKING_FILE || path.join(DATA_DIR, 'tracking.json')).trim();
// GitHub persistence must point to a PRIVATE repository; never store tracking data
// in this public bot source repository.
const GITHUB_DATA_TOKEN = String(process.env.GITHUB_DATA_TOKEN || '').trim();
const GITHUB_DATA_REPO = String(process.env.GITHUB_DATA_REPO || '').trim();
const GITHUB_DATA_BRANCH = String(process.env.GITHUB_DATA_BRANCH || 'main').trim();
const GITHUB_DATA_PATH = String(process.env.GITHUB_DATA_PATH || 'tracking.json').trim();
const GITHUB_DATA_API = 'https://api.github.com/repos/' + GITHUB_DATA_REPO + '/contents/' + GITHUB_DATA_PATH.split('/').map(encodeURIComponent).join('/');
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const SUPABASE_SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const SUPABASE_TABLE = String(process.env.SUPABASE_TABLE || 'bot_state').trim();
const SUPABASE_ROW_ID = String(process.env.SUPABASE_ROW_ID || 'albion-discord-bot').trim();
const SUPABASE_API = SUPABASE_URL ? `${SUPABASE_URL}/rest/v1/${encodeURIComponent(SUPABASE_TABLE)}` : '';
let supabasePersistenceReady = false;
let supabaseSaveQueue = Promise.resolve();
let githubSaveQueue = Promise.resolve();
let githubDataSha = null;
let githubPersistenceReady = false;
let guildConfigs = {};
let legacyMigration = null;
let autoBattleCheckRunning = false;
let banditSchedulerRunning = false;
let avaPollRunning = false;
const battleUrlRateLimit = new Map();
const avaUserRateLimit = new Map();
const AVA_MAX_CONCURRENT = 2;
const AVA_MAX_QUEUE = 12;
const AVA_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
let avaActiveJobs = 0;
const avaWaitingJobs = [];
const BATTLE_URL_COOLDOWN_MS = 12 * 1000;
const AVA_USER_COOLDOWN_MS = 8 * 1000;

function createDefaultGuildConfig() {
    return { players: [], guilds: [], autoBattles: [], banditAuto: [], avaAuto: [], avaProcessedMessages: [], avaMessageStates: {}, lastBanditAlertKey: {}, battleLinkChannelId: null, ctaTemplates: [], ctaEvents: [] };
}
function normalizeGuildConfig(raw = {}) {
    const cfg = raw && typeof raw === 'object' ? raw : {};
    return {
        ...createDefaultGuildConfig(), ...cfg,
        players: Array.isArray(cfg.players) ? cfg.players.map(String).filter(Boolean) : [],
        guilds: Array.isArray(cfg.guilds) ? cfg.guilds : [],
        autoBattles: Array.isArray(cfg.autoBattles) ? cfg.autoBattles : [],
        banditAuto: Array.isArray(cfg.banditAuto) ? cfg.banditAuto : [],
        avaAuto: Array.isArray(cfg.avaAuto) ? cfg.avaAuto : [],
        avaProcessedMessages: cfg.avaProcessedMessages instanceof Set ? [...cfg.avaProcessedMessages].map(String).slice(-500) : (Array.isArray(cfg.avaProcessedMessages) ? cfg.avaProcessedMessages.map(String).slice(-500) : []),
        avaMessageStates: cfg.avaMessageStates && typeof cfg.avaMessageStates === 'object' ? cfg.avaMessageStates : {},
        processedBattles: cfg.processedBattles instanceof Set ? [...cfg.processedBattles].map(String).slice(-1000) : (Array.isArray(cfg.processedBattles) ? cfg.processedBattles.map(String).slice(-1000) : []),
        lastBanditAlertKey: cfg.lastBanditAlertKey && typeof cfg.lastBanditAlertKey === 'object' ? cfg.lastBanditAlertKey : {},
        battleLinkChannelId: typeof cfg.battleLinkChannelId === 'string' ? cfg.battleLinkChannelId : null,
        ctaTemplates: Array.isArray(cfg.ctaTemplates) ? cfg.ctaTemplates : [],
        ctaEvents: Array.isArray(cfg.ctaEvents) ? cfg.ctaEvents : []
    };
}
function getGuildConfig(guildId, create = true) {
    const id = String(guildId || '').trim();
    if (!id) return create ? createDefaultGuildConfig() : null;
    if (!guildConfigs[id] && create) guildConfigs[id] = createDefaultGuildConfig();
    return guildConfigs[id] || null;
}
function getAllGuildConfigs() {
    return Object.entries(guildConfigs).map(([guildId, config]) => ({ guildId, config }));
}

const guildContext = new AsyncLocalStorage();
function currentGuildId() { return guildContext.getStore()?.guildId || null; }
function currentGuildConfig() { return getGuildConfig(currentGuildId(), false); }
function scopedArray(field) { return currentGuildConfig()?.[field] || []; }
function scopedObject(field) { return currentGuildConfig()?.[field] || {}; }
function scopedSet(field) {
    const cfg = currentGuildConfig();
    if (!cfg) return new Set();
    const proxy = new Proxy(new Set(Array.isArray(cfg[field]) ? cfg[field] : []), {
        get(target, prop) {
            if (prop === 'add') return value => { target.add(String(value)); cfg[field] = [...target]; return proxy; };
            if (prop === 'delete') return value => { const changed = target.delete(String(value)); cfg[field] = [...target]; return changed; };
            if (prop === 'clear') return () => { target.clear(); cfg[field] = []; };
            const value = Reflect.get(target, prop, target);
            return typeof value === 'function' ? value.bind(target) : value;
        }
    });
    return proxy;
}
const scopedNames = {
    targetPlayers: ['players','array'], targetGuilds: ['guilds','array'],
    autoBattleConfigs: ['autoBattles','array'],
    banditAutoConfigs: ['banditAuto','array'], avaAutoConfigs: ['avaAuto','array'],
    avaProcessedMessages: ['avaProcessedMessages','set'], processedBattles: ['processedBattles','set'],
    lastBanditAlertKey: ['lastBanditAlertKey','object']
};
for (const [name, [field, type]] of Object.entries(scopedNames)) {
    Object.defineProperty(globalThis, name, { configurable: true, get() { return type === 'set' ? scopedSet(field) : type === 'object' ? scopedObject(field) : scopedArray(field); }, set(value) { const cfg = currentGuildConfig(); if (!cfg) return; cfg[field] = type === 'set' ? [...(value || [])].map(String) : value; } });
}

async function migrateLegacyDataAfterReady() {
    if (!legacyMigration) return;
    const legacy = legacyMigration; legacyMigration = null;
    const inferred = new Map();
    for (const item of (Array.isArray(legacy.guilds) ? legacy.guilds : [])) {
        const entry = typeof item === 'string' ? { name: item, channelId: null } : item;
        let gid = null;
        if (entry?.channelId) { const ch = await client.channels.fetch(entry.channelId).catch(() => null); gid = ch?.guildId || null; }
        if (!gid && client.guilds.cache.size === 1) gid = client.guilds.cache.first().id;
        if (!gid) continue;
        const cfg = getGuildConfig(gid);
        if (entry.name && !cfg.guilds.some(x => String(x.name).toLowerCase() === String(entry.name).toLowerCase())) cfg.guilds.push({ name: entry.name, channelId: entry.channelId || null });
        inferred.set(gid, (inferred.get(gid) || 0) + 1);
    }
    for (const field of ['autoBattles','banditAuto','avaAuto']) for (const item of (Array.isArray(legacy[field]) ? legacy[field] : [])) {
        if (!item?.guildId) continue;
        const cfg = getGuildConfig(item.guildId);
        if (!cfg[field].some(x => JSON.stringify(x) === JSON.stringify(item))) cfg[field].push(item);
    }
    const known = [...new Set([...inferred.keys(), ...(legacy.autoBattles || []).map(x => x?.guildId).filter(Boolean)])];
    const target = inferred.size === 1 ? [...inferred.keys()][0] : (known.length === 1 ? known[0] : (client.guilds.cache.size === 1 ? client.guilds.cache.first().id : null));
    if (target) {
        const cfg = getGuildConfig(target);
        for (const p of (legacy.players || [])) if (!cfg.players.some(x => x.toLowerCase() === String(p).toLowerCase())) cfg.players.push(String(p));
        cfg.processedBattles = Array.isArray(legacy.processedBattles) ? legacy.processedBattles.slice(-1000) : cfg.processedBattles;
    }
    saveData();
    console.log('🔄 Legacy tracking.json migrated to per-Discord-server settings.');
}

function ensureDataDirectory() {
    try {
        const dir = path.dirname(DATA_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        return true;
    } catch (err) {
        console.error('❌ tracking data directory error:', err.message);
        return false;
    }
}

function loadData() {
    try {
        if (!ensureDataDirectory()) { guildConfigs = {}; legacyMigration = null; return; }
        if (!fs.existsSync(DATA_FILE)) {
            guildConfigs = {};
            console.warn(`⚠️ tracking.json not found at ${DATA_FILE}.`);
            // If GitHub persistence is configured, wait for remote download before
            // creating a new file, so an empty local file cannot overwrite saved data.
            if (!(GITHUB_DATA_TOKEN && GITHUB_DATA_REPO)) saveData();
            return;
        }
        const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        if (data && data.version >= 3 && data.guilds && !Array.isArray(data.guilds)) {
            guildConfigs = Object.fromEntries(Object.entries(data.guilds).map(([id, cfg]) => [id, normalizeGuildConfig(cfg)]));
            console.log('📁 Tracking v3: ' + Object.keys(guildConfigs).length + ' Discord server configuration(s) loaded.');
            return;
        }
        legacyMigration = data || {};
        guildConfigs = {};
        console.log('📁 Legacy tracking format detected. Migration will run after Discord is ready.');
    } catch (err) {
        console.error('❌ tracking.json load error:', err.message);
        guildConfigs = {}; legacyMigration = null;
    }
}
function saveData() {
    try {
        if (!ensureDataDirectory()) return false;
        guildConfigs = Object.fromEntries(Object.entries(guildConfigs).map(([id, cfg]) => [id, normalizeGuildConfig(cfg)]));
        const payload = JSON.stringify({
            version: 3, updatedAt: new Date().toISOString(),
            guilds: Object.fromEntries(Object.entries(guildConfigs).map(([id, cfg]) => [id, { ...cfg, processedBattles: Array.isArray(cfg.processedBattles) ? cfg.processedBattles.slice(-1000) : [], avaProcessedMessages: Array.isArray(cfg.avaProcessedMessages) ? cfg.avaProcessedMessages.slice(-500) : [] }]))
        }, null, 2);
        const tempFile = `${DATA_FILE}.tmp`;
        fs.writeFileSync(tempFile, payload, 'utf8');
        fs.renameSync(tempFile, DATA_FILE);
        if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY && supabasePersistenceReady) queueSupabaseTrackingSave(payload);
        if (GITHUB_DATA_TOKEN && GITHUB_DATA_REPO && githubPersistenceReady) queueGitHubTrackingSave(payload);
        return true;
    } catch (err) {
        try { if (fs.existsSync(`${DATA_FILE}.tmp`)) fs.unlinkSync(`${DATA_FILE}.tmp`); } catch (_) {}
        console.error('❌ tracking.json save error:', err.message);
        return false;
    }
}

loadData();

function githubRequestHeaders() {
    return {
        Authorization: 'Bearer ' + GITHUB_DATA_TOKEN,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'albion-discord-bot-persistence'
    };
}

async function pullGitHubTrackingData() {
    if (!GITHUB_DATA_TOKEN || !GITHUB_DATA_REPO) {
        console.warn('💾 GitHub persistence is not configured. Set GITHUB_DATA_TOKEN and GITHUB_DATA_REPO in Render Environment.');
        return false;
    }
    try {
        const response = await axios.get(GITHUB_DATA_API, {
            timeout: 20000,
            headers: githubRequestHeaders(),
            params: { ref: GITHUB_DATA_BRANCH },
            validateStatus: status => status === 200 || status === 404
        });
        if (response.status === 404) {
            console.warn('💾 GitHub tracking file not found in private data repo; preserving local data and creating remote copy.');
            githubPersistenceReady = true;
            if (fs.existsSync(DATA_FILE)) {
                const local = fs.readFileSync(DATA_FILE, 'utf8');
                queueGitHubTrackingSave(local);
            } else {
                // Do not overwrite an absent remote file with empty settings unless
                // the operator has confirmed that no previous backup exists.
                console.warn('⚠️ No local tracking.json or GitHub backup exists yet. Existing settings must be restored from a backup if available.');
            }
            return false;
        }
        const remote = response.data;
        if (!remote || remote.type !== 'file' || !remote.content) throw new Error('GitHub tracking path is not a readable file');
        const content = Buffer.from(String(remote.content).replace(/\n/g, ''), 'base64').toString('utf8');
        const parsed = JSON.parse(content);
        if (!parsed || typeof parsed !== 'object') throw new Error('GitHub tracking JSON is invalid');
        ensureDataDirectory();
        fs.writeFileSync(DATA_FILE, content, 'utf8');
        githubDataSha = remote.sha || null;
        loadData();
        githubPersistenceReady = true;
        console.log('💾 GitHub tracking data loaded from private repo ' + GITHUB_DATA_REPO + '/' + GITHUB_DATA_PATH);
        return true;
    } catch (err) {
        githubPersistenceReady = false;
        console.error('❌ GitHub tracking load failed; local tracking data was left untouched:', err.response?.status || '', err.message);
        return false;
    }
}

function queueGitHubTrackingSave(content) {
    if (!GITHUB_DATA_TOKEN || !GITHUB_DATA_REPO || !githubPersistenceReady) return;
    githubSaveQueue = githubSaveQueue.then(async () => {
        const encoded = Buffer.from(String(content), 'utf8').toString('base64');
        const get = await axios.get(GITHUB_DATA_API, {
            timeout: 20000, headers: githubRequestHeaders(),
            params: { ref: GITHUB_DATA_BRANCH },
            validateStatus: status => status === 200 || status === 404
        });
        const currentSha = get.status === 200 ? get.data.sha : undefined;
        const body = {
            message: 'Update Albion bot tracking backup',
            content: encoded,
            branch: GITHUB_DATA_BRANCH
        };
        if (currentSha) body.sha = currentSha;
        const put = await axios.put(GITHUB_DATA_API, body, {
            timeout: 20000, headers: githubRequestHeaders()
        });
        githubDataSha = put.data?.content?.sha || currentSha || null;
        console.log('💾 GitHub tracking backup saved successfully.');
    }).catch(err => {
        console.error('❌ GitHub tracking backup save failed:', err.response?.status || '', err.response?.data?.message || err.message);
    });
}

function supabaseHeaders() {
    return { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY, 'Content-Type': 'application/json', Accept: 'application/json', Prefer: 'return=representation' };
}
async function pullSupabaseTrackingData() {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return false;
    try {
        const response = await axios.get(SUPABASE_API, { timeout: 20000, headers: supabaseHeaders(), params: { id: 'eq.' + SUPABASE_ROW_ID, select: 'id,payload,updated_at' } });
        const row = Array.isArray(response.data) ? response.data[0] : null;
        if (row?.payload && typeof row.payload === 'object') {
            const content = JSON.stringify(row.payload, null, 2);
            JSON.parse(content);
            ensureDataDirectory();
            const tempFile = DATA_FILE + '.restore.tmp';
            fs.writeFileSync(tempFile, content, 'utf8');
            fs.renameSync(tempFile, DATA_FILE);
            loadData();
            supabasePersistenceReady = true;
            console.log('💾 Tracking data loaded from Supabase; ' + Object.keys(guildConfigs).length + ' Discord server(s).');
            return true;
        }
        if (fs.existsSync(DATA_FILE)) {
            const localText = fs.readFileSync(DATA_FILE, 'utf8');
            const localData = JSON.parse(localText);
            if (localData && typeof localData === 'object' && Object.keys(localData).length) {
                await axios.post(SUPABASE_API, { id: SUPABASE_ROW_ID, payload: localData, updated_at: new Date().toISOString() }, {
                    timeout: 20000, headers: { ...supabaseHeaders(), Prefer: 'resolution=merge-duplicates,return=representation' }, params: { on_conflict: 'id' }
                });
                supabasePersistenceReady = true;
                console.log('💾 Migrated existing local tracking data to Supabase without clearing it.');
                return true;
            }
        }
        console.warn('⚠️ Supabase row empty and no non-empty local tracking file exists; refusing to seed blank data.');
        return false;
    } catch (err) {
        supabasePersistenceReady = false;
        console.error('❌ Supabase tracking load failed; local data was not overwritten:', err.response?.status || '', err.response?.data?.message || err.message);
        return false;
    }
}
function queueSupabaseTrackingSave(content) {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !supabasePersistenceReady) return;
    let payload;
    try { payload = JSON.parse(String(content)); } catch (err) { console.error('❌ Refusing to persist invalid tracking JSON:', err.message); return; }
    supabaseSaveQueue = supabaseSaveQueue.then(async () => {
        await axios.post(SUPABASE_API, { id: SUPABASE_ROW_ID, payload, updated_at: new Date().toISOString() }, {
            timeout: 20000, headers: { ...supabaseHeaders(), Prefer: 'resolution=merge-duplicates,return=minimal' }, params: { on_conflict: 'id' }
        });
        console.log('💾 Supabase tracking backup saved successfully.');
    }).catch(err => console.error('❌ Supabase tracking save failed:', err.response?.status || '', err.response?.data?.message || err.message));
}
async function initializeTrackingPersistence() {
    if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
        if (await pullSupabaseTrackingData()) {
            // Supabase remains the source of truth. Enable GitHub as a mirror
            // without pulling its potentially stale copy over the restored data.
            if (GITHUB_DATA_TOKEN && GITHUB_DATA_REPO) {
                githubPersistenceReady = true;
                console.log('💾 GitHub tracking backup enabled as a mirror for Supabase data.');
                saveData();
            } else {
                console.warn('💾 GitHub tracking mirror is not configured. Set GITHUB_DATA_TOKEN and GITHUB_DATA_REPO in Render Environment.');
            }
            return;
        }
        console.warn('⚠️ Supabase configured but not ready; external writes remain disabled to protect existing data.');
        if (GITHUB_DATA_TOKEN && GITHUB_DATA_REPO) await pullGitHubTrackingData();
        return;
    }
    if (GITHUB_DATA_TOKEN && GITHUB_DATA_REPO) { await pullGitHubTrackingData(); return; }
    console.warn('⚠️ No external tracking database configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, or GitHub backup variables.');
}

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
        `https://api.albionbb.com/asia/battles/kills?ids%5B%5D=${encodeURIComponent(matchId)}`,
        `https://east.albionbb.com/api/battles/kills?ids=${encodeURIComponent(matchId)}`
    ];

    const browserHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://east.albionbb.com/',
        'Origin': 'https://east.albionbb.com',
        'Sec-Fetch-Site': 'same-site',
        'Sec-Fetch-Mode': 'cors'
    };

    for (const url of urls) {
        // 1) ลอง cloudscraper ก่อน - บายพาส Cloudflare
        try {
            const raw = await cloudscraper.get({
                uri: url,
                timeout: 18000,
                headers: browserHeaders,
                json: true
            });
            const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
            const events = Array.isArray(data) ? data :
                Array.isArray(data?.events) ? data.events :
                Array.isArray(data?.kills) ? data.kills : [];
            if (events.length) {
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
                if (map.size) {
                    console.log(`✅ AlbionBB weapon fallback HIT via cloudscraper: ${url}`);
                    return map;
                }
            }
        } catch (err) {
            const status = err?.statusCode || err?.response?.status;
            if (status === 403 || status === 401 || status === 503) {
                console.warn(`⚠️ AlbionBB weapon cloudscraper blocked (HTTP ${status}) for ${url}, trying axios...`);
            }
        }

        // 2) Axios fallback
        try {
            const response = await axios.get(url, {
                timeout: 15000,
                headers: browserHeaders,
                validateStatus: s => s >= 200 && s < 400
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
            const status = err?.response?.status || err?.statusCode;
            if (status === 403 || status === 401) {
                console.warn(`⚠️ AlbionBB weapon fallback blocked (HTTP ${status}); skipping remaining AlbionBB URL variants.`);
                await new Promise(r => setTimeout(r, 1500 + Math.random()*1000));
                continue;
            }
            console.warn('⚠️ AlbionBB weapon fallback failed:', err.message);
        }
    }
    return new Map();
}

async function fetchOfficialBattleWeaponMap(matchId, options = {}) {
    const autoBattle = options?.autoBattle === true;
    const allBaseUrls = getApiUrls(matchId).map(url => url.replace(/\/battles\//i, '/events/battle/'));
    const baseUrls = autoBattle ? allBaseUrls.reverse().slice(0, 1) : allBaseUrls;
    const map = new Map();
    const maxPages = autoBattle ? 2 : 12;

    for (const baseUrl of baseUrls) {
        try {
            for (let page = 0; page < maxPages; page++) {
                const offset = page * 51;
                const url = `${baseUrl}?limit=51&offset=${offset}`;
                const response = await axios.get(url, {
                    timeout: autoBattle ? 3500 : 20000,
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

async function fetchAlbionBBBattleFallback(matchId) {
    // AlbionBB can publish a battle before the official GameInfo API indexes it.
    // Try its public battle-summary + kill-event endpoints; never treat a 403/empty
    // response as a valid report and never mark the battle processed on fallback failure.
    const base = 'https://api.albionbb.com/asia/battles';
    let summary = null;
    try {
        const response = await axios.get(base, {
            params: { search: String(matchId), minPlayers: 1, page: 1 },
            timeout: 20000,
            headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }
        });
        const rows = Array.isArray(response.data) ? response.data :
            (Array.isArray(response.data?.battles) ? response.data.battles : []);
        summary = rows.find(row => String(row.albionId ?? row.id ?? row.battleId ?? '') === String(matchId)) || null;
    } catch (err) {
        console.warn(`⚠️ AlbionBB battle-summary fallback failed for ${matchId}: ${err.response?.status || err.message}`);
    }
    try {
        const response = await axios.get(`https://api.albionbb.com/asia/battles/kills?ids=${encodeURIComponent(matchId)}`, {
            timeout: 20000,
            headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }
        });
        const events = Array.isArray(response.data) ? response.data :
            (Array.isArray(response.data?.events) ? response.data.events : []);
        if (!events.length) {
            console.warn(`⚠️ AlbionBB returned no kill events for ${matchId}; cannot build a safe fallback report.`);
            return null;
        }
        const players = new Map();
        const guilds = new Map();
        const touch = (entity) => {
            if (!entity || typeof entity !== 'object') return null;
            const name = String(entity.Name ?? entity.name ?? '').trim();
            if (!name) return null;
            const guildName = String(entity.GuildName ?? entity.guildName ?? entity.Guild?.Name ?? entity.guild?.name ?? '').trim();
            const key = name.toLowerCase();
            if (!players.has(key)) players.set(key, {
                name, guildName, kills: 0, deaths: 0, killFame: 0,
                MainHand: entity.MainHand ?? entity.mainHand ?? entity.Equipment?.MainHand ?? entity.equipment?.MainHand ?? null
            });
            const p = players.get(key);
            if (!p.guildName && guildName) p.guildName = guildName;
            if (guildName && !guilds.has(guildName.toLowerCase())) guilds.set(guildName.toLowerCase(), { name: guildName, kills: 0, deaths: 0, killFame: 0 });
            return { p, g: guildName ? guilds.get(guildName.toLowerCase()) : null };
        };
        for (const event of events) {
            const killer = event.Killer ?? event.killer;
            const victim = event.Victim ?? event.victim;
            const k = touch(killer), v = touch(victim);
            const fame = Number(event.TotalVictimKillFame ?? event.totalVictimKillFame ?? event.KillFame ?? event.killFame ?? victim?.KillFame ?? victim?.killFame ?? 0) || 0;
            if (k) { k.p.kills++; if (k.g) k.g.kills++; }
            if (v) { v.p.deaths++; if (v.g) v.g.deaths++; }
            if (k) { k.p.killFame += fame; if (k.g) k.g.killFame += fame; }
        }
        const guildObj = Object.fromEntries([...guilds.values()].map((g, i) => [String(i), g]));
        const playerObj = Object.fromEntries([...players.values()].map((p, i) => [String(i), p]));
        return {
            id: String(matchId),
            startTime: summary?.startedAt ?? summary?.startTime ?? events[0]?.TimeStamp ?? events[0]?.timestamp ?? null,
            players: playerObj,
            guilds: guildObj,
            alliances: {},
            totalKills: summary?.totalKills ?? events.length,
            totalFame: summary?.totalFame ?? [...players.values()].reduce((sum, p) => sum + p.killFame, 0)
        };
    } catch (err) {
        console.warn(`⚠️ AlbionBB kill-event fallback failed for ${matchId}: ${err.response?.status || err.message}`);
        return null;
    }
}

// Share battle lookups between tracked guilds so the same Match ID does not
// trigger duplicate API bursts during a single polling cycle.
const battleFetchInFlight = new Map();
const battleFetchFailureUntil = new Map();
// GameInfo rate limits are shared across battle IDs, so back off globally.
let officialApiRateLimitedUntil = 0;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function retryAfterMs(err) {
    const raw = err?.response?.headers?.['retry-after'] ?? err?.response?.headers?.['Retry-After'];
    if (raw == null) return 0;
    const seconds = Number(raw);
    if (Number.isFinite(seconds)) return Math.max(0, Math.min(15000, seconds * 1000));
    const dateMs = Date.parse(String(raw));
    return Number.isFinite(dateMs) ? Math.max(0, Math.min(15000, dateMs - Date.now())) : 0;
}

function findBattleObjectInJson(value, matchId, depth = 0, visited = { count: 0 }) {
    if (!value || typeof value !== 'object' || depth > 9 || visited.count++ > 12000) return null;
    if (Array.isArray(value)) {
        for (const item of value) {
            const found = findBattleObjectInJson(item, matchId, depth + 1, visited);
            if (found) return found;
        }
        return null;
    }
    const id = String(value.id ?? value.Id ?? value.albionId ?? value.battleId ?? value.BattleId ?? '');
    const players = value.players ?? value.Players ?? value.participants ?? value.Participants;
    const guilds = value.guilds ?? value.Guilds;
    const isCollection = x => Array.isArray(x) || (x && typeof x === 'object');
    if (isCollection(players) && isCollection(guilds) && (!id || id === String(matchId))) {
        const playerValues = Array.isArray(players) ? players : Object.values(players);
        const guildValues = Array.isArray(guilds) ? guilds : Object.values(guilds);
        if (playerValues.length && guildValues.length) {
            return {
                ...value,
                id: String(matchId),
                players: Array.isArray(players) ? Object.fromEntries(players.map((p, i) => [String(i), p])) : players,
                guilds: Array.isArray(guilds) ? Object.fromEntries(guilds.map((g, i) => [String(i), g])) : guilds
            };
        }
    }
    for (const child of Object.values(value)) {
        const found = findBattleObjectInJson(child, matchId, depth + 1, visited);
        if (found) return found;
    }
    return null;
}

async function fetchAlbionBBPageFallback(matchId) {
    const url = `https://east.albionbb.com/battles/${encodeURIComponent(matchId)}`;
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        Referer: 'https://east.albionbb.com/'
    };
    let html = '';
    try {
        html = String(await cloudscraper.get({ uri: url, timeout: 18000, headers }));
    } catch (err) {
        try {
            const response = await axios.get(url, { timeout: 18000, headers, validateStatus: status => status >= 200 && status < 400 });
            html = String(response.data || '');
        } catch (fallbackErr) {
            console.warn(`⚠️ AlbionBB battle page fallback failed for ${matchId}: ${fallbackErr.response?.status || fallbackErr.message || err.message}`);
            return null;
        }
    }
    if (!html || html.length < 100) return null;
    const $ = cheerio.load(html);
    const candidates = [];
    $('script[type="application/json"], script[type="application/ld+json"], script#__NEXT_DATA__, script').each((_, node) => {
        const raw = $(node).html();
        if (!raw || raw.length < 2 || raw.length > 5000000) return;
        const trimmed = raw.trim();
        if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return;
        try { candidates.push(JSON.parse(trimmed)); } catch (_) {}
    });
    for (const candidate of candidates) {
        const battle = findBattleObjectInJson(candidate, matchId);
        if (battle) {
            console.log(`✅ Using structured data from AlbionBB battle page for Match ID ${matchId}.`);
            return battle;
        }
    }
    console.warn(`⚠️ AlbionBB battle page loaded for ${matchId}, but no structured participant/guild data was exposed.`);
    return null;
}

async function fetchOfficialBattleUncached(matchId, options = {}) {
    const autoBattle = options?.autoBattle === true;
    // A 429 is generally shared across regional endpoints. Pause official requests
    // globally rather than retrying every region for every candidate battle.
    const urls = getApiUrls(matchId).reverse();
    let sawRateLimit = false;
    if (officialApiRateLimitedUntil > Date.now()) {
        console.log('⏭️ Official battle API cooldown active for ' + Math.ceil((officialApiRateLimitedUntil - Date.now()) / 1000) + 's' + (autoBattle ? '; Auto-Battle จะลองใหม่ในรอบถัดไปสำหรับ ' : '; trying public fallbacks for ') + matchId + '.');
    } else {
        const maxAttempts = autoBattle ? 1 : 2;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const requestUrls = urls; // Auto-Battle can try both Official endpoints, but no third-party details.
            for (let endpointIndex = 0; endpointIndex < requestUrls.length; endpointIndex++) {
                const url = requestUrls[endpointIndex];
                try {
                    const response = await axios.get(url, {
                        timeout: autoBattle ? 7000 : 20000,
                        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }
                    });
                    if (response.data && typeof response.data === 'object' &&
                        (response.data.id || response.data.players || response.data.guilds)) return response.data;
                    console.warn('⚠️ Official battle API returned an unexpected payload for ' + matchId + ' from ' + (url.includes('gameinfo-sgp') ? 'Asia' : 'global') + '.');
                } catch (err) {
                    const status = err.response?.status;
                    if (status === 429) {
                        sawRateLimit = true;
                        const waitMs = Math.max(retryAfterMs(err), 60000);
                        officialApiRateLimitedUntil = Math.max(officialApiRateLimitedUntil, Date.now() + waitMs);
                        console.warn('⏳ Official battle API rate-limited ' + matchId + ' (' + (url.includes('gameinfo-sgp') ? 'Asia' : 'global') + '); pausing official requests for ' + Math.ceil(waitMs / 1000) + 's' + (autoBattle ? '; Auto-Battle จะลองใหม่หลัง cooldown.' : ' and switching to fallbacks.'));
                        break;
                    } else {
                        console.warn('⚠️ Official battle API endpoint ' + (endpointIndex + 1) + '/' + requestUrls.length +
                            ' failed for ' + matchId + ' (' + (url.includes('gameinfo-sgp') ? 'Asia' : 'global') + '): ' + (status || err.message) + '.');
                    }
                }
            }
            if (sawRateLimit) break;
            if (!autoBattle && attempt < maxAttempts) await sleep(1800);
        }
    }

    if (autoBattle) {
        console.warn('⚠️ [Auto-Battle] Official GameInfo ยังไม่มีรายละเอียด Match ID=' + matchId + ' หรือ API ตอบไม่สำเร็จ; จะลองใหม่รอบถัดไป โดยไม่เรียก AlbionBB fallback.');
        return null;
    }

    // AlbionBB's public HTML page can expose the same structured battle payload
    // even when its JSON API returns 403 and the Official API is rate-limited.
    const pageFallback = await fetchAlbionBBPageFallback(matchId);
    if (pageFallback) return pageFallback;

    const fallback = await fetchAlbionBBBattleFallback(matchId);
    if (fallback) {
        console.log(`✅ Using AlbionBB battle fallback for Match ID ${matchId} (${Object.keys(fallback.players || {}).length} players).`);
        return fallback;
    }
    console.warn(`❌ Battle data unavailable for ${matchId} (not proof that the Match ID is missing); Auto-Battle will retry on the next poll.`);
    return null;
}

async function fetchOfficialBattle(matchId, options = {}) {
    const key = String(matchId);
    const autoBattle = options?.autoBattle === true;
    const cacheKey = (autoBattle ? 'autoBattle:' : 'shared:') + key;
    if (autoBattle) {
        const detailCache = fetchOfficialBattle._autoBattleDetailCache || (fetchOfficialBattle._autoBattleDetailCache = new Map());
        const cached = detailCache.get(key);
        if (cached && cached.expiresAt > Date.now()) return cached.data;
        if (cached) detailCache.delete(key);
    }
    if (battleFetchInFlight.has(cacheKey)) return battleFetchInFlight.get(cacheKey);
    const blockedUntil = battleFetchFailureUntil.get(cacheKey) || 0;
    if (blockedUntil > Date.now()) { console.log('⏭️ Reusing recent failed lookup for Match ID ' + key + '; will retry after cooldown.'); return null; }
    const task = fetchOfficialBattleUncached(key, options)
        .then(data => {
            if (data) {
                battleFetchFailureUntil.delete(cacheKey);
                if (autoBattle) {
                    const guildRows = data.guilds ? (Array.isArray(data.guilds) ? data.guilds : Object.values(data.guilds)) : [];
                    if (guildRows.some(guild => Boolean(guild?.name || guild?.Name))) {
                        const detailCache = fetchOfficialBattle._autoBattleDetailCache || (fetchOfficialBattle._autoBattleDetailCache = new Map());
                        detailCache.set(key, { data, expiresAt: Date.now() + 3 * 60 * 1000 });
                        while (detailCache.size > 500) detailCache.delete(detailCache.keys().next().value);
                    }
                }
            } else battleFetchFailureUntil.set(cacheKey, Date.now() + 45000);
            return data;
        })
        .catch(err => { battleFetchFailureUntil.set(cacheKey, Date.now() + 45000); console.warn('❌ Battle lookup crashed for ' + key + ': ' + err.message); return null; })
        .finally(() => battleFetchInFlight.delete(cacheKey));
    battleFetchInFlight.set(cacheKey, task);
    return task;
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

function drawRoundRect(ctx, x, y, w, h, r) {
    const radius = Math.max(0, Math.min(Number(r) || 0, Math.min(w, h) / 2));
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
}

const weaponIconCache = new Map();

async function loadAlbionWeaponIcon(weapon, quality = 1) {
    const id = normalizeAlbionItemId(weapon);
    if (!id) return null;

    const baseId = id.replace(/@\d+$/, '');
    const q = Math.max(1, Math.min(5, Number(quality) || 1));
    const cacheKey = `${baseId}|Q${q}`;

    if (weaponIconCache.has(cacheKey)) return weaponIconCache.get(cacheKey);

    const encoded = encodeURIComponent(id);
    const encodedBase = encodeURIComponent(baseId);
    const urls = [
        `https://render.albiononline.com/v1/item/${encoded}.png?quality=${q}&size=128`,
        `https://render.albiononline.com/v1/item/${encodedBase}.png?quality=${q}&size=128`,
        `https://render.albiononline.com/v1/item/${encoded}.png?quality=${q}`,
        `https://render.albiononline.com/v1/item/${encodedBase}.png?quality=${q}`,
        `https://render.albiononline.com/v1/item/${encoded}.png`,
        `https://render.albiononline.com/v1/item/${encodedBase}.png`
    ];

    for (const url of urls) {
        // Download bytes ourselves first. This is more reliable on Render and
        // accepts PNG/WebP image responses instead of requiring a PNG signature.
        try {
            const response = await axios.get(url, {
                responseType: 'arraybuffer',
                timeout: 6000,
                headers: {
                    'User-Agent': 'Mozilla/5.0',
                    'Accept': 'image/png,image/webp,image/*,*/*;q=0.8',
                    'Referer': 'https://albiononline.com/'
                },
                validateStatus: status => status >= 200 && status < 300
            });
            const buffer = Buffer.from(response.data);
            if (buffer.length > 100) {
                try {
                    const img = await loadImage(buffer);
                    if (img && img.width > 0 && img.height > 0) {
                        weaponIconCache.set(cacheKey, img);
                        return img;
                    }
                } catch (_) {}
            }
        } catch (_) {}

        // Direct canvas fetch is the final fallback.
        try {
            const img = await Promise.race([
                loadImage(url),
                new Promise((_, reject) => setTimeout(() => reject(new Error('weapon icon timeout')), 4000))
            ]);
            if (img && img.width > 0 && img.height > 0) {
                weaponIconCache.set(cacheKey, img);
                return img;
            }
        } catch (_) {}
    }

    console.warn(`⚠️ Weapon icon not loaded: ${id} (Q${q})`);
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

async function generateGuildSummaryImage(guildsData, options = {}) {
    if (!guildsData || !guildsData.length) return null;

    // Preserve the existing four-guild default. BattleLink can opt into a
    // complete merged table without changing Auto-Battle or single-fight output.
    const topGuilds = options.includeAll ? [...guildsData] : [...guildsData].slice(0, 4);

    const includeAlliance = options.includeAlliance === true;
    const width = includeAlliance ? 1000 : 760;
    const rowHeight = 56;
    const headerHeight = 64;
    const padding = 20;
    const height = padding * 2 + headerHeight + (topGuilds.length * rowHeight);

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#18191c';
    drawRoundRect(ctx, 0, 0, width, height, 16);
    ctx.fill();

    ctx.font = 'bold 16px sans-serif';
    if (includeAlliance) {
        // Use one fixed column grid for both header labels and row values.
        // Each label is centered on the exact same column center.
        const columns = [
            { key:'alliance', x:30,  w:150, title:'ALLIANCE', color:'#ffffff' },
            { key:'name',     x:180, w:230, title:'NAME',     color:'#ffffff' },
            { key:'players',  x:410, w:110, title:'PLAYERS',  color:'#ffffff' },
            { key:'kills',    x:520, w:110, title:'KILLS',    color:'#ffffff' },
            { key:'deaths',   x:630, w:120, title:'DEATHS',   color:'#ffffff' },
            { key:'fame',     x:750, w:220, title:'FAME',     color:'#ffffff' }
        ];
        for (const col of columns) {
            ctx.fillStyle = col.color;
            ctx.textAlign = 'center';
            ctx.fillText(col.title, col.x + col.w / 2, padding + 38);
        }
        ctx.textAlign = 'left';
        ctx.strokeStyle='#596273'; ctx.lineWidth=1; ctx.setLineDash([]); ctx.beginPath(); ctx.moveTo(30,padding+49); ctx.lineTo(970,padding+49); ctx.stroke();
    } else {
        ctx.fillText('NAME', padding + 10, padding + 38);
        ctx.fillText('PLAYERS', 340, padding + 38);
        ctx.fillText('KILLS', 460, padding + 38);
        ctx.fillText('DEATHS', 560, padding + 38);
        ctx.fillText('FAME', 660, padding + 38);
    }

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
        const gName = String(g.name || 'Unknown');
        if (includeAlliance) {
            const allianceName = String(g.alliance || '-').trim();
            const cells=[
                {text:allianceName.length>16?allianceName.slice(0,14)+'..':allianceName,x:30,w:150,color:'#c084fc',font:'bold 16px sans-serif'},
                {text:gName.length>24?gName.slice(0,22)+'..':gName,x:180,w:230,color:'#ffffff',font:'bold 20px sans-serif'},
                {text:String(g.playersCount||0),x:410,w:110,color:'#3399ff',font:'bold 20px sans-serif'},
                {text:String(g.kills||0),x:520,w:110,color:'#ff5555',font:'bold 20px sans-serif'},
                {text:String(g.deaths||0),x:630,w:120,color:'#ff66cc',font:'bold 20px sans-serif'},
                {text:formatFame(g.killFame||0),x:750,w:220,color:'#ffcc00',font:'bold 20px sans-serif'}
            ];
            for (const c of cells) {
                ctx.fillStyle=c.color;
                ctx.font=c.font;
                ctx.textAlign='center';
                ctx.fillText(c.text,c.x+c.w/2,y+36);
            }
            ctx.textAlign='left';
        } else {
            const legacyName = gName.length > 20 ? gName.slice(0, 18) + '..' : gName;
            ctx.fillText(legacyName, padding + 10, y + 36);
            ctx.fillStyle = '#3399ff';
            ctx.fillText(String(g.playersCount || 0), 340, y + 36);
            ctx.fillStyle = '#ff5555';
            ctx.fillText(String(g.kills || 0), 460, y + 36);
            ctx.fillStyle = '#ff66cc';
            ctx.fillText(String(g.deaths || 0), 560, y + 36);
            ctx.fillStyle = '#ffcc00';
            ctx.fillText(formatFame(g.killFame || 0), 660, y + 36);
        }
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

    const playersPerRow = 5;
    const cardWidth = 300;
    const cardHeight = 282;
    const gapX = 16, gapY = 16, padding = 30;
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
    ctx.fillText('BATTLE REPORT' + (battleInfo.totalPages > 1 ? '  |  PAGE ' + (battleInfo.page || 1) + '/' + battleInfo.totalPages : ''), padding, padding + 37);
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

        const wy = y + 84;
        ctx.save();
        ctx.shadowColor = qm.color; ctx.shadowBlur = isMVP ? 18 : 10;
        ctx.fillStyle = '#030811';
        ctx.beginPath(); ctx.arc(cx, wy, 65, 0, Math.PI * 2); ctx.fill();
        ctx.shadowBlur = 0;
        ctx.strokeStyle = qm.color; ctx.lineWidth = isMVP ? 2.4 : 1.8;
        ctx.beginPath(); ctx.arc(cx, wy, 65, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = 'rgba(255,255,255,.13)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(cx, wy, 54, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();

        ctx.save();
        ctx.strokeStyle = qm.color; ctx.lineWidth = 2; ctx.globalAlpha = .65;
        [[0,-69,0,-78],[0,69,0,78],[-69,0,-78,0],[69,0,78,0]].forEach(a => {
            ctx.beginPath(); ctx.moveTo(cx + a[0], wy + a[1]); ctx.lineTo(cx + a[2], wy + a[3]); ctx.stroke();
        });
        ctx.restore();

        if (iconImages[i]) {
            try { ctx.drawImage(iconImages[i], cx - 54, wy - 54, 108, 108); } catch (_) {}
        } else {
            drawSwordIcon(cx, wy, 1.7, qm.color);
        }

        const qText = `Q${q}  ${qm.label}`;
        ctx.font = '900 12px Arial, sans-serif';
        const qw = ctx.measureText(qText).width + 24;
        rounded(cx - qw / 2, y + 151, qw, 24, 10, '#050b14', qm.color, 1);
        centerText(qText, cx, y + 168, 12, qm.color, '900');

        let name = String(p.displayName || p.name || 'Unknown').trim();
        if (name.length > 22) name = `${name.slice(0, 20)}..`;
        const nameSize = textFit(name, cardWidth - 28, 22, '900');
        ctx.save();
        ctx.textAlign = 'center';
        ctx.font = `900 ${nameSize}px Arial, sans-serif`;
        ctx.lineWidth = 3;
        ctx.strokeStyle = '#02060c';
        ctx.strokeText(name, cx, y + 202);
        ctx.fillStyle = isMVP ? '#fef3c7' : '#f8fafc';
        ctx.shadowColor = isMVP ? 'rgba(245,158,11,.25)' : 'rgba(255,255,255,.10)';
        ctx.shadowBlur = 5;
        ctx.fillText(name, cx, y + 202);
        ctx.restore();

        const guild = String(p.guild || '').trim();
        if (guild) {
            let g = guild.length > 21 ? `${guild.slice(0, 19)}..` : guild;
        }

        const metricY = y + 224;
        centerText('K ' + String(k), cx - 42, metricY, 17, k > 0 ? '#ef4444' : '#64748b', '900');
        centerText('/', cx, metricY, 16, '#475569', '900');
        centerText('D ' + String(d), cx + 42, metricY, 17, d > 0 ? '#f87171' : '#64748b', '900');

        const fameText = formatFame(p.fame || 0);
        const famePillW = 170;
        const famePillH = 30;
        const fameX = cx - famePillW / 2;
        const fameY = y + cardHeight - 39;
        rounded(fameX, fameY, famePillW, famePillH, 10, '#0b1422', isMVP ? '#8b6518' : '#263a55', 1);
        if (fameImg) {
            try { ctx.drawImage(fameImg, fameX + 12, fameY + 7, 17, 17); } catch (_) {}
        } else {
            drawGemIcon(fameX + 21, fameY + 15, .42, '#fbbf24');
        }
        centerText(fameText, fameX + 101, fameY + 21, 16, '#fbbf24', '900');
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

async function generateBattleReportFallbackImage(players, battleInfo = {}) {
    try {
        if (!Array.isArray(players) || !players.length) return null;

        const width = 1600;
        const playersPerRow = 7;
        const cardWidth = 210;
        const cardHeight = 214;
        const gapX = 14;
        const gapY = 14;
        const padding = 30;
        const headerHeight = 96;
        const statsHeight = 92;
        const gridOffsetY = padding + headerHeight + statsHeight + 20;
        const rows = Math.ceil(players.length / playersPerRow);
        const footerHeight = 58;
        const height = gridOffsetY + rows * cardHeight + Math.max(0, rows - 1) * gapY + footerHeight + padding;

        const canvas = createCanvas(width, height);
        const ctx = canvas.getContext('2d');

        ctx.fillStyle = '#02050a';
        ctx.fillRect(0, 0, width, height);

        const bg = ctx.createLinearGradient(0, 0, 0, height);
        bg.addColorStop(0, '#17243b');
        bg.addColorStop(0.45, '#0a1322');
        bg.addColorStop(1, '#010409');
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, width, height);

        ctx.fillStyle = '#dc2626';
        ctx.fillRect(0, 0, width, 4);

        ctx.fillStyle = '#f8fafc';
        ctx.font = '900 38px Arial, sans-serif';
        ctx.fillText('BATTLE REPORT', padding, padding + 37);

        ctx.fillStyle = '#94a3b8';
        ctx.font = 'bold 12px Arial, sans-serif';
        ctx.fillText(
            `EAST SERVER   |   ${formatUTCTime(battleInfo.battleTime || Date.now())}   |   MATCH ID: ${battleInfo.matchId || 'N/A'}`,
            padding,
            padding + 60
        );

        let totalKills = 0;
        let totalDeaths = 0;
        let totalFame = 0;
        for (const p of players) {
            totalKills += Number(p.kills) || 0;
            totalDeaths += Number(p.deaths) || 0;
            totalFame += Number(p.fame) || 0;
        }

        const statY = padding + headerHeight;
        const statGap = 12;
        const statW = (width - padding * 2 - statGap * 4) / 5;
        const stats = [
            ['TOTAL KILLS', String(totalKills), '#ef4444'],
            ['TOTAL DEATHS', String(totalDeaths), '#f87171'],
            ['TOTAL FAME', formatFame(totalFame), '#fbbf24'],
            ['PLAYERS', String(players.length), '#60a5fa'],
            ['SERVER', 'EAST', '#d946ef']
        ];

        stats.forEach((st, i) => {
            const x = padding + i * (statW + statGap);
            roundedFallback(ctx, x, statY, statW, 82, 13, '#08111f', '#1e3049');
            ctx.fillStyle = st[2];
            ctx.fillRect(x, statY, 4, 82);
            ctx.fillStyle = '#64748b';
            ctx.font = '900 9px Arial, sans-serif';
            ctx.fillText(st[0], x + 18, statY + 24);
            ctx.fillStyle = '#f8fafc';
            ctx.font = '900 22px Arial, sans-serif';
            ctx.fillText(st[1], x + 18, statY + 54);
        });

        players.forEach((p, i) => {
            const col = i % playersPerRow;
            const row = Math.floor(i / playersPerRow);
            const x = padding + col * (cardWidth + gapX);
            const y = gridOffsetY + row * (cardHeight + gapY);
            const isTop = i === 0;
            roundedFallback(ctx, x, y, cardWidth, cardHeight, 15, isTop ? '#111a2b' : '#07101c', isTop ? '#f59e0b' : '#22344d');

            ctx.fillStyle = isTop ? '#f59e0b' : '#142238';
            ctx.fillRect(x + 10, y + 10, 38, 23);

            ctx.fillStyle = isTop ? '#111827' : '#cbd5e1';
            ctx.font = '900 11px Arial, sans-serif';
            ctx.fillText(String(i + 1).padStart(2, '0'), x + 21, y + 26);

            const cx = x + cardWidth / 2;
            const cy = y + 63;
            ctx.fillStyle = '#030811';
            ctx.beginPath();
            ctx.arc(cx, cy, 45, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = isTop ? '#f59e0b' : '#60a5fa';
            ctx.lineWidth = 2;
            ctx.stroke();

            ctx.fillStyle = '#94a3b8';
            ctx.font = '900 22px Arial, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('⚔', cx, cy + 8);
            ctx.textAlign = 'left';

            let name = String(p.displayName || p.name || 'Unknown').trim();
            if (name.length > 22) name = name.slice(0, 20) + '..';
            ctx.fillStyle = '#f8fafc';
            ctx.font = '900 15px Arial, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(name, cx, y + 202);

            const guild = String(p.guild || '').trim();
            if (guild) {
                ctx.fillStyle = '#64748b';
                ctx.font = 'bold 8px Arial, sans-serif';
                ctx.fillText(guild.length > 21 ? guild.slice(0, 19) + '..' : guild, cx, y + 158);
            }

            ctx.fillStyle = '#ef4444';
            ctx.font = '900 12px Arial, sans-serif';
            ctx.fillText(String(Number(p.kills) || 0), cx - 28, y + 181);
            ctx.fillStyle = '#475569';
            ctx.fillText('/', cx, y + 181);
            ctx.fillStyle = '#f87171';
            ctx.fillText(String(Number(p.deaths) || 0), cx + 22, y + 181);

            ctx.fillStyle = '#fbbf24';
            ctx.font = '900 11px Arial, sans-serif';
            ctx.fillText(formatFame(p.fame || 0), cx, y + 202);
            ctx.textAlign = 'left';
        });

        ctx.fillStyle = '#64748b';
        ctx.font = '900 9px Arial, sans-serif';
        ctx.fillText('VICTORY BELONGS TO THOSE WHO FIGHT TOGETHER', padding, height - 20);
        ctx.fillStyle = '#ef4444';
        ctx.textAlign = 'right';
        ctx.fillText('POWERED BY  •  BOTBOSS', width - padding, height - 20);
        ctx.textAlign = 'left';

        return new AttachmentBuilder(canvas.toBuffer('image/png'), { name: 'battle-report.png' });
    } catch (err) {
        console.error('❌ Battle report fallback image error:', err.stack || err.message);
        return null;
    }
}

function roundedFallback(ctx, x, y, w, h, r, fill, stroke) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    if (stroke) {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 1.2;
        ctx.stroke();
    }
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
    let guildSummaryData = [];
    const apiData = options.apiData || (/^\d+$/.test(matchId) ? await fetchOfficialBattle(matchId) : null);
    if (!apiData) throw new Error('ไม่พบข้อมูลไฟต์จาก Official Albion API');

    const battleTime = apiData.startTime || apiData.timestamp || null;

    const knownGuildNames = new Set([
        ...(apiData?.guilds ? Object.values(apiData.guilds).map(g => g.name?.trim().toLowerCase()).filter(Boolean) : []),
        ...(apiData?.alliances ? Object.values(apiData.alliances).map(a => a.name?.trim().toLowerCase()).filter(Boolean) : [])
    ]);

    let rawPlayers = getApiPlayers(apiData);

    try {
        const officialWeaponMap = await fetchOfficialBattleWeaponMap(matchId, { autoBattle: options.autoBattle === true });
        rawPlayers = rawPlayers.map(p => {
            if (p.weapon) return p;
            const info = officialWeaponMap.get(p.name.trim().toLowerCase());
            return info ? { ...p, weapon: info.id, weaponQuality: info.quality } : p;
        });

        // Only call the third-party AlbionBB endpoint when the official API
        // did not provide weapon icons for every player.
        if (rawPlayers.some(p => !p.weapon) && options.autoBattle !== true) {
            const albionBBWeaponMap = await fetchAlbionBBWeaponMap(matchId);
            rawPlayers = rawPlayers.map(p => {
                if (p.weapon) return p;
                const info = albionBBWeaponMap.get(p.name.trim().toLowerCase());
                return info ? { ...p, weapon: info.id, weaponQuality: info.quality } : p;
            });
        } else if (rawPlayers.some(p => !p.weapon) && options.autoBattle === true) {
            console.log('ℹ️ [Auto-Battle] ไม่เรียก AlbionBB เพื่อเติมข้อมูลอาวุธ; ใช้ข้อมูล Official ที่มีและเดินหน้าสร้างรายงาน');
        }
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

    // `customTargetGuilds` is used by manual reports. For Auto-Battle,
    // the source guild is only used to find the battle and must not become
    // the tracking scope. Auto-Battle tracking comes from /add player and
    // /add guild instead.
    const guildNamesList = (Array.isArray(options.trackedGuilds)
        ? options.trackedGuilds
        : customTargetGuilds
    ).map(g => typeof g === 'string' ? g : g?.name).filter(Boolean);

    // Resolve the tracking list explicitly from the Discord server that owns
    // this report. Do not rely only on the AsyncLocalStorage getter here:
    // background Auto-Battle jobs and awaited API calls can otherwise end up
    // rendering the entire battle roster.
    const scopedTrackingConfig = options.guildId
        ? getGuildConfig(options.guildId, false)
        : currentGuildConfig();
    const trackedPlayers = Array.isArray(options.trackedPlayers)
        ? options.trackedPlayers.map(String).filter(Boolean)
        : (Array.isArray(scopedTrackingConfig?.players)
            ? scopedTrackingConfig.players.map(String).filter(Boolean)
            : targetPlayers.map(String).filter(Boolean));

    const hasTrackedPlayers = trackedPlayers.length > 0;
    const hasTrackedGuilds = guildNamesList.length > 0;

    const rows = allSortedRows.filter(p => {
        if (!hasTrackedPlayers && !hasTrackedGuilds) return options.autoBattle ? false : true;

        const playerName = String(p.displayName || p.name || '').trim().toLowerCase();
        const isExplicitPlayer = trackedPlayers.some(
            pl => String(pl).trim().toLowerCase() === playerName
        );

        const isGuildMatch = isExactGuildMatch(p.guild, guildNamesList);

        // Auto-Battle's target guild is only the battle source. The rows
        // must be the union of /add player and /add guild tracking scopes.
        // This prevents unrelated members of the source guild from appearing.
        // Manual battle-link reports combine both tracking scopes:
        // explicitly tracked players PLUS every member of each tracked guild.
        // If only one scope is configured, keep that scope strict.
        if (hasTrackedPlayers && hasTrackedGuilds) return isExplicitPlayer || isGuildMatch;
        if (hasTrackedPlayers) return isExplicitPlayer;
        if (hasTrackedGuilds) return isGuildMatch;
        return true;
    });

    // Threshold metrics use the same tracked rows rendered in the report:
    // /add player plus /add guild. The Auto-Battle threshold is total Fame;
    // Kills and Deaths remain report statistics only.
    const metricRows = rows;
    let totalKills = 0, totalDeaths = 0, totalFame = 0;
    for (const p of metricRows) {
        totalKills += p.kills;
        totalDeaths += p.deaths;
        totalFame += p.fame;
    }
    const guildTotalFrames = totalKills + totalDeaths; // legacy field; threshold uses totalFame

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

    const trackedPlayerNames = new Set(
        trackedPlayers.map(name => String(name || '').trim().toLowerCase()).filter(Boolean)
    );
    const explicitlyTrackedRows = displayRows.filter(p =>
        trackedPlayerNames.has(String(p.displayName || p.name || '').trim().toLowerCase())
    );

    // Battle image roster rules:
    // 1) /add guild  -> include EVERY player from the tracked guild.
    // 2) /add player -> additionally include those explicitly tracked players,
    //    even when they are outside the tracked guild.
    // 3) Do not include unrelated players from the battle.
    //
    // "rows" is already filtered by the guild/player tracking rules above,
    // so it is the authoritative roster for the image report.
    const reportRosterRows = displayRows;

    const performancePlayers = reportRosterRows
        .filter(p => p.damage > 0 || p.healing > 0)
        .sort((a, b) => (b.damage + b.healing) - (a.damage + a.healing))
        .slice(0, 5);

    const attachments = [];

    // One weapon report image per 10 tracked players; five cards per row.
    // This keeps the rendered image shorter so Discord does not scale the
    // weapon icons down excessively in the message preview.
    const playersPerReportPage = 10;
    const reportPages = [];
    for (let offset = 0; offset < reportRosterRows.length; offset += playersPerReportPage) {
        reportPages.push(reportRosterRows.slice(offset, offset + playersPerReportPage));
    }
    if (!reportPages.length) reportPages.push([]);
    for (let pageIndex = 0; pageIndex < reportPages.length; pageIndex++) {
        const pageRows = reportPages[pageIndex];
        const pageInfo = { matchId: matchId, battleTime: battleTime, page: pageIndex + 1, totalPages: reportPages.length };
        try {
            const playerReport = await generatePlayerWeaponReportImage(pageRows, pageInfo);
            if (playerReport) attachments.push(playerReport);
        } catch (err) {
            console.error('Weapon report image error:', err.stack || err.message);
            try {
                const fallbackReport = await generateBattleReportFallbackImage(pageRows, pageInfo);
                if (fallbackReport) attachments.push(fallbackReport);
            } catch (fallbackErr) {
                console.error('Battle report fallback error:', fallbackErr.stack || fallbackErr.message);
            }
        }
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
                const allianceId = String(g.allianceId || g.alliance || '').trim();
                const allianceRecord = allianceId && apiData.alliances
                    ? (apiData.alliances[allianceId] || Object.values(apiData.alliances).find(a => String(a.id || a.allianceId || '') === allianceId))
                    : null;
                const allianceName = String(allianceRecord?.name || (allianceId && !/^[0-9]+$/.test(allianceId) ? allianceId : '') || '-').trim();

                return {
                    name: guildName,
                    alliance: allianceName,
                    playersCount: playerCountByGuild.get(guildKey)?.size || 0,
                    kills: g.kills || 0,
                    deaths: g.deaths || 0,
                    killFame: g.killFame || 0
                };
            });

            if (options.autoBattle) {
                // AUTO-BATTLE guild summary: keep the image compact.
                // Show ONLY the 4 guilds with the highest combined battle impact,
                // ranked primarily by Fame, then Kills, then Deaths.
                guildsData = guildsData
                    .sort((a, b) =>
                        (b.killFame || 0) - (a.killFame || 0) ||
                        (b.kills || 0) - (a.kills || 0) ||
                        (b.deaths || 0) - (a.deaths || 0)
                    )
                    .slice(0, 4);
            } else if (guildNamesList.length > 0) {
                guildsData = guildsData.filter(g => isExactGuildMatch(g.name, guildNamesList));
            } else {
                guildsData.sort((a, b) => b.killFame - a.killFame);
            }

            guildSummaryData = guildsData;
            guildSummaryAttachment = await generateGuildSummaryImage(guildsData, { includeAlliance: true });
        }
    } catch (err) {
        console.error('❌ Guild summary image error:', err.message);
    }

    if (guildSummaryAttachment) {
        attachments.push(guildSummaryAttachment);
    }

    // Prefer the image report whenever one was successfully generated.
    // Keep the ANSI/text report as a fallback only when image generation fails.
    const responseContent = attachments.length > 0
        ? `🔗 **Battle Link:** <${battleUrl}>\n🖼️ **Battle Report:** รายงานแบบรูปภาพด้านล่าง`
        : report;

    return {
        matchId,
        totalKills,
        totalDeaths,
        totalFame,
        guildTotalFrames,
        battleUrl,
        battleTime,
        guildSummaryData,
        playerReportData: reportRosterRows,
        payload: { content: responseContent, files: attachments }
    };
}

async function processBattleReport(input, targetContext, isMessage = false) {
    try {
        const guildId = currentGuildId();
        const guildConfig = guildId ? getGuildConfig(guildId, false) : null;
        const trackedPlayers = Array.isArray(guildConfig?.players) ? guildConfig.players : [];
        const rawInput = String(input || '').trim();
        let multiIds = null;
        if (/^https?:\/\//i.test(rawInput)) {
            let parsedUrl;
            try { parsedUrl = new URL(rawInput); } catch (_) { throw new Error('ไม่สามารถอ่าน URL Battle Link ได้'); }
            if (/\/battles\/multi\/?$/i.test(parsedUrl.pathname)) {
                const idsParam = parsedUrl.searchParams.get('ids') || '';
                const rawIds = idsParam.split(',').map(id => id.trim());
                const ids = [...new Set(rawIds.filter(id => /^\d+$/.test(id)))];
                if (!idsParam || !ids.length || ids.length !== rawIds.filter(Boolean).length) throw new Error('ลิงก์รวมไฟต์มี Match ID ไม่ถูกต้อง');
                if (ids.length > 10) throw new Error('ลิงก์รวมไฟต์รองรับสูงสุด 10 ไฟต์ต่อครั้ง');
                multiIds = ids;
            }
        }
        if (multiIds && multiIds.length > 1) {
            const results = [], failures = [];
            for (const id of multiIds) {
                try {
                    results.push(await buildBattleReportPayload(id, targetGuilds, { guildId, trackedPlayers }));
                } catch (err) {
                    failures.push({ id, reason: err?.message || 'ไม่ทราบสาเหตุ' });
                    console.error('❌ BattleLink multi: Match ID ' + id + ' failed:', err);
                }
            }
            if (!results.length) throw new Error('ดึงข้อมูลไฟต์จากลิงก์รวมไม่สำเร็จ (' + failures.map(f => f.id).join(', ') + ')');
            const totalKills = results.reduce((sum, r) => sum + (Number(r.totalKills) || 0), 0);
            const totalDeaths = results.reduce((sum, r) => sum + (Number(r.totalDeaths) || 0), 0);
            const totalFame = results.reduce((sum, r) => sum + (Number(r.totalFame) || 0), 0);
            // Angle-bracket URLs keep Discord from rendering AlbionBB link-preview cards in the bot report.
            const links = results.map(r => '• <https://east.albionbb.com/battles/' + r.matchId + '>').join('\n');
            const warning = failures.length ? '\n⚠️ ดึงข้อมูลไม่สำเร็จ ' + failures.length + ' ไฟต์: ' + failures.map(f => f.id + ' (' + f.reason + ')').join('; ') : '';
            // BattleLink only: combine player K/D and fame across all linked fights.
            // Keep the first weapon found for each player, in link order.
            const combinedPlayers = new Map();
            for (const result of results) {
                for (const player of (Array.isArray(result.playerReportData) ? result.playerReportData : [])) {
                    const name = String(player.displayName || player.name || '').trim();
                    if (!name) continue;
                    const key = name.toLowerCase();
                    const old = combinedPlayers.get(key);
                    if (!old) {
                        combinedPlayers.set(key, {
                            ...player,
                            kills: Number(player.kills) || 0,
                            deaths: Number(player.deaths) || 0,
                            fame: Number(player.fame) || 0,
                            damage: Number(player.damage) || 0,
                            healing: Number(player.healing) || 0,
                            weapon: player.weapon || '',
                            weaponQuality: Number(player.weaponQuality) || 1
                        });
                    } else {
                        old.kills += Number(player.kills) || 0;
                        old.deaths += Number(player.deaths) || 0;
                        old.fame += Number(player.fame) || 0;
                        old.damage += Number(player.damage) || 0;
                        old.healing += Number(player.healing) || 0;
                        if (!old.weapon && player.weapon) {
                            old.weapon = player.weapon;
                            old.weaponQuality = Number(player.weaponQuality) || 1;
                        }
                    }
                }
            }
            const combinedPlayerRows = [...combinedPlayers.values()].sort((a, b) =>
                (Number(b.fame) || 0) - (Number(a.fame) || 0) ||
                (Number(b.kills) || 0) - (Number(a.kills) || 0)
            );
            const files = results.flatMap(r =>
                (Array.isArray(r.payload.files) ? r.payload.files : [])
                    .filter(file => {
                        const name = String(file?.name || file?.attachment?.name || '');
                        return name !== 'guild-summary.png' && name !== 'battle-report.png';
                    })
            );
            // Replace per-fight weapon/player cards with a single combined report.
            const combinedReportPages = [];
            for (let offset = 0; offset < combinedPlayerRows.length; offset += 10) {
                combinedReportPages.push(combinedPlayerRows.slice(offset, offset + 10));
            }
            for (let pageIndex = 0; pageIndex < combinedReportPages.length; pageIndex++) {
                try {
                    const reportImage = await generatePlayerWeaponReportImage(combinedReportPages[pageIndex], {
                        matchId: 'COMBINED',
                        page: pageIndex + 1,
                        totalPages: combinedReportPages.length
                    });
                    if (reportImage) {
                        reportImage.name = 'battle-report-combined-' + (pageIndex + 1) + '.png';
                        files.push(reportImage);
                    }
                } catch (err) {
                    console.error('❌ BattleLink combined player report error:', err.message);
                }
            }
            const guildTotals = new Map();
            for (const result of results) {
                for (const guild of (Array.isArray(result.guildSummaryData) ? result.guildSummaryData : [])) {
                    const key = String(guild.name || '').trim().toLowerCase();
                    if (!key) continue;
                    const old = guildTotals.get(key);
                    if (!old) guildTotals.set(key, { ...guild });
                    else {
                        old.playersCount += Number(guild.playersCount) || 0;
                        old.kills += Number(guild.kills) || 0;
                        old.deaths += Number(guild.deaths) || 0;
                        old.killFame += Number(guild.killFame) || 0;
                        if ((!old.alliance || old.alliance === '-') && guild.alliance) old.alliance = guild.alliance;
                    }
                }
            }
            const mergedGuildRows = [...guildTotals.values()].sort((a, b) =>
                (Number(b.killFame) || 0) - (Number(a.killFame) || 0)
            );
            try {
                const mergedGuildImage = await generateGuildSummaryImage(mergedGuildRows, { includeAll: true, includeAlliance: true });
                if (mergedGuildImage) files.unshift(mergedGuildImage);
            } catch (err) {
                console.error('❌ BattleLink merged guild summary error:', err.message);
            }
            const reportDate = new Date(results[0].battleTime || Date.now()).toLocaleDateString('en-GB', { timeZone: 'UTC' });
            const trackingConfig = guildId ? getGuildConfig(guildId, false) : null;
            const hasTrackedPlayers = Array.isArray(trackedPlayers) && trackedPlayers.length > 0;
            const hasTrackedGuilds = Array.isArray(trackingConfig?.guilds) && trackingConfig.guilds.length > 0;
            const ansi = { blue: '\x1b[34m', red: '\x1b[31m', green: '\x1b[32m', white: '\x1b[37m', cyan: '\x1b[36m', yellow: '\x1b[33m', magenta: '\x1b[35m', reset: '\x1b[0m' };
            const center = (v,w) => { const t=String(v); const l=Math.max(0,Math.floor((w-t.length)/2)); return ' '.repeat(l)+t+' '.repeat(Math.max(0,w-t.length-l)); };
            const colorNumber = (n,type) => { const v=Number(n)||0; return (v===0?ansi.white:(type==='kills'?ansi.red:ansi.green))+String(v)+ansi.reset; };
            const cellNumber = (n,type,w) => { const v=Number(n)||0; return (v===0?ansi.white:(type==='kills'?ansi.red:ansi.green))+center(v,w)+ansi.reset; };
            const guildHeaders = () => ansi.yellow + center('ALLIANCE',12) + center('NAME',14) + center('PLAYERS',8) + center('KILLS',8) + center('DEATHS',8) + center('FAME',10) + ansi.reset + '\n' + ansi.white + '─'.repeat(60) + ansi.reset;
            let textReport = ansi.blue + 'Battle Report | Date: ' + reportDate + ansi.reset + '\n';
            let totalFameReport = 0;
            if (hasTrackedPlayers && !hasTrackedGuilds) {
                const playerTotals = new Map();
                for (const result of results) for (const p of (Array.isArray(result.playerReportData) ? result.playerReportData : [])) {
                    const name = String(p.displayName || p.name || '').trim(); if (!name) continue;
                    const key = name.toLowerCase(); const row = playerTotals.get(key) || { name, kills: 0, deaths: 0, fame: 0 };
                    row.kills += Number(p.kills) || 0; row.deaths += Number(p.deaths) || 0; row.fame += Number(p.fame) || 0; playerTotals.set(key, row);
                }
                const nw=22, kw=10, dw=10;
                textReport += center('Name',nw)+center('Kills',kw)+center('Deaths',dw)+'\n';
                let sumKills=0, sumDeaths=0;
                for (const p of playerTotals.values()) {
                    textReport += center(p.name.slice(0,nw),nw)+center(colorNumber(p.kills,'kills'),kw)+center(colorNumber(p.deaths,'deaths'),dw)+'\n';
                    sumKills+=p.kills; sumDeaths+=p.deaths; totalFameReport+=p.fame;
                }
                textReport += ansi.red + center('TOTAL',nw)+center(sumKills,kw)+center(sumDeaths,dw) + ansi.reset;
            } else if (hasTrackedGuilds) {
                const aw=12, nw=14, pw=8, kw=8, dw=8, fw=10;
                textReport += guildHeaders()+'\n';
                let sumPlayers=0, sumKills=0, sumDeaths=0;
                for (const g of mergedGuildRows) {
                    textReport += center(String(g.alliance || '-').slice(0,aw),aw) +
                        center(String(g.name || 'Unknown').slice(0,nw),nw) +
                        cellNumber(g.playersCount,'players',pw) +
                        cellNumber(g.kills,'kills',kw) +
                        cellNumber(g.deaths,'deaths',dw) +
                        ansi.yellow + center(formatFame(g.killFame || 0),fw) + ansi.reset + '\n';
                    sumPlayers+=Number(g.playersCount)||0;
                    sumKills+=Number(g.kills)||0;
                    sumDeaths+=Number(g.deaths)||0;
                    totalFameReport+=Number(g.killFame)||0;
                }
                textReport += ansi.white + '┄'.repeat(60) + ansi.reset + '\n';
                textReport += ansi.red + 'TOTAL'.padEnd(aw+nw) +
                    cellNumber(sumPlayers,'players',pw) +
                    cellNumber(sumKills,'kills',kw) +
                    cellNumber(sumDeaths,'deaths',dw) +
                    ansi.yellow + center(formatFame(totalFameReport),fw) + ansi.reset;
            } else { totalFameReport = totalFame; textReport += 'Kills: '+totalKills.toLocaleString()+' | Deaths: '+totalDeaths.toLocaleString(); }
            textReport += '\n\n' + ansi.red + 'Total Fame: ' + totalFameReport.toLocaleString() + ansi.reset + '\n';            const ticks = String.fromCharCode(96).repeat(3);
            const payload = {
                content: '📋\n' + ticks + 'ansi\n' + textReport + ticks + '\n\n' + '⚔️ **BattleLink — รายงานรวม ' + results.length + '/' + multiIds.length + ' ไฟต์**\n' + '🔗 **ไฟต์ที่รวม:**\n' + links + warning + (files.length ? '\n🖼️ รายงานรูปภาพอยู่ด้านล่าง' : ''),
                files
            };
            if (files.length > 1) {
                const firstPayload = { content: payload.content, files: [files[0]] };
                if (isMessage) {
                    await targetContext.edit(firstPayload);
                    for (const file of files.slice(1)) await targetContext.channel.send({ files: [file] });
                } else {
                    await targetContext.editReply(firstPayload);
                    for (const file of files.slice(1)) await targetContext.followUp({ files: [file] });
                }
            } else if (isMessage) await targetContext.edit(payload);
            else await targetContext.editReply(payload);
            return;
        }
        const matchId = multiIds?.[0] || extractMatchId(input);
        const battleResult = await buildBattleReportPayload(matchId, targetGuilds, { guildId, trackedPlayers });
        const payload = battleResult.payload;
        const files = Array.isArray(payload.files) ? payload.files : [];
        if (isMessage && guildConfig?.battleLinkChannelId && targetContext?.channel?.id === guildConfig.battleLinkChannelId) {
            // BattleLink only: put the guild report first, followed by per-fight weapon/player images.
            const guildReportIndex = files.findIndex(file => String(file?.name || file?.attachment?.name || '') === 'guild-summary.png');
            if (guildReportIndex > 0) files.unshift(files.splice(guildReportIndex, 1)[0]);
            const totalKills = Number(battleResult.totalKills) || 0;
            const totalDeaths = Number(battleResult.totalDeaths) || 0;
            const battleUrl = battleResult.battleUrl || 'https://east.albionbb.com/battles/' + matchId;
            const reportDate = new Date(battleResult.battleTime || Date.now()).toLocaleDateString('en-GB', { timeZone: 'UTC' });
            const hasTrackedPlayers = Array.isArray(trackedPlayers) && trackedPlayers.length > 0;
            const hasTrackedGuilds = Array.isArray(guildConfig?.guilds) && guildConfig.guilds.length > 0;
            const ansi = { blue: '\x1b[34m', red: '\x1b[31m', green: '\x1b[32m', white: '\x1b[37m', yellow: '\x1b[33m', reset: '\x1b[0m' };
            const center = (v,w) => { const t=String(v); const left=Math.max(0,Math.floor((w-t.length)/2)); return ' '.repeat(left)+t+' '.repeat(Math.max(0,w-t.length-left)); };
            const colorNumber = (n,type) => { const v=Number(n)||0; return (v===0?ansi.white:(type==='kills'?ansi.red:ansi.green))+String(v)+ansi.reset; };
            const cellNumber = (n,type,w) => { const v=Number(n)||0; return (v===0?ansi.white:(type==='kills'?ansi.red:ansi.green))+center(v,w)+ansi.reset; };
            const guildHeaders = () => ansi.yellow + center('ALLIANCE',12) + center('NAME',14) + center('PLAYERS',8) + center('KILLS',8) + center('DEATHS',8) + center('FAME',10) + ansi.reset + '\n' + ansi.white + '─'.repeat(60) + ansi.reset;
            let textReport = ansi.blue + 'Battle Report | Date: ' + reportDate + ansi.reset + '\n';
            let totalFameReport = 0;
            if (hasTrackedPlayers && !hasTrackedGuilds) {
                const nw=22, kw=10, dw=10; textReport += center('Name',nw)+center('Kills',kw)+center('Deaths',dw)+'\n';
                let sumKills=0, sumDeaths=0;
                for (const p of (Array.isArray(battleResult.playerReportData)?battleResult.playerReportData:[])) {
                    const name=String(p.displayName||p.name||'').trim(); textReport += center(name.slice(0,nw),nw)+center(colorNumber(p.kills,'kills'),kw)+center(colorNumber(p.deaths,'deaths'),dw)+'\n';
                    sumKills+=Number(p.kills)||0; sumDeaths+=Number(p.deaths)||0; totalFameReport+=Number(p.fame)||0;
                }
                textReport += ansi.red+center('TOTAL',nw)+center(sumKills,kw)+center(sumDeaths,dw)+ansi.reset;
            } else if (hasTrackedGuilds) {
                const aw=12,nw=14,pw=8,kw=8,dw=8,fw=10; textReport += guildHeaders()+'\n';
                let sumPlayers=0,sumKills=0,sumDeaths=0;
                for (const g of (Array.isArray(battleResult.guildSummaryData)?battleResult.guildSummaryData:[])) {
                    textReport += center(String(g.alliance||'-').slice(0,aw),aw)+center(String(g.name||'Unknown').slice(0,nw),nw)+cellNumber(g.playersCount,'players',pw)+cellNumber(g.kills,'kills',kw)+cellNumber(g.deaths,'deaths',dw)+ansi.yellow+center(formatFame(g.killFame||0),fw)+ansi.reset+'\n';
                    sumPlayers+=Number(g.playersCount)||0; sumKills+=Number(g.kills)||0; sumDeaths+=Number(g.deaths)||0; totalFameReport+=Number(g.killFame)||0;
                }
                textReport += ansi.white+'┄'.repeat(60)+ansi.reset+'\n';
                textReport += ansi.red+'TOTAL'.padEnd(aw+nw)+cellNumber(sumPlayers,'players',pw)+cellNumber(sumKills,'kills',kw)+cellNumber(sumDeaths,'deaths',dw)+ansi.yellow+center(formatFame(totalFameReport),fw)+ansi.reset;
            } else { totalFameReport=Number(battleResult.totalFame)||0; textReport += 'Kills: '+totalKills.toLocaleString()+' | Deaths: '+totalDeaths.toLocaleString(); }
            textReport += '\n\n' + ansi.red + 'Total Fame: ' + totalFameReport.toLocaleString() + ansi.reset + '\n';            const ticks = String.fromCharCode(96).repeat(3);
            payload.content = '📋\n' + ticks + 'ansi\n' + textReport + ticks + '\n\n' + '🔗 **Battle Link:** <' + battleUrl + '>' + (files.length ? '\n🖼️ **Battle Report:** รูปรายงานอยู่ด้านล่าง' : '');
        }
        if (files.length > 1) {
            const firstPayload = { content: payload.content, files: [files[0]] };
            if (isMessage) {
                await targetContext.edit(firstPayload);
                for (const file of files.slice(1)) await targetContext.channel.send({ files: [file] });
            } else {
                await targetContext.editReply(firstPayload);
                for (const file of files.slice(1)) await targetContext.followUp({ files: [file] });
            }
            return;
        }
        if (isMessage) await targetContext.edit(payload); else await targetContext.editReply(payload);
    } catch (err) {
        console.error('❌ Process battle report error:', err);
        const message = '❌ เกิดข้อผิดพลาดในการประมวลผลไฟต์: ' + err.message;
        if (isMessage) await targetContext.edit(message); else await targetContext.editReply(message);
    }
}
function parseGuildReference(value) {
    const raw = String(value || '').trim();
    // Accept both Albion guild pages and the older /guilds/<ID> form.
    const urlMatch = raw.match(/\/(?:guilds|killboard\/guild|guild)\/([A-Za-z0-9_-]+)(?:[/?#]|$)/i);
    const id = urlMatch?.[1] || (/^[A-Za-z0-9_-]{16,}$/.test(raw) ? raw : '');
    return { name: id ? '' : raw, id };
}

async function resolveOfficialGuildReference(value) {
    const raw = String(value || '').trim();
    const parsed = parseGuildReference(raw);
    const lookupName = parsed.name || (!parsed.id ? raw : '');
    if (!parsed.id && !lookupName) return { id: '', name: '' };

    const normalizeName = name => String(name || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
    const cacheKey = parsed.id ? 'id:' + parsed.id : 'name:' + normalizeName(lookupName);
    const cache = resolveOfficialGuildReference._cache || (resolveOfficialGuildReference._cache = new Map());
    const inFlight = resolveOfficialGuildReference._inFlight || (resolveOfficialGuildReference._inFlight = new Map());
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return { id: cached.id || '', name: cached.name || '' };
    if (inFlight.has(cacheKey)) return await inFlight.get(cacheKey);

    const task = (async () => {
        const bases = [
            'https://gameinfo-sgp.albiononline.com/api/gameinfo',
            'https://gameinfo.albiononline.com/api/gameinfo'
        ];
        let lastDetail = 'ไม่พบชื่อกิลด์ที่ตรงกัน';
        for (const base of bases) {
            try {
                const response = parsed.id
                    ? await axios.get(base + '/guilds/' + encodeURIComponent(parsed.id), {
                        timeout: 8000,
                        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }
                    })
                    : await axios.get(base + '/search', {
                        timeout: 8000,
                        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
                        params: { q: lookupName }
                    });
                const data = response?.data || {};
                if (parsed.id) {
                    const id = String(data.Id || data.id || parsed.id).trim();
                    const name = String(data.Name || data.name || '').trim();
                    if (name) {
                        console.log('🔎 [GuildResolver] ใช้ ID ' + id + ' สำหรับกิลด์ "' + name + '"');
                        return { id, name };
                    }
                    lastDetail = 'API ตอบกลับแต่ไม่มีชื่อกิลด์';
                    continue;
                }

                const guilds = Array.isArray(data.guilds) ? data.guilds :
                    (Array.isArray(data.Guilds) ? data.Guilds : []);
                const wanted = normalizeName(lookupName);
                const exactMatches = guilds.filter(g => normalizeName(g?.Name ?? g?.name) === wanted);
                if (exactMatches.length === 1) {
                    const match = exactMatches[0];
                    const id = String(match.Id ?? match.id ?? '').trim();
                    const name = String(match.Name ?? match.name ?? lookupName).trim();
                    if (/^[A-Za-z0-9_-]{16,}$/.test(id)) {
                        console.log('🔎 [GuildResolver] ใช้ ID ' + id + ' สำหรับกิลด์ "' + name + '"');
                        return { id, name };
                    }
                    lastDetail = 'ผลค้นหามีกิลด์แต่ไม่มี ID ที่ถูกต้อง';
                } else if (exactMatches.length > 1) {
                    console.warn('⚠️ [GuildResolver] พบชื่อกิลด์ "' + lookupName + '" ซ้ำหลายรายการ; ไม่เลือก ID แบบเดา');
                    return { id: '', name: '' };
                } else {
                    lastDetail = 'ไม่พบชื่อกิลด์ตรงกันใน Search API';
                }
            } catch (error) {
                const status = error?.response?.status || error?.statusCode;
                lastDetail = status ? 'HTTP ' + status : String(error?.code || error?.message || 'request failed');
            }
        }
        console.warn('⚠️ [GuildResolver] Resolve กิลด์ "' + (lookupName || parsed.id) + '" ไม่สำเร็จ (' + lastDetail + '); จะไม่ส่งชื่อย่อที่ไม่ใช่ ID ไปยัง Official Battles API');
        return { id: parsed.id || '', name: '' };
    })();

    inFlight.set(cacheKey, task);
    try {
        const result = await task;
        const ttl = result.id ? 6 * 60 * 60 * 1000 : 5 * 60 * 1000;
        cache.set(cacheKey, { ...result, expiresAt: Date.now() + ttl });
        if (result.id) {
            cache.set('id:' + result.id, { ...result, expiresAt: Date.now() + ttl });
            if (result.name) cache.set('name:' + normalizeName(result.name), { ...result, expiresAt: Date.now() + ttl });
        }
        return { id: result.id || '', name: result.name || '' };
    } finally {
        if (inFlight.get(cacheKey) === task) inFlight.delete(cacheKey);
    }
}

function extractBattleIdsFromHtml(html, targetGuild = '') {
    const source = String(html || '');
    const ids = new Set();
    const target = String(targetGuild || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const normalizeText = value => String(value || '').replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim().toLowerCase();
    const containsTargetGuild = value => {
        if (!target) return true;
        const text = normalizeText(value);
        if (text.includes(target)) return true;
        const compactText = text.replace(/[^a-z0-9]/g, '');
        const compactTarget = target.replace(/[^a-z0-9]/g, '');
        return Boolean(compactTarget && compactText.includes(compactTarget));
    };
    const add = (value, context) => {
        const id = String(value || '').trim();
        if (!/^\d+$/.test(id) || !containsTargetGuild(context)) return;
        ids.add(id);
    };

    try {
        const $ = cheerio.load(source);
        $('a[href*="/battleboard/"], a[href*="/battles/"]').each((_, el) => {
            const href = String($(el).attr('href') || '');
            const match = href.match(/\/battleboard\/(\d+)(?:\/(?:asia|americas|europe))?(?:[/?#]|$)/i) ||
                href.match(/\/battles\/(\d+)(?:[/?#]|$)/i);
            if (!match) return;
            const id = match[1];
            let node = $(el);
            for (let depth = 0; depth < 6 && node.length; depth++, node = node.parent()) {
                const text = node.text().replace(/\s+/g, ' ').trim();
                const hasId = new RegExp('\\bID\\s*:?\\s*' + id + '\\b', 'i').test(text) || text.includes(id);
                if (hasId && containsTargetGuild(text)) { add(id, text); break; }
            }
        });
    } catch (_) {}

    // Regex backup for the ID label. Segment each label up to the next label so
    // a tracked guild in one card cannot accidentally qualify every nearby battle.
    const labelMatches = [...source.matchAll(/\bID\s*:\s*(\d+)\b/gi)];
    for (let i = 0; i < labelMatches.length; i++) {
        const match = labelMatches[i];
        const end = i + 1 < labelMatches.length ? labelMatches[i + 1].index : Math.min(source.length, match.index + 4000);
        const context = source.slice(match.index, end);
        let contextText = context;
        try { contextText = cheerio.load(context)('body').text().replace(/\s+/g, ' ').trim(); } catch (_) {}
        add(match[1], contextText);
    }
    return [...ids];
}

function getAutoBattleQueueScopeKey(config = {}, targetGuildId = '', targetGuild = '') {
    const serverId = String(config?.guildId || currentGuildId() || 'global').trim();
    const configuredGuildId = parseGuildReference(config?.targetGuildId || '').id;
    const configuredTarget = parseGuildReference(config?.targetGuild || '');
    const resolvedId = String(targetGuildId || configuredGuildId || configuredTarget.id || '').trim();
    const targetName = String(targetGuild || configuredTarget.name || config?.targetGuild || config?.targetGuildId || '').trim();
    return serverId + ':' + (resolvedId || targetName).toLowerCase();
}

async function fetchGuildRecentBattles(guildOrConfig, options = {}) {
    const baselineOnly = options?.baselineOnly === true;
    const config = guildOrConfig && typeof guildOrConfig === 'object' ? guildOrConfig : {};
    const rawTarget = typeof guildOrConfig === 'string' ? guildOrConfig : (config.targetGuild || '');
    const rawConfiguredGuildId = String(config.targetGuildId || '').trim();
    const parsedConfiguredGuild = parseGuildReference(rawConfiguredGuildId);
    const parsedTarget = parseGuildReference(rawTarget);
    let targetGuildId = parsedConfiguredGuild.id || parsedTarget.id || '';
    let targetGuild = String(config.targetGuild || parsedTarget.name || '').trim();

    // A URL or ID is not a guild name; resolve its readable name before using guild filters.
    if (parseGuildReference(targetGuild).id) targetGuild = '';
    if (!targetGuildId || !targetGuild) {
        const resolveInput = targetGuild || rawTarget || (rawConfiguredGuildId && !parsedConfiguredGuild.id ? rawConfiguredGuildId : targetGuildId);
        const resolvedGuild = await resolveOfficialGuildReference(resolveInput);
        if (resolvedGuild.id) targetGuildId = resolvedGuild.id;
        if (resolvedGuild.name && (!targetGuild || parseGuildReference(config.targetGuild).id)) targetGuild = resolvedGuild.name;
    }

    if (!targetGuildId && !targetGuild) return null;
    if (targetGuildId && !/^[A-Za-z0-9_-]{16,}$/.test(String(targetGuildId))) {
        console.warn('⚠️ [GuildResolver] ปฏิเสธ Guild ID ที่รูปแบบไม่ถูกต้อง; ต้องเป็น ID ของ Albion ที่ผ่านการตรวจสอบ | Guild=' + (targetGuild || 'ไม่ทราบชื่อ'));
        targetGuildId = '';
    }

    // Repair legacy tracker values such as targetGuildId: "PLAC" after resolving the actual SBI ID.
    if (config && typeof guildOrConfig === 'object' && targetGuildId) {
        const configuredNameIsReference = Boolean(parseGuildReference(config.targetGuild).id);
        const idChanged = String(config.targetGuildId || '').trim() !== targetGuildId;
        const nameChanged = Boolean(targetGuild && (configuredNameIsReference || !String(config.targetGuild || '').trim()) &&
            String(config.targetGuild || '').trim() !== targetGuild);
        if (idChanged || nameChanged) {
            config.targetGuildId = targetGuildId;
            if (targetGuild && (configuredNameIsReference || !String(config.targetGuild || '').trim())) config.targetGuild = targetGuild;
            try { saveData(); }
            catch (error) { console.warn('⚠️ [GuildResolver] ไม่สามารถบันทึก ID ที่ resolve แล้วได้: ' + String(error?.message || error)); }
            console.log('✅ [GuildResolver] อัปเดต Tracker: กิลด์="' + (targetGuild || targetGuildId) + '" | Guild ID=' + targetGuildId);
        }
    }

    const scopeKey = String(targetGuildId || targetGuild).trim().toLowerCase();
    const queueScopeKey = getAutoBattleQueueScopeKey(config, targetGuildId, targetGuild);
    const sourceByScope = fetchGuildRecentBattles._lastSourceByScope ||
        (fetchGuildRecentBattles._lastSourceByScope = new Map());
    const setSource = source => sourceByScope.set(queueScopeKey, source);
    const pendingByScope = fetchGuildRecentBattles._pendingMatchIds ||
        (fetchGuildRecentBattles._pendingMatchIds = new Map());
    const queueCandidates = (ids, source) => {
        setSource(source);
        const normalized = [...new Set((Array.isArray(ids) ? ids : [])
            .map(id => String(id || '').trim())
            .filter(id => /^\d+$/.test(id)))];
        if (baselineOnly) return normalized;
        const pendingIds = pendingByScope.get(queueScopeKey) || new Map();
        const next = new Map();
        for (const id of normalized) {
            if (!processedBattles.has(id)) next.set(id, pendingIds.get(id) || { firstSeenAt: Date.now() });
        }
        // Preserve unresolved IDs only inside this Discord-server + target-guild queue.
        for (const [id, metadata] of pendingIds.entries()) {
            if (!processedBattles.has(id) && !next.has(id)) next.set(id, metadata);
        }
        let dropped = 0;
        while (next.size > 1000) {
            let oldestId = null, oldestAt = Infinity;
            for (const [id, metadata] of next.entries()) {
                const firstSeenAt = Number(metadata?.firstSeenAt) || 0;
                if (firstSeenAt < oldestAt) { oldestAt = firstSeenAt; oldestId = id; }
            }
            if (oldestId === null) break;
            next.delete(oldestId);
            dropped++;
        }
        pendingByScope.set(queueScopeKey, next);
        if (dropped) console.warn('⚠️ [Auto-Battle Queue] คิว Tracker=' + queueScopeKey +
            ' เกิน 1,000 Match ID; ตัดรายการเก่าที่สุดออก ' + dropped + ' รายการ');
        return [...next.keys()];
    };
    console.log('🔄 Auto-Battle source: Official Albion GameInfo API ONLY | Server=Asia' +
        (baselineOnly ? ' | โหมดตั้งต้นประวัติ' : ''));

    if (!targetGuildId) {
        const source = 'Official Albion API unavailable: Guild ID required';
        setSource(source);
        console.warn('⚠️ [Official API หลัก] ไม่สามารถค้นหาไฟต์ได้ เพราะไม่มี Guild ID ที่ผ่านการตรวจสอบ | กิลด์=' + (targetGuild || 'ไม่ทราบชื่อ'));
        return baselineOnly ? null : queueCandidates([], source);
    }

    // Official GameInfo is the sole source for Auto-Battle Match ID discovery.
    const officialCache = fetchGuildRecentBattles._officialListCache ||
        (fetchGuildRecentBattles._officialListCache = new Map());
    const officialInFlight = fetchGuildRecentBattles._officialListInFlight ||
        (fetchGuildRecentBattles._officialListInFlight = new Map());
    const officialEventCache = fetchGuildRecentBattles._officialEventCache ||
        (fetchGuildRecentBattles._officialEventCache = new Map());
    const officialEventInFlight = fetchGuildRecentBattles._officialEventInFlight ||
        (fetchGuildRecentBattles._officialEventInFlight = new Map());

    // Early warning from the Official Asia kill-event stream. Event BattleId values
    // are candidates only; the existing official battle-detail validation/report flow
    // remains authoritative and retries when the Battle record is not ready yet.
    const fetchRecentEventBattleIds = async () => {
        const now = Date.now();
        const cached = officialEventCache.get(targetGuildId);
        if (cached && cached.expiresAt > now) {
            return { valid: cached.valid === true, ids: Array.isArray(cached.ids) ? [...cached.ids] : [] };
        }
        if (officialEventInFlight.has(targetGuildId)) return await officialEventInFlight.get(targetGuildId);
        if (officialApiRateLimitedUntil > now) return { valid: false, ids: [] };

        const task = (async () => {
            if (officialApiRateLimitedUntil > Date.now()) return { valid: false, ids: [] };
            try {
                const response = await axios.get('https://gameinfo-sgp.albiononline.com/api/gameinfo/events', {
                    timeout: 8000,
                    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
                    params: { limit: 51, offset: 0, guildId: targetGuildId }
                });
                if (!Array.isArray(response.data)) {
                    console.warn('⚠️ [Official API Events] รูปแบบข้อมูลไม่ถูกต้อง | Guild=' +
                        (targetGuild || targetGuildId));
                    officialEventCache.set(targetGuildId, {
                        valid: false, ids: [], expiresAt: Date.now() + 5000
                    });
                    return { valid: false, ids: [] };
                }

                const ids = [...new Set(response.data
                    .map(row => row?.BattleId ?? row?.battleId)
                    .map(id => String(id ?? '').trim())
                    .filter(id => /^\d+$/.test(id) && Number(id) > 0))];
                officialEventCache.set(targetGuildId, {
                    valid: true, ids, expiresAt: Date.now() + 15000
                });
                while (officialEventCache.size > 100) {
                    officialEventCache.delete(officialEventCache.keys().next().value);
                }
                console.log('ℹ️ [Official API Events] Server=Asia | Guild=' + (targetGuild || targetGuildId) +
                    ' | Events=' + response.data.length + ' | พบ Battle ID=' + ids.length);
                return { valid: true, ids };
            } catch (error) {
                const status = error?.response?.status || error?.statusCode;
                const responseBody = error?.response?.data;
                const responseDetail = responseBody == null ? '' :
                    (typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody))
                        .replace(/https?:\/\/\S+/gi, '[URL]').replace(/\s+/g, ' ').slice(0, 180);
                const detail = (status ? 'HTTP ' + status : String(error?.code || error?.message || 'request failed')) +
                    (responseDetail ? ' | API=' + responseDetail : '');
                console.warn('⚠️ [Official API Events] Server=Asia | Guild=' + (targetGuild || targetGuildId) +
                    ' | สาเหตุ=' + detail + ' | จะใช้ Battle List ตามปกติต่อ');
                if (Number(status) === 429) {
                    const waitMs = Math.max(retryAfterMs(error), 60000);
                    officialApiRateLimitedUntil = Math.max(officialApiRateLimitedUntil, Date.now() + waitMs);
                    console.warn('⏳ [Official API Events] HTTP 429 | พักการเรียก API ' + Math.ceil(waitMs / 1000) + ' วินาที');
                }
                officialEventCache.set(targetGuildId, {
                    valid: false, ids: [],
                    expiresAt: Math.max(Date.now() + 5000, officialApiRateLimitedUntil || 0)
                });
                return { valid: false, ids: [] };
            }
        })();
        officialEventInFlight.set(targetGuildId, task);
        try {
            return await task;
        } finally {
            if (officialEventInFlight.get(targetGuildId) === task) officialEventInFlight.delete(targetGuildId);
        }
    };

    const fetchOfficial = async ({ silentSource = false } = {}) => {
        const publishSource = source => { if (!silentSource) setSource(source); };
        const now = Date.now();
        const cached = officialCache.get(targetGuildId);
        if (cached && cached.expiresAt > now) {
            publishSource('Official Albion API (cache)');
            return Array.isArray(cached.ids) ? [...cached.ids] : null;
        }
        if (officialInFlight.has(targetGuildId)) {
            const result = await officialInFlight.get(targetGuildId);
            publishSource('Official Albion API (shared request)');
            return result;
        }
        if (officialApiRateLimitedUntil > now) {
            publishSource('Official Albion API (พักตาม Rate Limit)');
            return null;
        }
        const task = (async () => {
            let sawValidResponse = false;
            let lastDetail = 'ไม่ทราบสาเหตุ';
            let bestPartialIds = [];
            const urls = [
                'https://gameinfo-sgp.albiononline.com/api/gameinfo/battles',
                'https://gameinfo.albiononline.com/api/gameinfo/battles'
            ];
            for (const url of urls) {
                const endpointIds = new Set();
                let endpointHadResponse = false;
                let endpointHadError = false;
                const endpointName = url.includes('gameinfo-sgp') ? 'Asia' : 'Global';
                for (const offset of [0, 51]) {
                    try {
                        const response = await axios.get(url, {
                            timeout: 10000,
                            headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
                            // Keep bounded pagination; this code deliberately requests only the recent two pages.
                            params: { offset, limit: 51, sort: 'recent', guildId: targetGuildId }
                        });
                        if (!Array.isArray(response.data)) {
                            lastDetail = 'รูปแบบข้อมูลไม่ถูกต้อง';
                            endpointHadError = true;
                            console.warn('⚠️ [Official API หลัก] Endpoint=' + endpointName +
                                ' | offset=' + offset + ' | รูปแบบข้อมูลไม่ถูกต้อง | จะลอง Official endpoint ถัดไป');
                            break;
                        }
                        sawValidResponse = true;
                        endpointHadResponse = true;
                        for (const row of response.data) {
                            const id = row?.id ?? row?.albionId ?? row?.battleId;
                            if (/^\d+$/.test(String(id))) endpointIds.add(String(id));
                        }
                        console.log('ℹ️ [Official API หลัก] Endpoint=' + endpointName +
                            ' | offset=' + offset + ' | ได้ ' + response.data.length + ' รายการ');
                        if (response.data.length < 51) break;
                    } catch (error) {
                        endpointHadError = true;
                        const status = error?.response?.status || error?.statusCode;
                        const responseBody = error?.response?.data;
                        const responseDetail = responseBody == null ? '' :
                            (typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody))
                                .replace(/https?:\/\/\S+/gi, '[URL]').replace(/\s+/g, ' ').slice(0, 180);
                        lastDetail = (status ? 'HTTP ' + status : String(error?.code || error?.message || 'request failed')) +
                            (responseDetail ? ' | API=' + responseDetail : '');
                        console.warn('⚠️ [Official API หลัก] Endpoint=' + endpointName +
                            ' | offset=' + offset + ' | กิลด์=' + (targetGuild || '-') +
                            ' | Guild ID=' + targetGuildId + ' | สาเหตุ=' + lastDetail);
                        if (Number(status) === 429) {
                            const waitMs = Math.max(retryAfterMs(error), 60000);
                            officialApiRateLimitedUntil = Math.max(officialApiRateLimitedUntil, Date.now() + waitMs);
                            console.warn('⏳ [Official API หลัก] HTTP 429 | พักการเรียก API ' + Math.ceil(waitMs / 1000) + ' วินาที');
                        }
                        break;
                    }
                }

                const endpointIdsArray = [...endpointIds];
                // Keep the largest partial list seen so far. This lets a successful alternate
                // endpoint repair an incomplete page without throwing away useful IDs.
                if (endpointIdsArray.length > bestPartialIds.length) bestPartialIds = endpointIdsArray;

                if (endpointHadError) {
                    if (officialApiRateLimitedUntil > Date.now()) break; // Respect 429; do not immediately try another host.
                    console.warn('⚠️ [Official API หลัก] Endpoint=' + endpointName +
                        ' ส่งข้อมูลไม่ครบ/ล้มเหลว; กำลังลอง Official endpoint ถัดไป' +
                        (endpointIdsArray.length ? ' | เก็บ partial IDs=' + endpointIdsArray.length : ''));
                    continue;
                }

                if (endpointHadResponse) {
                    const finalIds = bestPartialIds.length > endpointIdsArray.length ? bestPartialIds : endpointIdsArray;
                    officialCache.set(targetGuildId, { ids: finalIds, expiresAt: Date.now() + 45000 });
                    while (officialCache.size > 100) officialCache.delete(officialCache.keys().next().value);
                    publishSource(finalIds.length ? 'Official Albion API' : 'Official Albion API (ไม่พบไฟต์)');
                    console.log('✅ [Official API หลัก] รวม ' + finalIds.length +
                        ' Match ID | Endpoint ที่ตอบสำเร็จ=' + endpointName +
                        (bestPartialIds.length > endpointIdsArray.length ? ' | ใช้รายการ partial ที่มีมากกว่า' : '') +
                        ' | สูงสุด 2 หน้า | กิลด์ ' + (targetGuild || targetGuildId));
                    return finalIds;
                }
                if (officialApiRateLimitedUntil > Date.now()) break;
            }

            if (bestPartialIds.length) {
                officialCache.set(targetGuildId, { ids: bestPartialIds, expiresAt: Date.now() + 15000 });
                while (officialCache.size > 100) officialCache.delete(officialCache.keys().next().value);
                publishSource('Official Albion API (partial)');
                console.warn('⚠️ [Official API หลัก] ใช้ Partial Match IDs=' + bestPartialIds.length +
                    ' | ไม่ทิ้งไฟต์ที่ค้นพบแล้ว แม้หน้า/Endpoint ถัดไปล้มเหลว');
                return bestPartialIds;
            }

            officialCache.set(targetGuildId, {
                ids: null,
                expiresAt: Math.max(Date.now() + 10000, officialApiRateLimitedUntil || 0)
            });
            publishSource('Official Albion API unavailable');
            console.warn('⚠️ [Official API หลัก] ค้นหาไฟต์ไม่สำเร็จ | กิลด์=' + (targetGuild || targetGuildId) +
                ' | สาเหตุ=' + lastDetail + (sawValidResponse ? ' | มี response บางหน้าแต่ไม่มี Match ID ที่ใช้ได้' : ''));
            return null;
        })();
        officialInFlight.set(targetGuildId, task);
        try {
            return await task;
        } finally {
            if (officialInFlight.get(targetGuildId) === task) officialInFlight.delete(targetGuildId);
        }
    };

    // Run both Official discovery paths concurrently. Normal polling can return
    // immediately when /events exposes a new BattleId; the /battles request continues
    // in the background to refresh its cache for coverage on later polls.
    const eventPromise = fetchRecentEventBattleIds();
    const officialPromise = fetchOfficial({ silentSource: true }).catch(error => {
        console.warn('⚠️ [Official API หลัก] การค้นหา Battle List ล้มเหลว: ' + String(error?.message || error));
        return null;
    });
    const eventResult = await eventPromise;
    const eventIds = eventResult?.valid && Array.isArray(eventResult.ids) ? eventResult.ids : [];

    if (!baselineOnly && eventIds.length) {
        const cachedBattleList = officialCache.get(targetGuildId);
        const cachedBattleIds = cachedBattleList && cachedBattleList.expiresAt > Date.now() &&
            Array.isArray(cachedBattleList.ids) ? cachedBattleList.ids : [];
        const combinedIds = [...new Set([...eventIds, ...cachedBattleIds])];
        const source = 'Official GameInfo Events (early detection)';
        setSource(source);
        console.log('🚀 [Auto-Battle Early Detection] Guild=' + (targetGuild || targetGuildId) +
            ' | Battle IDs จาก Events=' + eventIds.length +
            ' | IDs จาก Battle List cache=' + cachedBattleIds.length +
            ' | ส่ง candidates เข้าคิวโดยไม่รอ Battle List request');
        return queueCandidates(combinedIds, source);
    }

    const officialIds = await officialPromise;
    if (Array.isArray(officialIds)) {
        const combinedIds = [...new Set([...officialIds, ...eventIds])];
        const source = eventIds.length
            ? 'Official Albion Events + Battle List'
            : (officialIds.length ? 'Official Albion API PRIMARY' : 'Official Albion API PRIMARY (ไม่พบไฟต์ที่ตรงกิลด์)');
        setSource(source);
        return queueCandidates(combinedIds, source);
    }

    if (eventResult?.valid) {
        const source = eventIds.length
            ? 'Official Albion Events (Battle List unavailable)'
            : 'Official Albion Events available; no Battle ID in recent events';
        setSource(source);
        if (eventIds.length) console.warn('⚠️ [Auto-Battle] ใช้ Battle ID จาก Events เพราะ Battle List ใช้งานไม่ได้');
        return queueCandidates(eventIds, source);
    }

    const source = 'Official Albion API unavailable';
    setSource(source);
    console.warn('⚠️ [Auto-Battle] Official Albion GameInfo API ใช้งานไม่ได้; รอบนี้จะไม่เรียกแหล่งข้อมูลอื่น และจะตรวจใหม่ในรอบถัดไป');
    return baselineOnly ? null : queueCandidates([], source);
}

async function primeAutoBattleHistoryForGuild(configs = autoBattleConfigs) {
    // Initialize a baseline only once per tracker. On restart, keep the prior
    // baseline so battles that appeared during downtime remain eligible to report.
    let added = 0;
    let changed = false;
    const hadHistoricalProcessedIds = processedBattles.size > 0;
    for (const config of configs) {
        if (!config || config.baselineInitialized === true) continue;

        // Existing configs from older versions had no marker. If persisted
        // processed IDs exist, preserve their history instead of re-baselining
        // and accidentally swallowing fights that happened while the bot was down.
        if (typeof config.baselineInitialized !== 'boolean' && hadHistoricalProcessedIds) {
            config.baselineInitialized = true;
            changed = true;
            console.log('ℹ️ Auto-Battle legacy baseline state preserved for ' +
                String(config.targetGuild || config.targetGuildId || 'unknown') +
                '; existing processed Match IDs found, skipping restart baseline.');
            continue;
        }
        if (typeof config.baselineInitialized !== 'boolean') {
            // Persist the pending state before requesting data, so later retries
            // cannot mistake a failed first baseline for a legacy initialized tracker.
            config.baselineInitialized = false;
            changed = true;
        }

        try {
            const recentMatches = await fetchGuildRecentBattles(config, { baselineOnly: true });
            if (!Array.isArray(recentMatches)) {
                console.warn('⚠️ Auto-Battle baseline pending for ' +
                    String(config.targetGuild || config.targetGuildId || 'unknown') +
                    '; Official API unavailable, will retry without marking the tracker initialized.');
                continue;
            }
            for (const id of recentMatches) {
                const key = String(id || '').trim();
                if (/^\d+$/.test(key) && !processedBattles.has(key)) {
                    processedBattles.add(key);
                    added++;
                }
            }
            config.baselineInitialized = true;
            changed = true;
            console.log('✅ Auto-Battle baseline initialized for ' +
                String(config.targetGuild || config.targetGuildId || 'unknown') +
                ': marked ' + recentMatches.length + ' existing battle(s) as already seen.');
        } catch (err) {
            console.warn('⚠️ Auto-Battle baseline failed for ' +
                String(config.targetGuild || config.targetGuildId || 'unknown') + ': ' +
                String(err?.message || err));
        }
    }

    if (processedBattles.size > 1000) {
        processedBattles = new Set([...processedBattles].slice(-1000));
        changed = true;
    }
    if (added > 0 || changed) saveData();
    return added;
}

async function checkAutoBattles() {
    checkAutoBattles._detailLookupBudget = { used: 0, limit: 25, startedAt: Date.now() };
    const guilds = getAllGuildConfigs();
    for (const { guildId } of guilds) {
        await guildContext.run({ guildId }, async () => {
            await checkAutoBattlesForGuild();
        });
    }
}

function scheduleAutoBattleDetailRetry(matchId, reason) {
    const retryStates = checkAutoBattlesForGuild._detailRetryStates ||
        (checkAutoBattlesForGuild._detailRetryStates = new Map());
    const key = String(matchId);
    const previous = retryStates.get(key) || { attempts: 0, hourlyRetry: false };
    const attempts = Math.min(8, (Number(previous.attempts) || 0) + 1);
    const delays = [60000, 120000, 300000, 600000, 900000, 900000, 900000];
    const hourlyRetry = previous.hourlyRetry === true || attempts >= 8;
    const waitMs = hourlyRetry ? 60 * 60 * 1000 : delays[Math.min(attempts - 1, delays.length - 1)];
    retryStates.delete(key);
    retryStates.set(key, { attempts, nextRetryAt: Date.now() + waitMs, hourlyRetry });
    while (retryStates.size > 1000) retryStates.delete(retryStates.keys().next().value);
    console.warn('⚠️ [Auto-Battle Retry] Match ID=' + key + ' | ' + String(reason || 'ยังดึงรายละเอียดไม่ได้') +
        ' | ครั้งที่ ' + attempts + '/8' +
        (hourlyRetry ? ' | ครบ 8 ครั้งแล้ว จะลองใหม่ทุก 60 นาที' : ' | ลองใหม่ใน ' + Math.ceil(waitMs / 60000) + ' นาที') + '.');
}

async function checkAutoBattlesForGuild() {
    if (!autoBattleConfigs.length) return;
    if (autoBattleCheckRunning) return;

    autoBattleCheckRunning = true;
    try {
        for (const config of autoBattleConfigs) {
            try {
            const trackerScope = getGuildConfig(config.guildId, false);
            const autoTrackedGuilds = Array.isArray(trackerScope?.guilds)
                ? trackerScope.guilds.map(g => typeof g === 'string' ? g : g?.name).filter(Boolean)
                : [];
            const autoTrackedPlayers = Array.isArray(trackerScope?.players)
                ? trackerScope.players
                : [];
            const missingTrackingScopeKey = String(config.guildId || '') + ':' + String(config.targetGuildId || config.targetGuild || '');
            const missingScopeWarnings = checkAutoBattlesForGuild._missingTrackingScopeWarnings ||
                (checkAutoBattlesForGuild._missingTrackingScopeWarnings = new Set());
            if (!autoTrackedPlayers.length && !autoTrackedGuilds.length) {
                if (!missingScopeWarnings.has(missingTrackingScopeKey)) {
                    console.warn('⚠️ [Auto-Battle] ยังไม่มี /add player หรือ /add guild สำหรับเซิร์ฟเวอร์นี้; งดประมวลผล Match ID เพื่อไม่ให้ตีความ Fame=0 ผิด | กิลด์ต้นทาง=' + String(config.targetGuild || config.targetGuildId));
                    missingScopeWarnings.add(missingTrackingScopeKey);
                }
                continue;
            }
            missingScopeWarnings.delete(missingTrackingScopeKey);

            if (config.baselineInitialized !== true) {
                // Never process this tracker until a valid baseline has been stored.
                // If the API is unavailable, the next scheduled poll retries initialization.
                await primeAutoBattleHistoryForGuild([config]);
                continue;
            }

            const recentMatches = await fetchGuildRecentBattles(config);
            if (!Array.isArray(recentMatches) || !recentMatches.length) continue;
            const battleListObservedAt = Date.now();
            const candidateMeta = new Map();
            const pendingQueueScopeKey = getAutoBattleQueueScopeKey(config);
            for (const idValue of recentMatches) {
                const id = String(idValue || '');
                if (!/^\d+$/.test(id) || candidateMeta.has(id)) continue;
                const queued = fetchGuildRecentBattles._pendingMatchIds?.get(pendingQueueScopeKey)?.get(id);
                candidateMeta.set(id, {
                    firstSeenAt: Number(queued?.firstSeenAt) || battleListObservedAt,
                    source: fetchGuildRecentBattles._lastSourceByScope?.get(pendingQueueScopeKey) || 'Official GameInfo Battle List'
                });
            }
            const detailRetryStates = checkAutoBattlesForGuild._detailRetryStates ||
                (checkAutoBattlesForGuild._detailRetryStates = new Map());
            const retryCheckAt = Date.now();
            const newMatchIds = [...candidateMeta.keys()]
                .filter(id => !processedBattles.has(String(id)))
                .filter(id => (detailRetryStates.get(String(id))?.nextRetryAt || 0) <= retryCheckAt)
                .sort((a, b) => candidateMeta.get(String(a)).firstSeenAt - candidateMeta.get(String(b)).firstSeenAt);
            if (!newMatchIds.length) continue;

            // Prefetch at most five battle details concurrently. Report rendering/sending remains
            // sequential so images from separate fights cannot interleave.
            const prefetchBudget = checkAutoBattles._detailLookupBudget ||
                (checkAutoBattles._detailLookupBudget = { used: 0, limit: 25, startedAt: Date.now() });
            const prefetchedBattleDetails = new Map();
            const prefetchedBattleFetchMs = new Map();
            const prefetchIds = newMatchIds.slice(0, Math.min(25, newMatchIds.length));
            let prefetchCursor = 0;
            const prefetchWorker = async () => {
                while (true) {
                    const index = prefetchCursor++;
                    if (index >= prefetchIds.length) return;
                    const matchId = String(prefetchIds[index]);
                    const cacheEntry = fetchOfficialBattle._autoBattleDetailCache?.get(matchId);
                    const hasCached = Boolean(cacheEntry && cacheEntry.expiresAt > Date.now());
                    const failedUntil = battleFetchFailureUntil.get('autoBattle:' + matchId) || 0;
                    const inFlight = battleFetchInFlight.has('autoBattle:' + matchId);
                    const needsRequest = !hasCached && !inFlight && failedUntil <= Date.now() &&
                        officialApiRateLimitedUntil <= Date.now();
                    if (needsRequest && prefetchBudget.used >= prefetchBudget.limit) {
                        console.log('⏸️ [Auto-Battle] ใช้โควตา Battle Detail ครบ ' + prefetchBudget.limit +
                            ' Match ID ในรอบนี้แล้ว; เก็บรายการที่เหลือไว้ตรวจรอบถัดไป');
                        return;
                    }
                    if (needsRequest) prefetchBudget.used++;
                    const detailStartedAt = Date.now();
                    const detail = await fetchOfficialBattle(matchId, { autoBattle: true });
                    prefetchedBattleDetails.set(matchId, detail);
                    prefetchedBattleFetchMs.set(matchId, Date.now() - detailStartedAt);
                }
            };
            await Promise.all(Array.from(
                { length: Math.min(5, prefetchIds.length) },
                () => prefetchWorker()
            ));

            // Process distinct Match IDs from both sources; the shared set prevents a second report.
            for (const latestMatchId of newMatchIds.slice(0, 1000)) {
                const candidateMetaForId = candidateMeta.get(String(latestMatchId)) || { firstSeenAt: battleListObservedAt, source: 'Official GameInfo Battle API' };
                const battleListFirstSeenAt = candidateMetaForId.firstSeenAt;
                const detectionSource = candidateMetaForId.source;
                const battleProcessingStartedAt = Date.now();
                let battleDetailFetchMs = null;
                try {
                    const detailKey = String(latestMatchId);
                    const detailCacheEntry = fetchOfficialBattle._autoBattleDetailCache?.get(detailKey);
                    const hasCachedDetail = Boolean(detailCacheEntry && detailCacheEntry.expiresAt > Date.now());
                    const failureUntil = battleFetchFailureUntil.get('autoBattle:' + detailKey) || 0;
                    const hasInFlightDetail = battleFetchInFlight.has('autoBattle:' + detailKey);
                    const willIssueDetailRequest = !hasCachedDetail && !hasInFlightDetail && failureUntil <= Date.now() && officialApiRateLimitedUntil <= Date.now();
                    const detailBudget = checkAutoBattles._detailLookupBudget || (checkAutoBattles._detailLookupBudget = { used: 0, limit: 25, startedAt: Date.now() });
                    const hasPrefetchedDetail = prefetchedBattleDetails.has(detailKey);
                    if (willIssueDetailRequest && !hasPrefetchedDetail && detailBudget.used >= detailBudget.limit) {
                        console.log('⏸️ [Auto-Battle] ใช้โควตา Battle Detail ครบ ' + detailBudget.limit + ' Match ID ในรอบนี้แล้ว; เก็บรายการที่เหลือไว้ตรวจรอบถัดไป');
                        break;
                    }
                    if (willIssueDetailRequest && !hasPrefetchedDetail) detailBudget.used++;
                    const officialBattle = hasPrefetchedDetail
                        ? prefetchedBattleDetails.get(detailKey)
                        : await fetchOfficialBattle(latestMatchId, { autoBattle: true });
                    battleDetailFetchMs = hasPrefetchedDetail
                        ? (prefetchedBattleFetchMs.get(detailKey) ?? Date.now() - battleProcessingStartedAt)
                        : Date.now() - battleProcessingStartedAt;
                if (!officialBattle) {
                    scheduleAutoBattleDetailRetry(latestMatchId, 'Official GameInfo ทั้ง Asia/Global ยังไม่มีรายละเอียดหรือ API ตอบไม่สำเร็จ');
                    console.warn('⚠️ ยังดึงข้อมูล Battle ' + latestMatchId + ' ไม่สำเร็จ; ยังไม่ทำเครื่องหมายว่าเสร็จ | detailFetch=' + battleDetailFetchMs + 'ms | firstSeenAt=' + new Date(battleListFirstSeenAt).toISOString());
                    continue;
                }

                // Auto-Battle must report recent fights only. Some source pages can
                // still return battles from several days ago after restarts or outages.
                // Skip and persist stale IDs so the same historical fight is not retried
                // and incorrectly announced on every poll.
                const rawBattleTime = officialBattle.startTime || officialBattle.startedAt || officialBattle.started_at || officialBattle.start_time || officialBattle.timestamp || officialBattle.start || officialBattle.battleDate || officialBattle.date || null;
                let battleTimeMs = null;
                if (rawBattleTime !== null && rawBattleTime !== undefined) {
                    const timeText = String(rawBattleTime).trim();
                    const numericTime = /^\d{10,13}$/.test(timeText) ? Number(timeText) : NaN;
                    if (Number.isFinite(numericTime)) {
                        battleTimeMs = numericTime < 1e12 ? numericTime * 1000 : numericTime;
                    } else {
                        const parsedTime = Date.parse(timeText);
                        if (Number.isFinite(parsedTime)) battleTimeMs = parsedTime;
                    }
                }
                const battleAgeAtFirstDetectionSec = Number.isFinite(battleTimeMs) && battleTimeMs > 0
                    ? Math.max(0, Math.floor((battleListFirstSeenAt - battleTimeMs) / 1000))
                    : null;
                console.log('⏱️ [Auto-Battle Latency] Guild=' + String(config.targetGuild || config.targetGuildId) +
                    ' MatchID=' + latestMatchId +
                    ' | เวลาที่พบ Match ID=' + new Date(battleListFirstSeenAt).toISOString() +
                    ' | เวลาเริ่มไฟต์=' + (Number.isFinite(battleTimeMs) && battleTimeMs > 0 ? new Date(battleTimeMs).toISOString() : 'unknown') +
                    ' | อายุไฟต์ตอนตรวจพบ=' + (battleAgeAtFirstDetectionSec === null ? 'unknown' : Math.floor(battleAgeAtFirstDetectionSec / 60) + 'm ' + (battleAgeAtFirstDetectionSec % 60) + 's') +
                    ' | เวลาดึงรายละเอียด Battle=' + (battleDetailFetchMs === null ? 'unknown' : battleDetailFetchMs + 'ms') + '.');
                const maxAutoBattleAgeMs = 24 * 60 * 60 * 1000;
                if (Number.isFinite(battleTimeMs) && battleTimeMs > 0 &&
                    Date.now() - battleTimeMs > maxAutoBattleAgeMs) {
                    processedBattles.add(String(latestMatchId));
                    detailRetryStates.delete(String(latestMatchId));
                    saveData();
                    const ageHours = Math.floor((Date.now() - battleTimeMs) / (60 * 60 * 1000));
                    console.log(`⏭️ Skip stale Auto-Battle Match ID ${latestMatchId} for ${config.targetGuild}: battle is ${ageHours}h old (limit 24h); marked as handled.`);
                    continue;
                }

                const officialGuildNames = officialBattle.guilds
                    ? Object.values(officialBattle.guilds).map(g => g?.name).filter(Boolean)
                    : [];

                if (config.targetGuild && !officialGuildNames.length) {
                    scheduleAutoBattleDetailRetry(latestMatchId, 'Official Battle Detail ไม่มีรายชื่อ Guild; อาจเป็นข้อมูลยังไม่ครบ');
                    console.warn('⚠️ [Auto-Battle] Match ID=' + latestMatchId + ' ไม่มีข้อมูล Guild จาก Official API; ยังไม่ mark handled และจะลองใหม่ตาม backoff');
                    continue;
                }

                if (config.targetGuild && !isExactGuildMatch(config.targetGuild, officialGuildNames)) {
                    const matchesAnyTrackedTarget = autoBattleConfigs.some(trackedConfig =>
                        Boolean(String(trackedConfig?.targetGuild || '').trim()) &&
                        isExactGuildMatch(String(trackedConfig.targetGuild), officialGuildNames)
                    );
                    if (!matchesAnyTrackedTarget) {
                        processedBattles.add(String(latestMatchId));
                        detailRetryStates.delete(String(latestMatchId));
                        saveData();
                        console.log('⏭️ Skip Match ' + latestMatchId + ': ไม่มีกิลด์ตรงกับ Auto-Battle Tracker ที่ตั้งค่าไว้; ทำเครื่องหมายว่าตรวจแล้ว');
                    } else detailRetryStates.delete(String(latestMatchId));
                    continue;
                }

                const result = await buildBattleReportPayload(
                    latestMatchId,
                    [], // Auto-Battle source guild is not a tracking scope.
                    {
                        autoBattle: true,
                        guildId: config.guildId,
                        apiData: officialBattle,
                        trackedPlayers: autoTrackedPlayers,
                        trackedGuilds: autoTrackedGuilds
                    }
                );
                // Clear retry state only after Official details and the tracked roster are usable.
                detailRetryStates.delete(String(latestMatchId));
                const checkValue = config.minFrames;
                const officialPlayerCountForLog = getApiPlayers(officialBattle).length;
                // min_frames is the minimum total Fame from tracked players/
                // tracked guild members. Kills and Deaths are report statistics.
                if (result.totalFame >= checkValue) {
                    const channel = await client.channels.fetch(config.channelId).catch(() => null);
                    if (!channel || typeof channel.send !== 'function') {
                        console.warn(`⚠️ Auto-Battle channel unavailable for Match ID ${latestMatchId}; will retry next poll.`);
                        continue;
                    }
                    const alertText =
                        `🚨 **Auto-Battle Alert!** ตรวจพบไฟต์ใหม่ของกิลด์ **${config.targetGuild}**\n` +
                        `💰 Fame รวมของผู้ที่ติดตาม: \`${formatFame(result.totalFame)}\`\n` +
                        `⚔️ Kills: \`${Number(result.totalKills).toLocaleString()}\`\n` +
                        `☠️ Deaths: \`${Number(result.totalDeaths).toLocaleString()}\`\n` +
                        `➕ Kills + Deaths: \`${(Number(result.totalKills) + Number(result.totalDeaths)).toLocaleString()}\`\n` +
                        `🔗 Battle Link: <${result.battleUrl}>`;
                    const reportFiles = Array.isArray(result.payload.files) ? result.payload.files : [];
                    if (reportFiles.length > 0) {
                        // Discord displays multiple image attachments side-by-side in one message.
                        // Send each report image in its own message so they stack vertically.
                        await channel.send({ content: alertText, files: [reportFiles[0]] });
                        for (const reportFile of reportFiles.slice(1)) {
                            await channel.send({ files: [reportFile] });
                        }
                    } else {
                        await channel.send({ content: alertText + '\n' + (result.payload.content || '') });
                    }
                    let delayText = '';
                    if (Number.isFinite(battleTimeMs) && battleTimeMs > 0) {
                        const sentAtMs = Date.now();
                        const diffSec = Math.max(0, Math.floor((sentAtMs - battleTimeMs) / 1000));
                        const mins = Math.floor(diffSec / 60);
                        const secs = diffSec % 60;
                        delayText = ' | ⏱️ ดีเลย์รวมตั้งแต่เริ่มไฟต์จนส่งรายงาน=' + mins + 'นาที ' + secs + 'วิ' +
                            ' (เวลาเริ่มไฟต์=' + new Date(battleTimeMs).toISOString() + ')';
                        if (mins >= 10) delayText += ' ⚠️ ช้า';
                    } else {
                        delayText = ' | ⏱️ ดีเลย์รวมตั้งแต่เริ่มไฟต์จนส่งรายงาน=ไม่ทราบ (Official API ไม่มีเวลาเริ่มไฟต์)';
                    }

                    console.log('✅ ส่งรายงาน Auto-Battle สำเร็จ | Match ID=' + latestMatchId +
                        ' | ห้อง=' + config.channelId +
                        ' | แหล่งที่พบก่อน=' + detectionSource +
                        ' | เวลาจากพบ Match ID จนส่งรายงาน=' + Math.max(0, Date.now() - battleListFirstSeenAt) + 'ms' +
                        ' | detailFetch=' + (battleDetailFetchMs === null ? 'unknown' : battleDetailFetchMs + 'ms') +
                        delayText + '.');
                } else {
                    const decisionAt = Date.now();
                    const ageAtDecisionSec = Number.isFinite(battleTimeMs) && battleTimeMs > 0
                        ? Math.max(0, Math.floor((decisionAt - battleTimeMs) / 1000))
                        : null;
                    console.log('ℹ️ [Auto-Battle Latency] MatchID=' + latestMatchId +
                        ' | ผลลัพธ์=เฟมต่ำกว่าเกณฑ์' +
                        ' | Fame=' + formatFame(result.totalFame) +
                        ' | เกณฑ์=' + formatFame(checkValue) +
                        ' | ผู้เล่นใน Official Detail=' + officialPlayerCountForLog +
                        ' | ผู้เล่นที่ติดตาม=' + autoTrackedPlayers.length +
                        ' | กิลด์ที่ติดตาม=' + autoTrackedGuilds.length +
                        ' | แถวตรงเงื่อนไข=' + (Array.isArray(result.playerReportData) ? result.playerReportData.length : 0) +
                        ' | อายุไฟต์ตอนตัดสินใจ=' + (ageAtDecisionSec === null ? 'unknown' : Math.floor(ageAtDecisionSec / 60) + 'm ' + (ageAtDecisionSec % 60) + 's') +
                        ' | เวลาประมวลผลหลังพบครั้งแรก=' + Math.max(0, decisionAt - battleListFirstSeenAt) + 'ms; marking handled after validated detail.');
                }
                processedBattles.add(String(latestMatchId));
                saveData();                } catch (e) {
                    scheduleAutoBattleDetailRetry(latestMatchId, 'ประมวลผลข้อมูล Battle ไม่สำเร็จ: ' + String(e?.message || e));
                    console.error('❌ Auto-Battle Error on Match ID ' + latestMatchId + ' for guild ' + config.targetGuild + ':', e.message);
                }
            }

            if (processedBattles.size > 1000) {
                processedBattles = new Set([...processedBattles].slice(-1000));
            }
            } catch (trackerErr) {
                console.error('❌ [Auto-Battle Tracker] ข้าม Tracker ที่มีข้อผิดพลาด โดยตรวจ Tracker ถัดไปต่อ | Discord Server=' +
                    String(config?.guildId || 'unknown') + ' | Guild=' +
                    String(config?.targetGuild || config?.targetGuildId || 'unknown') + ' | Error=' +
                    String(trackerErr?.message || trackerErr));
            }
        }
    } catch (err) {
        console.error('❌ Auto-Battle background polling error:', err.message);
    } finally {
        autoBattleCheckRunning = false;
    }
}

// ----------------------------------------
// AVALON (AVA) MAP CHECK
// Source: Albion Battle Hub map pages.
// Returns Thai summary + map image URL.
// ----------------------------------------
const AVA_MAP_SOURCE = 'https://albionbattlehub.com/en/avalon-maps/';
const AVA_MAP_SOURCE_TH = 'https://albionbattlehub.com/th/avalon-maps/';

const AVA_LABELS_TH = {
    'Green chest': 'เขียว',
    'Blue chest': 'น้ำเงิน',
    'Gold chest': 'ทอง',
    'Stone': 'หินใหญ่',
    'Wood': 'ไม้',
    'Ore': 'แร่',
    'Hide': 'หนัง',
    'Fiber': 'เส้นใย',
    'Solo dungeon': 'ดันเดี่ยว',
    'Group dungeon': 'ดันกลุ่ม'
};

function normalizeAvaSlug(input) {
    const raw = String(input || '').trim();
    if (!raw) throw new Error('กรุณาระบุชื่อแมพ AVA');

    const urlMatch = raw.match(/albionbattlehub\.com\/(?:en|th)\/avalon-maps\/([^/?#]+)/i);
    if (urlMatch) return decodeURIComponent(urlMatch[1]).toLowerCase();

    return raw
        .replace(/\bT(?:ier)?\s*[45678]\b/ig, '')
        .trim()
        .replace(/\s+/g, '-')
        .replace(/[^a-zA-Z0-9_-]/g, '')
        .toLowerCase();
}

function extractAvaCount(bodyText, label) {
    const aliases = {
        'Green chest': ['Green chest', 'Green chests', 'หีบเขียว'],
        'Blue chest': ['Blue chest', 'Blue chests', 'หีบน้ำเงิน'],
        'Gold chest': ['Gold chest', 'Gold chests', 'หีบทอง'],
        Stone: ['Stone', 'Rock', 'หินใหญ่', 'หิน'],
        Wood: ['Wood', 'ไม้'],
        Ore: ['Ore', 'แร่'],
        Hide: ['Hide', 'หนัง'],
        Fiber: ['Fiber', 'เส้นใย'],
        'Solo dungeon': ['Solo dungeon', 'Solo dungeons', 'ดันเจี้ยนเดี่ยว', 'ดันเดี่ยว'],
        'Group dungeon': ['Group dungeon', 'Group dungeons', 'ดันเจี้ยนกลุ่ม', 'ดันกลุ่ม']
    };
    const candidates = aliases[label] || [label];
    const escapeRegExp = value => value.replace(/[.*+?^()|[\]\\]/g, '\\$&');
    const text = String(bodyText || '');
    for (const candidate of candidates) {
        const escaped = escapeRegExp(candidate);
        const patterns = [
            new RegExp(escaped + '\\s*(?:[×x*:]\\s*)?(\\d+)\\b', 'i'),
            new RegExp('(\\d+)\\s*[×x*]?\\s*' + escaped + '\\b', 'i')
        ];
        for (const re of patterns) {
            const match = text.match(re);
            if (match) return Number(match[1]) || 0;
        }
    }
    return 0;
}

function extractAvaConnection(html, bodyText) {
    const source = `${html}\n${bodyText}`;
    const m = source.match(/\b(TUNNEL_(?:LOW|MEDIUM|HIGH|DEEP(?:_RAID)?|HIDEOUT(?:_DEEP)?))\b/i);
    if (!m) return null;
    return m[1].toUpperCase()
        .replace(/^TUNNEL_/, '')
        .replace(/_DEEP_RAID$/, ' DEEP RAID')
        .replace(/_DEEP$/, ' DEEP')
        .replace(/_HIDEOUT_DEEP$/, ' HIDEOUT DEEP')
        .replace(/_HIDEOUT$/, ' HIDEOUT')
        .replace(/_MEDIUM$/, ' MEDIUM')
        .replace(/_HIGH$/, ' HIGH')
        .replace(/_LOW$/, ' LOW')
        .replace(/\bMEDIUM\b/, 'MEDIUM');
}

function formatAvaConnection(connection) {
    if (!connection) return 'ไม่พบข้อมูล';
    const map = {
        LOW: 'Tunnel Low',
        MEDIUM: 'Tunnel Medium',
        HIGH: 'Tunnel High',
        DEEP: 'Tunnel Deep',
        'DEEP RAID': 'Tunnel Deep Raid',
        HIDEOUT: 'Tunnel Hideout',
        'HIDEOUT DEEP': 'Tunnel Hideout Deep',
        ROYAL: 'Tunnel Royal'
    };
    return map[connection] || `Tunnel ${connection}`;
}

function normalizeAvaDataTotals(data) {
    const c = data?.counts || {};
    const counts = {
        'Gold chest': Number(c['Gold chest']) || 0,
        'Blue chest': Number(c['Blue chest']) || 0,
        'Green chest': Number(c['Green chest']) || 0,
        'Group dungeon': Number(c['Group dungeon']) || 0,
        'Solo dungeon': Number(c['Solo dungeon']) || 0,
        Wood: Number(c.Wood) || 0, Ore: Number(c.Ore) || 0,
        Stone: Number(c.Stone) || 0, Hide: Number(c.Hide) || 0, Fiber: Number(c.Fiber) || 0
    };
    return {
        ...data, counts,
        totalChests: counts['Gold chest'] + counts['Blue chest'] + counts['Green chest'],
        totalResources: counts.Wood + counts.Ore + counts.Stone + counts.Hide + counts.Fiber,
        totalDungeons: counts['Group dungeon'] + counts['Solo dungeon']
    };
}

function avaDataPointCount(data) {
    const d = normalizeAvaDataTotals(data);
    return d.totalChests + d.totalResources + d.totalDungeons;
}

async function fetchAvaMapData(input) {
    const slug = normalizeAvaSlug(input);
    const urls = [
        `${AVA_MAP_SOURCE_TH}${encodeURIComponent(slug)}`,
        `${AVA_MAP_SOURCE}${encodeURIComponent(slug)}`
    ];

    let lastError = null;
    for (const url of urls) {
        try {
            const response = await axios.get(url, {
                timeout: 15000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; AlbionAssistant/1.0)',
                    'Accept': 'text/html,application/xhtml+xml'
                },
                validateStatus: status => status >= 200 && status < 400
            });

            const html = String(response.data || '');
            const $ = cheerio.load(html);
            const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
            // POI names are in image alt text; pair them with adjacent list counts.
            const poiTextParts = [];
            $('li').each((_, element) => {
                const item = $(element);
                const alts = item.find('img').map((__, img) => {
                    const node = $(img);
                    return node.attr('alt') || node.attr('title') || '';
                }).get().filter(Boolean).join(' ').replace(/\bImage\s*/gi, '');
                const itemText = item.text().replace(/\s+/g, ' ').trim();
                if (alts || itemText) poiTextParts.push(alts + ' ' + itemText);
            });
            const imageMetaText = $('img').map((_, el) => {
                const node = $(el);
                return [node.attr('alt'), node.attr('title'), node.attr('aria-label'), node.attr('data-label')].filter(Boolean).join(' ');
            }).get().join(' ');
            const scriptText = $('script').map((_, el) => $(el).html() || '').get().join(' ');
            const searchableText = [bodyText, poiTextParts.join(' '), imageMetaText, scriptText].join(' ').replace(/\s+/g, ' ');
            const title = $('h1').first().text().trim() || slug;

            if (!/Avalon|Road Layout|Green chest|หีบเขียว/i.test(bodyText + ' ' + imageMetaText + ' ' + html)) {
                throw new Error('ไม่ใช่หน้า Avalon map');
            }

            const tierMatch =
                searchableText.match(/\bT\s*([468])\b/i) ||
                title.match(/\bT\s*([468])\b/i);
            const layoutMatch = bodyText.match(/Road Layout\s*([A-Z])/i);
            const mapImageRaw =
                $('meta[property="og:image"]').attr('content') ||
                $('meta[name="twitter:image"]').attr('content') ||
                $('img[alt*="Avalon" i]').first().attr('src') ||
                $('img').first().attr('src') || '';

            let mapImage = mapImageRaw;
            if (mapImage && !/^https?:\/\//i.test(mapImage)) {
                mapImage = new URL(mapImage, url).href;
            }

            const counts = {};
            for (const label of Object.keys(AVA_LABELS_TH)) {
                counts[label] = extractAvaCount(searchableText, label);
            }

            const connection = extractAvaConnection(html, bodyText);
            const totalChests = counts['Green chest'] + counts['Blue chest'] + counts['Gold chest'];
            const totalResources =
                counts.Stone + counts.Wood + counts.Ore + counts.Hide + counts.Fiber;
            const totalDungeons = counts['Solo dungeon'] + counts['Group dungeon'];

            return {
                slug,
                name: title.replace(/\s+/g, ' ').trim(),
                tier: tierMatch ? `T${tierMatch[1]}` : 'ไม่พบข้อมูล',
                layout: layoutMatch ? layoutMatch[1].toUpperCase() : 'ไม่พบข้อมูล',
                connection,
                counts,
                totalChests,
                totalResources,
                totalDungeons,
                mapImage,
                sourceUrl: url
            };
        } catch (err) {
            lastError = err;
        }
    }

    throw new Error(`หาแมพ AVA "${input}" ไม่พบ${lastError?.message ? `: ${lastError.message}` : ''}`);
}

function avaCountLine(items) {
    const parts = items
        .filter(([, count]) => Number(count) > 0)
        .map(([label, count]) => `${label} ${count}`);
    return parts.length ? parts.join('  •  ') : 'ไม่มีข้อมูล';
}

async function generateAvaCheckResponse(input) {
    const data = await fetchAvaMapDataWithFallback(input);

    const embed = new EmbedBuilder()
        .setColor(0x2dd4bf)
        .setTitle(`🗺️ AVA CHECK — ${data.name}`)
        .setDescription(
            `🛡️ **Tier:** ${data.tier}  •  🧭 **Layout:** ${data.layout}\n` +
            `🌀 **Connection:** ${formatAvaConnection(data.connection)}`
        )
        .addFields(
            {
                name: '📦 กล่อง',
                value: avaCountLine([
                    ['🟢 เขียว', data.counts['Green chest']],
                    ['🔵 น้ำเงิน', data.counts['Blue chest']],
                    ['🟡 ทอง', data.counts['Gold chest']]
                ]),
                inline: false
            },
            {
                name: '⛏️ ทรัพยากร',
                value: avaCountLine([
                    ['🪨 หินใหญ่', data.counts.Stone],
                    ['⛏️ แร่', data.counts.Ore],
                    ['🪵 ไม้', data.counts.Wood],
                    ['🦌 หนัง', data.counts.Hide],
                    ['🌿 เส้นใย', data.counts.Fiber]
                ]),
                inline: false
            },
            {
                name: '🏰 ดันเจี้ยน',
                value: avaCountLine([
                    ['🟣 ดันเดี่ยว', data.counts['Solo dungeon']],
                    ['🔴 ดันกลุ่ม', data.counts['Group dungeon']]
                ]),
                inline: false
            },
            {
                name: '📊 รวม',
                value: `กล่อง **${data.totalChests}** • ทรัพยากร **${data.totalResources}** • ดันเจี้ยน **${data.totalDungeons}**`,
                inline: false
            }
        )
        .setFooter({ text: `ข้อมูลแผนที่จาก ${data.source || 'AVA sources'}` })
        .setTimestamp();

    if (data.mapImage) embed.setImage(data.mapImage);
    embed.setURL(data.sourceUrl);
    return embed;
}

// ----------------------------------------
// AVA IMAGE OCR + ALBION ROADS AUTO CHECK
// ----------------------------------------
const ALBION_ROADS_SOURCE = 'https://albionroads.com/';
// AVA: canonical map names are resolved before source lookup.
const AVA_IMAGE_EXTENSIONS = /\.(?:png|jpe?g|webp|gif)$/i;
const avaOcrCache = new Map();
const avaPendingSelections = new Map();
const avaProcessingMessages = new Set();
const AVA_ALLOWED_IMAGE_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net', 'images-ext-1.discordapp.net', 'images-ext-2.discordapp.net']);
function isAllowedAvaImageUrl(value) { try { const u = new URL(String(value || '')); return u.protocol === 'https:' && AVA_ALLOWED_IMAGE_HOSTS.has(u.hostname.toLowerCase()); } catch (_) { return false; } }
function setAvaMessageState(guildId, messageId, state, details = '') {
 const cfg = getGuildConfig(String(guildId)); if (!cfg) return;
 if (!cfg.avaMessageStates || typeof cfg.avaMessageStates !== 'object') cfg.avaMessageStates = {};
 const previous = cfg.avaMessageStates[String(messageId)];
 cfg.avaMessageStates[String(messageId)] = { state, updatedAt: Date.now(), attempts: state === 'processing' ? (Number(previous?.attempts) || 0) + 1 : (Number(previous?.attempts) || 0), details: String(details || '').slice(0, 300) };
 const keys = Object.keys(cfg.avaMessageStates);
 if (keys.length > 500) for (const key of keys.sort((a,b) => (cfg.avaMessageStates[a]?.updatedAt || 0) - (cfg.avaMessageStates[b]?.updatedAt || 0)).slice(0, keys.length - 500)) delete cfg.avaMessageStates[key];
 saveData();
}
function runAvaWithConcurrency(task, message) {
 if (avaActiveJobs < AVA_MAX_CONCURRENT) { avaActiveJobs++; return Promise.resolve().then(task).finally(() => { avaActiveJobs--; const next = avaWaitingJobs.shift(); if (next) next(); }); }
 if (avaWaitingJobs.length >= AVA_MAX_QUEUE) { const gid = message?.guildId || message?.guild?.id; if (gid && message?.id) setAvaMessageState(gid, message.id, 'failed', 'AVA work queue full; retry scheduled'); return Promise.resolve(false); }
 return new Promise((resolve,reject) => { avaWaitingJobs.push(() => { avaActiveJobs++; Promise.resolve().then(task).then(resolve,reject).finally(() => { avaActiveJobs--; const next = avaWaitingJobs.shift(); if (next) next(); }); }); });
}
const avaPollState = new Map();
const avaRawRetryTimers = new Map();
const avaCanonicalMapCache = { names: [], expiresAt: 0, loading: null };

function normalizeMapNameText(value) {
    return String(value || '').replace(/[|_]+/g, '-').replace(/\s*[-–—]\s*/g, '-').replace(/[^A-Za-z0-9\-\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractMapNamesFromOcr(text) {
    const raw = normalizeMapNameText(text);
    const blacklist = /^(Albion|Assistant|Production|Bonus|Road|Avalon|Connection|Chests|Resources|Green|Gold|Blue|Stone|Wood|Ore|Hide|Fiber|Tier)-/i;
    const found = [];
    const add = value => {
        const name = normalizeMapNameText(value).replace(/\s+/g, '');
        if (!name || blacklist.test(name)) return;
        if (!/^[A-Za-z]{3,18}-[A-Za-z]{3,18}$/.test(name)) return;
        if (!found.some(x => normalizeAvaLookupName(x) === normalizeAvaLookupName(name))) found.push(name);
    };
    for (const line of String(text || '').split(/\r?\n/)) {
        const normalizedLine = normalizeMapNameText(line);
        for (const m of normalizedLine.matchAll(/\b([A-Za-z]{3,18})\s*-\s*([A-Za-z]{3,18})\b/g)) add(`${m[1]}-${m[2]}`);
    }
    for (const m of raw.matchAll(/\b([A-Za-z]{3,18})\s*-\s*([A-Za-z]{3,18})\b/g)) add(`${m[1]}-${m[2]}`);
    return found;
}

async function ocrWithSystemTesseract(buffer, psm = 6) {
    const command = String(process.env.TESSERACT_CMD || '/usr/bin/tesseract');
    if (!fs.existsSync(command)) return null;
    const tempDir = path.join(__dirname, '.ava-ocr'); fs.mkdirSync(tempDir, { recursive: true });
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const inputPath = path.join(tempDir, `${id}.png`), outputBase = path.join(tempDir, id), outputPath = `${outputBase}.txt`;
    try {
        fs.writeFileSync(inputPath, buffer);
        await new Promise((resolve, reject) => execFile(command, [inputPath, outputBase, '--psm', String(psm), '-l', 'eng', '-c', 'tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz- '], { timeout: 25000 }, err => err ? reject(err) : resolve()));
        return fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : '';
    } catch (err) { console.warn('⚠️ System Tesseract OCR failed:', err.message); return null; }
    finally { for (const file of [inputPath, outputPath]) { try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch (_) {} } }
}

let avaTesseractWorkerPromise = null;

async function ocrWithTesseractJs(buffer) {
    let tesseract;
    try { tesseract = require('tesseract.js'); } catch (_) { return null; }

    // Reuse one worker. Creating/loading a new Tesseract.js worker for every
    // crop is extremely expensive and can make AVA replies take tens of seconds.
    try {
        if (!avaTesseractWorkerPromise) {
            avaTesseractWorkerPromise = tesseract.createWorker('eng').catch(err => {
                avaTesseractWorkerPromise = null;
                throw err;
            });
        }
        const worker = await avaTesseractWorkerPromise;
        const result = await worker.recognize(buffer);
        return result?.data?.text || null;
    } catch (err) {
        console.warn('⚠️ Tesseract.js OCR failed:', err.message);
        return null;
    }
}

async function detectAvaMapNameFromImage(imageBuffer) {
    const cacheKey = require('crypto').createHash('sha1').update(imageBuffer).digest('hex');
    if (avaOcrCache.has(cacheKey)) return avaOcrCache.get(cacheKey);

    const image = await loadImage(imageBuffer);

    // AVA map names are in the upper part of the screenshot. Keep the OCR
    // input focused and small: large multi-crop OCR was the main source of
    // the long "กำลังอ่านชื่อแมพ..." delay.
    const scale = 3;
    const sourceCropHeight = Math.max(1, Math.min(image.height * 0.55, 900));
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(sourceCropHeight * scale));
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0, width, height);

    const texts = [];
    const candidates = [];
    const addCandidate = value => {
        const name = normalizeMapNameText(value).replace(/\s+/g, '');
        if (!name) return;
        if (!candidates.some(x => normalizeAvaLookupName(x) === normalizeAvaLookupName(name))) {
            candidates.push(name);
        }
    };

    // Fast path: one small system-Tesseract pass. If the host has system
    // Tesseract this normally finishes in a few seconds or less.
    const crop = canvas.toBuffer('image/png');
    for (const psm of [11, 7]) {
        const text = await ocrWithSystemTesseract(crop, psm);
        if (text) {
            texts.push(text);
            for (const name of extractMapNamesFromOcr(text)) addCandidate(name);
        }
        if (candidates.length) {
            const result = {
                mapName: candidates[0],
                candidates: candidates.slice(0, 12),
                rawText: texts.join('\n')
            };
            avaOcrCache.set(cacheKey, result);
            return result;
        }
    }

    // Hosting fallback: run Tesseract.js only once, using the same focused
    // crop and a reusable worker. Do not create/terminate a worker per crop.
    const jsText = await ocrWithTesseractJs(crop);
    if (jsText) {
        texts.push(jsText);
        for (const name of extractMapNamesFromOcr(jsText)) addCandidate(name);
    }

    const combined = texts.join('\n');
    for (const name of extractMapNamesFromOcr(combined)) addCandidate(name);

    const result = {
        mapName: candidates[0] || null,
        candidates: candidates.slice(0, 12),
        rawText: combined
    };
    avaOcrCache.set(cacheKey, result);
    if (avaOcrCache.size > 100) avaOcrCache.delete(avaOcrCache.keys().next().value);
    return result;
}

function extractAvaExactMarkerCount(text, labels) {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    for (const label of labels) {
        const escaped = String(label || '').replace(/[.*+?^$\{\}()|[\]\\]/g, '\\$&');
        const patterns = [
            // Battle Hub renders entries like "ImageGreen chest×2". The icon/image
            // token may touch the label, so do NOT require a non-alphanumeric
            // boundary before the label.
            new RegExp(escaped + '\\s*(?:×|x|X)\\s*(\\d+)\\b', 'i'),
            new RegExp(escaped + '[^0-9]{0,12}(\\d+)\\s*(?:×|x|X)', 'i')
        ];
        for (const re of patterns) {
            const match = normalized.match(re);
            if (match) return Number(match[1]) || 0;
        }
    }
    return 0;
}

function extractAlbionRoadsNumberNearText(text, labels) {
    const normalized = String(text || '').replace(/\s+/g, ' ');
    for (const label of labels) {
        const escaped = label.replace(/[.*+?^$\{\}()|[\]\\]/g, '\\$&');
        const after = normalized.match(new RegExp(escaped + '[^0-9]{0,80}(\\d+)', 'i'));
        if (after) return Number(after[1]) || 0;
        const before = normalized.match(new RegExp('(\\d+)[^A-Za-z0-9]{0,20}' + escaped, 'i'));
        if (before) return Number(before[1]) || 0;
    }
    return 0;
}

function extractAvaCountFromPageText(text, labels) {
    const exact = extractAvaExactMarkerCount(text, labels);
    return exact > 0 ? exact : extractAlbionRoadsNumberNearText(text, labels);
}

function extractAlbionRoadsImage($, baseUrl, mapName) {
    const candidates = [];
    $('img').each((_, el) => {
        const src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-lazy-src') || '';
        const alt = $(el).attr('alt') || '';
        if (!src) return;
        const score = (alt.toLowerCase().includes(mapName.toLowerCase()) ? 100 : 0) + (/map|minimap|avalon|road/i.test(`${src} ${alt}`) ? 20 : 0);
        candidates.push({ src, score });
    });
    candidates.sort((a, b) => b.score - a.score);
    if (!candidates.length) return '';
    try { return new URL(candidates[0].src, baseUrl).href; } catch (_) { return candidates[0].src; }
}

function extractBattleHubMapImage($, baseUrl, mapName) {
    const rawCandidates = [
        $('meta[property="og:image"]').attr('content'),
        $('meta[name="twitter:image"]').attr('content'),
        $('img[alt*="Roads of Avalon" i]').first().attr('src'),
        $('img[alt*="Avalon" i]').first().attr('src')
    ].filter(Boolean);
    $('img').each((_, el) => {
        const src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-lazy-src') || '';
        const alt = $(el).attr('alt') || '';
        if (src && /avalon|map/i.test(`${src} ${alt}`)) rawCandidates.push(src);
    });
    for (const raw of rawCandidates) {
        try {
            const absolute = new URL(raw, baseUrl).href;
            // Prefer the original image behind Next.js optimization URLs.
            const parsed = new URL(absolute);
            const original = parsed.searchParams.get('url');
            if (original) return new URL(original, baseUrl).href;
            if (/\.(?:png|jpe?g|webp|gif)(?:[?#].*)?$/i.test(absolute) || /\/api\/og\/avalon/i.test(absolute)) return absolute;
        } catch (_) {}
    }
    return '';
}

function normalizeAvaLookupName(value) {
    return normalizeMapNameText(value).toLowerCase().replace(/\s+/g, '').replace(/[–—]/g, '-');
}

function levenshteinDistance(a, b) {
    a = String(a || ''); b = String(b || '');
    const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        for (let j = 1; j <= b.length; j++) {
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
        for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
    }
    return prev[b.length];
}

function avaNameSimilarity(a, b) {
    const aa = normalizeAvaLookupName(a), bb = normalizeAvaLookupName(b);
    const aaT = normalizeAvaLookupTolerant(a), bbT = normalizeAvaLookupTolerant(b);
    if (!aa || !bb) return 0;
    if (aa === bb) return 1;
    if (aaT === bbT) return 0.95;
    const maxLen = Math.max(aa.length, bb.length);
    const maxLenT = Math.max(aaT.length, bbT.length);
    const distanceScore = 1 - (levenshteinDistance(aa, bb) / maxLen);
    const distanceScoreT = 1 - (levenshteinDistance(aaT, bbT) / maxLenT);
    const [ap, as] = aa.split('-'), [bp, bs] = bb.split('-');
    const [apT, asT] = aaT.split('-'), [bpT, bsT] = bbT.split('-');
    const prefixScore = ap && bp ? 1 - levenshteinDistance(ap, bp) / Math.max(ap.length, bp.length) : 0;
    const suffixScore = as && bs ? 1 - levenshteinDistance(as, bs) / Math.max(as.length, bs.length) : 0;
    const prefixScoreT = apT && bpT ? 1 - levenshteinDistance(apT, bpT) / Math.max(apT.length, bpT.length) : 0;
    const suffixScoreT = asT && bsT ? 1 - levenshteinDistance(asT, bsT) / Math.max(asT.length, bsT.length) : 0;
    const strict = (distanceScore * 0.35) + (prefixScore * 0.35) + (suffixScore * 0.30);
    const tolerant = (distanceScoreT * 0.35) + (prefixScoreT * 0.35) + (suffixScoreT * 0.30);
    return Math.max(strict, tolerant * 0.98 + 0.02);
}

// OCR มักสับสน i/l/I/u และตัวอักษรที่หน้าตาคล้ายกันในชื่อแมพ AVA.
// แก้เฉพาะ typo ที่ยืนยันจากฐานข้อมูลจริงก่อน เพื่อไม่ให้เดาไปเป็นแมพอื่น.
const AVA_OCR_NAME_ALIASES = new Map([
    ['teros-aulusum', 'Teros-Auiusum'],
    ['teros-auiusum', 'Teros-Auiusum'],
    ['tynos-atatios', 'Tynos-Atatlos'],
    ['ceros-aedyium', 'Ceros-Aeaylum'],
    ['xoultos-eyoztum', 'Xuros-Eyoztum'],
    ['ollent-odesas', 'Qiient-Odesas'],
    ['olient-odesas', 'Qiient-Odesas'],
    ['qient-odesas', 'Qiient-Odesas'],
    ['fuyes-lzohun', 'Fuyes-Izohun'],
    ['fuyes-izohun', 'Fuyes-Izohun'],
    ['coues-xakrom', 'Coues-Exakrom'],
    ['oasos-uromlium', 'Oasos-Uromlum'],
    ['oasos-uromliun', 'Oasos-Uromlum'],
    ['oasos-uroml1um', 'Oasos-Uromlum'],
    ['siritos-avolirom', 'Siritos-Avoirom'],
    ['siritos-avo1rom', 'Siritos-Avoirom'],
    ['flees-ohohtum', 'Flees-Ohohtum'],
    ['huritos-iuimaum', 'Huritos-Iuimaum'],
    ['huritos-iulmaum', 'Huritos-Iuimaum'],
    ['hasos-iuimaum', 'Hasos-Iuimaum'],
]);

const OCR_CONFUSION_MAP = {
    '0': 'o', 'O': 'o', 'Q': 'o',
    '1': 'i', '|': 'i', '!': 'i', 'l': 'i', 'I': 'i', 'j': 'i',
    'rn': 'm', 'vv': 'w'
};

function ocrTolerantNormalize(value) {
    let s = String(value || '').toLowerCase();
    s = s.replace(/0/g, 'o').replace(/[|!1]/g, 'i').replace(/l/g, 'i');
    s = s.replace(/rn/g, 'm').replace(/vv/g, 'w');
    return s.replace(/[^a-z0-9-]/g, '');
}

function correctOcrCommonErrors(value) {
    return String(value || '').replace(/[|!]/g, 'I').replace(/\b0/g, 'O').replace(/\b1/g, 'I').trim();
}

function normalizeAvaLookupTolerant(value) {
    return ocrTolerantNormalize(normalizeMapNameText(value));
}

function normalizeAvaOcrMapName(value) {
    const normalized = normalizeAvaLookupName(value);
    return AVA_OCR_NAME_ALIASES.get(normalized) || normalizeMapNameText(value);
}

function parseAvaNameFromHref(href) {
    const m = String(href || '').match(/(?:avalon-maps|maps\/avalon)\/([^/?#]+)/i);
    return m ? decodeURIComponent(m[1]).replace(/-/g, '-').trim() : '';
}

async function requestBattleHubHtml(url, timeoutMs = 15000) {
    const headers = {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        Referer: 'https://albionbattlehub.com/'
    };
    try {
        const response = await axios.get(url, { timeout: timeoutMs, headers, validateStatus: status => status >= 200 && status < 400 });
        return String(response.data || '');
    } catch (axiosError) {
        const seconds = Math.max(5, Math.ceil(timeoutMs / 1000));
        try {
            const output = await new Promise((resolve, reject) => {
                execFile('curl', ['-L', '-sS', '--max-time', String(seconds), '-A', headers['User-Agent'], '-H', `Accept: ${headers.Accept}`, '-H', `Accept-Language: ${headers['Accept-Language']}`, '-H', `Referer: ${headers.Referer}`, url], { timeout: timeoutMs + 3000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => err ? reject(err) : resolve(stdout));
            });
            return String(output || '');
        } catch (curlError) {
            throw new Error(`Battle Hub request failed (axios: ${axiosError.response?.status || axiosError.message}; curl: ${curlError.message})`);
        }
    }
}

async function fetchBattleHubMapIndexUncached() {
    if (avaCanonicalMapCache.names.length && avaCanonicalMapCache.expiresAt > Date.now()) return avaCanonicalMapCache.names;
    const urls = [
        'https://albionbattlehub.com/en/avalon-maps',
        'https://albionbattlehub.com/th/avalon-maps',
        'https://albionbattlehub.com/sitemap.xml',
        'https://albionbattlehub.com/sitemap-0.xml'
    ];

    const collectNames = (html, baseUrl) => {
        const $ = cheerio.load(html, { xmlMode: /sitemap/i.test(baseUrl) });
        const maps = [];

        // Canonical zone URLs from sitemap/XML.
        $('loc').each((_, el) => {
            const loc = $(el).text().trim();
            const name = parseAvaNameFromHref(loc);
            if (name && /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+$/.test(name)) maps.push(name);
        });

        // Canonical names from normal page links. Support hideout names with
        // multiple hyphen-separated parts, e.g. Qiient-Qi-Odesas.
        $('a[href]').each((_, el) => {
            const name = parseAvaNameFromHref($(el).attr('href'));
            if (name && /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+$/.test(name)) maps.push(name);
        });

        // Next.js pages may keep canonical links inside escaped JSON rather
        // than ordinary <a href> elements. Extract those slugs as a fallback.
        for (const match of String(html || '').matchAll(/(?:avalon-maps|maps\/avalon)[\/\\]+([A-Za-z0-9]+(?:-[A-Za-z0-9]+)+)/gi)) {
            const name = match[1];
            if (/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+$/.test(name)) maps.push(name);
        }

        // Some page versions contain the complete 400-zone list as visible text.
        const bodyText = $('body').text().replace(/\s+/g, ' ');
        const bodyNameRe = /\b([A-Za-z0-9]+(?:-[A-Za-z0-9]+)+)\s*T(?:4|6|8)\b/g;
        for (const match of bodyText.matchAll(bodyNameRe)) maps.push(match[1]);

        return [...new Map(maps.map(x => [normalizeAvaLookupName(x), x])).values()];
    };

    for (const url of urls) {
        try {
            const html = await requestBattleHubHtml(url, 15000);
            const unique = collectNames(html, url);
            if (unique.length) {
                console.log('🗺️ Battle Hub canonical Avalon map index loaded: ' + unique.length + ' names from ' + url);
                // Prefer a complete-looking index. The known Avalon dataset has 400 zones.
                if (unique.length >= 50 || /sitemap/i.test(url)) {
                    avaCanonicalMapCache.names = unique;
                    avaCanonicalMapCache.expiresAt = Date.now() + (30 * 60 * 1000);
                    return unique;
                }
            }
        } catch (err) {
            console.warn('⚠️ Battle Hub map index request failed (' + url + '): ' + err.message);
        }
    }
    return [];
}

async function fetchBattleHubMapIndex() {
    if (avaCanonicalMapCache.names.length && avaCanonicalMapCache.expiresAt > Date.now()) {
        return avaCanonicalMapCache.names;
    }
    // Several OCR/message paths can ask for the index at the same time.
    // Share one in-flight request instead of downloading the whole website
    // once per message or once per resolver call.
    if (avaCanonicalMapCache.loading) return avaCanonicalMapCache.loading;
    avaCanonicalMapCache.loading = fetchBattleHubMapIndexUncached()
        .finally(() => { avaCanonicalMapCache.loading = null; });
    return avaCanonicalMapCache.loading;
}

async function fetchAuthoritativeAvaMapIndex() {
    // Load from local ava-maps.js first - 400 maps organized by category
    try {
        const local = require('./ava-maps.js');
        const all = local.all || local.ALL || (Array.isArray(local) ? local : Object.values(local).flat().filter(v => typeof v === 'string'));
        if (all && all.length >= 300) {
            console.log('🗺️ Using local ava-maps.js: ' + all.length + ' maps');
            return all;
        }
    } catch(e) {
        // ignore if file not found
    }

    const urls = [
        'https://atlaschill.com/albion/es/avalon-maps/',
        'https://albiononline.th.gl/db/locations',
        'https://guildmanifesto.github.io/albionmaps/',
        'https://lucioreyli.github.io/ava-maps/'
    ];
    for (const url of urls) {
        try {
            let html = '';
            try {
                if (url.includes('atlaschill')) {
                    const res = await cloudscraper.get({ uri: url, timeout: 12000 });
                    html = typeof res === 'string' ? res : String(res);
                } else {
                    const response = await axios.get(url, {
                        timeout: 10000,
                        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html,application/xhtml+xml' },
                        validateStatus: status => status >= 200 && status < 400
                    });
                    html = String(response.data || '');
                }
            } catch (inner) {
                const response = await axios.get(url, {
                    timeout: 10000,
                    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html,application/xhtml+xml' },
                    validateStatus: status => status >= 200 && status < 400
                });
                html = String(response.data || '');
            }
            const $ = cheerio.load(html);
            const names = [];
            const bodyHtml = $('body').html() || '';
            let roadsHtml = bodyHtml;
            if (/albiononline\.th\.gl/i.test(url)) {
                const roadsMatch = bodyHtml.match(/Roads of Avalon\s*400[\s\S]*?(?=Static Dungeon\s*156|$)/i);
                roadsHtml = roadsMatch ? roadsMatch[0] : bodyHtml;
            }
            const seen = new Set();
            const section$ = cheerio.load(roadsHtml);
            section$('a[href*="avalon-maps"]').each((_, el) => {
                const href = section$(el).attr('href') || '';
                const slug = parseAvaNameFromHref(href);
                if (slug && /^[A-Za-z0-9]+-[A-Za-z0-9]+$/.test(slug)) {
                    const proper = slug.split('-').map(s => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()).join('-');
                    const key = normalizeAvaLookupName(proper);
                    if (!seen.has(key)) { seen.add(key); names.push(proper); }
                }
            });
            if (names.length < 20) {
                const roadsText = cheerio.load(roadsHtml)('body').text().replace(/\s+/g, ' ');
                for (const match of roadsText.matchAll(/\b([A-Za-z0-9]+(?:-[A-Za-z0-9]+)+)\b/g)) {
                    const name = normalizeMapNameText(match[1]).replace(/\s+/g, '');
                    if (!/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+$/.test(name)) continue;
                    const key = normalizeAvaLookupName(name);
                    if (!seen.has(key)) { seen.add(key); names.push(name); }
                }
            }
            if (names.length < 50) {
                for (const m of html.matchAll(/\/avalon-maps\/([a-z0-9-]+)/gi)) {
                    const slug = m[1];
                    if (!/^[a-z0-9]+-[a-z0-9]+$/.test(slug)) continue;
                    const proper = slug.split('-').map(s => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()).join('-');
                    const key = normalizeAvaLookupName(proper);
                    if (!seen.has(key)) { seen.add(key); names.push(proper); }
                }
            }
            if (names.length >= 20) {
                console.log('🗺️ Authoritative Avalon name index loaded: ' + names.length + ' names from ' + url);
                return names;
            }
        } catch (err) {
            console.warn('⚠️ Authoritative Avalon name index failed (' + url + '): ' + err.message);
        }
    }
    return [];
}


async function fetchAlternativeAvaMapIndex() {
    const urls = [
        'https://guildmanifesto.github.io/albionmaps/',
        'https://lucioreyli.github.io/ava-maps/'
    ];

    for (const url of urls) {
        try {
            const response = await axios.get(url, {
                timeout: 8000,
                headers: {
                    'User-Agent': 'Mozilla/5.0',
                    Accept: 'text/html,application/xhtml+xml'
                },
                validateStatus: status => status >= 200 && status < 400
            });
            const html = String(response.data || '');
            const textContent = cheerio.load(html)('body').text().replace(/\s+/g, ' ');
            const source = html + ' ' + textContent;
            const names = [];

            // Both static Avalon indexes expose names followed by their tier.
            // Keep only real-looking Avalon zone names, not UI text.
            for (const match of source.matchAll(/\b([A-Za-z]{3,18}-[A-Za-z]{3,18})\s*(?:\(|<[^>]*>)?\s*T?([468]|IV|VI|VIII)\b/gi)) {
                const name = normalizeMapNameText(match[1]).replace(/\s+/g, '');
                if (!/^[A-Za-z]{3,18}-[A-Za-z]{3,18}$/.test(name)) continue;
                if (!names.some(x => normalizeAvaLookupName(x) === normalizeAvaLookupName(name))) {
                    names.push(name);
                }
            }

            // Fallback pattern for the simple GitHub Pages table where names
            // appear before "T4/T6/T8" with arbitrary whitespace.
            if (!names.length) {
                for (const match of source.matchAll(/\b([A-Za-z]{3,18}-[A-Za-z]{3,18})\b/g)) {
                    const name = normalizeMapNameText(match[1]).replace(/\s+/g, '');
                    if (!/^[A-Za-z]{3,18}-[A-Za-z]{3,18}$/.test(name)) continue;
                    const around = source.slice(Math.max(0, match.index - 20), Math.min(source.length, match.index + 80));
                    if (!/\b(?:T4|T6|T8|IV|VI|VIII)\b/i.test(around)) continue;
                    if (!names.some(x => normalizeAvaLookupName(x) === normalizeAvaLookupName(name))) names.push(name);
                }
            }

            if (names.length) {
                console.log('🗺️ Alternative Avalon map index loaded: ' + names.length + ' names from ' + url);
                return names;
            }
        } catch (err) {
            console.warn('⚠️ Alternative Avalon map index failed (' + url + '): ' + err.message);
        }
    }
    return [];
}


async function getAvaMapSuggestions(ocrCandidates = [], limit = 3) {
    const rawInputs = [...new Set(ocrCandidates.filter(Boolean).map(String).filter(Boolean))];
    const normalizedInputs = rawInputs.map(v => normalizeAvaOcrMapName(v).replace(/\s+/g, '')).filter(Boolean);
    const tolerantInputs = rawInputs.map(v => normalizeAvaLookupTolerant(v)).filter(Boolean);

    let canonicalNames = await fetchAuthoritativeAvaMapIndex();
    if (!canonicalNames.length) canonicalNames = await fetchBattleHubMapIndex();
    if (!canonicalNames.length) canonicalNames = await fetchAlternativeAvaMapIndex();

    if (!canonicalNames.length) {
        const aliasNames = [];
        for (const raw of rawInputs) {
            const corrected = normalizeAvaOcrMapName(raw).replace(/\s+/g, '');
            if (!corrected) continue;
            if (normalizeAvaLookupName(corrected) === normalizeAvaLookupName(raw)) continue;
            if (!aliasNames.some(x => normalizeAvaLookupName(x) === normalizeAvaLookupName(corrected))) aliasNames.push(corrected);
        }
        return aliasNames.slice(0, limit).map((name, index) => ({ name, score: 1, exact: true, source: 'OCR alias fallback', rank: index + 1 }));
    }

    const ranked = canonicalNames.map(name => {
        const normalizedName = normalizeAvaLookupName(name);
        const tolerantName = normalizeAvaLookupTolerant(name);
        let bestScore = 0;
        for (const input of normalizedInputs) bestScore = Math.max(bestScore, avaNameSimilarity(input, name));
        for (const input of tolerantInputs) {
            const s = 1 - (levenshteinDistance(input, tolerantName) / Math.max(input.length, tolerantName.length));
            bestScore = Math.max(bestScore, s);
        }
        for (const raw of rawInputs) {
            const corrected = normalizeAvaOcrMapName(raw).replace(/\s+/g, '');
            if (corrected && normalizeAvaLookupName(corrected) === normalizedName) bestScore = Math.max(bestScore, 1);
            if (corrected && normalizeAvaLookupTolerant(corrected) === tolerantName) bestScore = Math.max(bestScore, 0.96);
        }
        return { name, score: bestScore, exact: normalizedInputs.some(input => input === normalizedName || normalizeAvaLookupTolerant(input) === tolerantName) };
    }).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

    const selected = [];
    for (const item of ranked) {
        if (item.score < 0.35 && selected.length >= 1) continue;
        if (selected.some(x => normalizeAvaLookupName(x.name) === normalizeAvaLookupName(item.name))) continue;
        selected.push(item);
        if (selected.length >= limit) break;
    }
    if (selected.length < limit) {
        for (const item of ranked) {
            if (selected.some(x => normalizeAvaLookupName(x.name) === normalizeAvaLookupName(item.name))) continue;
            selected.push(item);
            if (selected.length >= limit) break;
        }
    }
    return selected.slice(0, limit).map((item, idx) => ({ ...item, rank: idx + 1, source: item.exact ? 'exact' : 'fuzzy' }));
}

function avaSelectionComponents(guildId, token, suggestions) {
    const select = new StringSelectMenuBuilder()
        .setCustomId('ava_select:' + guildId + ':' + token)
        .setPlaceholder('เลือกชื่อแมพที่ตรงกับรูป')
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(...suggestions.map((item, index) => ({
            label: String(item.name).slice(0, 100),
            value: String(item.name).slice(0, 100),
            description: ('ความใกล้เคียง ' + Math.round(Number(item.score || 0) * 100) + '% • ตัวเลือกที่ ' + (index + 1)).slice(0, 100)
        })));
    return [
        new ActionRowBuilder().addComponents(select),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('ava_retry:' + guildId + ':' + token).setLabel('🔄 อ่านรูปใหม่').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('ava_cancel:' + guildId + ':' + token).setLabel('❌ ยกเลิก').setStyle(ButtonStyle.Danger)
        )
    ];
}

async function resolveAvaMapName(input) {
    const normalizedInput = normalizeAvaOcrMapName(input);
    if (!normalizedInput) return { name: '', score: 0, exact: false };

    // Confirmed OCR aliases are deterministic corrections. Accept them before
    // any network request.
    if (normalizeAvaLookupName(normalizedInput) !== normalizeAvaLookupName(input)) {
        return { name: normalizedInput, score: 1, exact: true, source: 'OCR alias' };
    }

    // Try the exact Battle Hub page BEFORE downloading the large canonical
    // map index. This makes normal valid OCR names resolve with one request
    // instead of waiting for the sitemap/index first.
    const directSlug = normalizedInput.toLowerCase().replace(/\s+/g, '-');
    const directUrls = [
        `https://albionbattlehub.com/en/avalon-maps/${encodeURIComponent(directSlug)}`,
        `https://albionbattlehub.com/th/avalon-maps/${encodeURIComponent(directSlug)}`
    ];
    for (const url of directUrls) {
        try {
            const $ = cheerio.load(await requestBattleHubHtml(url, 6000));
            const h1 = $('h1').first().text().trim();
            if (h1 && normalizeAvaLookupName(h1) === normalizeAvaLookupName(normalizedInput)) {
                return { name: h1, score: 1, exact: true, source: 'Battle Hub direct' };
            }
        } catch (_) {}
    }

    // Only fall back to the canonical index when the exact page did not verify.
    const candidates = await fetchBattleHubMapIndex();
    const exactCanonical = candidates.find(name => normalizeAvaLookupName(name) === normalizeAvaLookupName(normalizedInput));
    if (exactCanonical) return { name: exactCanonical, score: 1, exact: true };

    if (!candidates.length) return { name: normalizedInput, score: 0, exact: false };

    const ranked = candidates.map(name => ({
        name,
        score: avaNameSimilarity(normalizedInput, name)
    })).sort((a, b) => b.score - a.score);

    const best = ranked[0];
    if (!best || best.score < 0.62) {
        return { name: normalizedInput, score: best?.score || 0, exact: false };
    }
    return { name: best.name, score: best.score, exact: false };
}

function parseBattleHubAvaData(html, url, requestedName) {
    const $ = cheerio.load(html);
    const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
    const h1 = $('h1').first().text().trim() || requestedName;
    // Some pages put tier and POI counts in image alt/title attributes or
    // serialized page data instead of visible body text. Search all of them.
    const imageLabels = [];
    $('img').each((_, el) => {
        const node = $(el);
        imageLabels.push(node.attr('alt') || '', node.attr('title') || '', node.attr('aria-label') || '', node.attr('data-label') || '');
    });
    const scriptText = $('script').map((_, el) => $(el).html() || '').get().join(' ');
    const searchableText = [bodyText, h1, imageLabels.join(' '), scriptText, html.replace(/<[^>]+>/g, ' ')].join(' ').replace(/\s+/g, ' ');
    const tierMatch = searchableText.match(/(?:\(|\[|\b)T\s*([468])(?:\)|\]|\b)/i) || h1.match(/T\s*([468])/i);
    const layoutMatch = searchableText.match(/Road Layout\s+([A-Z])/i) || searchableText.match(/Layout\s*[:#-]?\s*([A-Z])\b/i);
    const getCount = labels => extractAvaCountFromPageText(searchableText, labels);
    const counts = {
        'Gold chest': getCount(['Gold chest', 'Gold Chest', 'หีบทอง', 'Peti emas', 'Cofre dorado', 'صندوق ذهبي']),
        'Blue chest': getCount(['Blue chest', 'Blue Chest', 'หีบน้ำเงิน', 'หีบฟ้า', 'Peti biru', 'Cofre azul', 'صندوق أزرق']),
        'Green chest': getCount(['Green chest', 'Green Chest', 'หีบเขียว', 'Peti hijau', 'Cofre verde', 'صندوق أخضر']),
        'Group dungeon': getCount(['Group dungeon', 'ดันเจี้ยนกลุ่ม', 'ดันเจี้ยนกลุ่ม×', 'Dungeon Group']),
        'Solo dungeon': getCount(['Solo dungeon', 'ดันเจี้ยนเดี่ยว', 'Dungeon solo']),
        Wood: getCount(['Wood', 'ไม้', 'Kayu', 'Madera']),
        Ore: getCount(['Ore', 'แร่', 'Bijih', 'Minério', 'خام']),
        Stone: getCount(['Stone', 'หิน', 'Batu', 'Piedra', 'حجر']),
        Hide: getCount(['Hide', 'หนัง', 'Kulit', 'Pelego', 'Cuero']),
        Fiber: getCount(['Fiber', 'ไฟเบอร์', 'เส้นใย', 'Serat', 'Fibra'])
    };
    const mapImage = extractBattleHubMapImage($, url, h1) || extractAlbionRoadsImage($, url, h1);
    let connection = '';
    const tunnel = html.match(/TUNNEL(?:_BLACK)?_(?:LOW|MEDIUM|HIGH|DEEP(?:_RAID)?|HIDEOUT(?:_DEEP)?)/i);
    if (tunnel) connection = tunnel[0].toUpperCase();
    return {
        name: h1,
        tier: tierMatch ? `T${tierMatch[1]}` : '',
        layout: layoutMatch ? layoutMatch[1] : '',
        counts,
        mapImage,
        sourceUrl: url,
        source: 'Albion Battle Hub',
        connection
    };
}

async function fetchBattleHubMapData(lookupName) {
    // Always normalize OCR aliases before building the Battle Hub URL.
    // Example: OCR "Teros-Aulusum" -> real zone "Teros-Auiusum".
    const normalizedInput = normalizeAvaOcrMapName(lookupName);
    const resolved = await resolveAvaMapName(normalizedInput);
    const resolvedName = resolved.name || normalizedInput;
    const slug = resolvedName.toLowerCase().replace(/\s+/g, '-');
    const urls = [
        `https://albionbattlehub.com/en/avalon-maps/${encodeURIComponent(slug)}`,
        `https://albionbattlehub.com/th/avalon-maps/${encodeURIComponent(slug)}`
    ];
    let lastError = null;
    for (const url of urls) {
        try {
            const data = parseBattleHubAvaData(await requestBattleHubHtml(url), url, resolvedName);
            if (data.name && data.tier !== 'ไม่พบข้อมูล' || Object.values(data.counts).some(Boolean)) {
                return { ...data, requestedName: lookupName, resolvedScore: resolved.score };
            }
        } catch (err) { lastError = err; }
    }
    throw lastError || new Error(`ไม่พบข้อมูล ${lookupName}`);
}

async function fetchAlbionOnlineBuildsAvaMapData(lookupName) {
    const correctedName = normalizeAvaOcrMapName(lookupName);
    const slug = normalizeMapNameText(correctedName).toLowerCase().replace(/\s+/g, '-');
    const url = 'https://www.albiononlinebuilds.com/maps/avalon/' + encodeURIComponent(slug);

    let html = '';
    let lastError = null;
    try {
        html = String(await cloudscraper.get({
            uri: url, timeout: 25000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154 Safari/537.36',
                Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                Referer: 'https://www.albiononlinebuilds.com/maps/avalon'
            }
        }));
    } catch (err) { lastError = err; }

    if (!html) {
        try {
            const response = await axios.get(url, {
                timeout: 25000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154 Safari/537.36',
                    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                    Referer: 'https://www.albiononlinebuilds.com/maps/avalon'
                },
                validateStatus: status => status >= 200 && status < 400
            });
            html = String(response.data || '');
        } catch (err) { lastError = err; }
    }

    if (!html) throw new Error('Albion Online Builds ไม่สามารถเปิดแมพ ' + correctedName + (lastError?.message ? ' (' + lastError.message + ')' : ''));

    const $ = cheerio.load(html);
    const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
    const sourceText = [bodyText, $('body').html() || '', ...$('script').map((_, el) => $(el).html() || '').get()].join(' ');
    const title = $('h1').first().text().replace(/\s+/g, ' ').trim() || $('title').first().text().replace(/\s+/g, ' ').trim();
    const nameMatch = title.match(/([A-Za-z0-9]{3,24}-[A-Za-z0-9]{3,24})/);
    const name = nameMatch ? nameMatch[1] : correctedName;
    const tierMatch = (title + ' ' + bodyText).match(/\bT\s*([468])\b/i);

    const escapeRe = value => String(value).replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    const findCount = labels => {
        for (const label of labels) {
            const escaped = escapeRe(label);
            const patterns = [
                new RegExp('(?:Image\\s*:\\s*)?' + escaped + '\\s+' + escaped + '\\s*([0-9]{1,3})\\b', 'i'),
                new RegExp('(?:Image\\s*:\\s*)?' + escaped + '\\s*[:x×-]?\\s*([0-9]{1,3})\\b', 'i'),
                new RegExp('([0-9]{1,3})\\s+(?:Image\\s*:\\s*)?' + escaped + '\\b', 'i')
            ];
            for (const re of patterns) {
                const m = bodyText.match(re);
                if (m) return { value: Number(m[1]) || 0, found: true };
            }
        }
        let result = { value: 0, found: false };
        $('body *').each((_, el) => {
            if (result.found) return;
            const text = $(el).text().replace(/\s+/g, ' ').trim();
            if (!text || text.length > 180) return;
            for (const label of labels) {
                const re = new RegExp('(?:Image\\s*:\\s*)?' + escapeRe(label) + '(?:\\s+' + escapeRe(label) + ')?\\s*([0-9]{1,3})\\b', 'i');
                const m = text.match(re);
                if (m) { result = { value: Number(m[1]) || 0, found: true }; return; }
            }
        });
        return result;
    };

    const fields = {
        'Gold chest': findCount(['Gold Chest']),
        'Blue chest': findCount(['Blue Chest']),
        'Green chest': findCount(['Green Chest']),
        'Group dungeon': findCount(['Group Dungeon', 'Group dungeon', 'Avalonian Dungeon']),
        'Solo dungeon': findCount(['Solo Dungeon', 'Solo dungeon']),
        Wood: findCount(['Wood']),
        Ore: findCount(['Ore']),
        Stone: findCount(['Rock', 'Stone']),
        Hide: findCount(['Hide']),
        Fiber: findCount(['Fiber'])
    };
    const counts = Object.fromEntries(Object.entries(fields).map(([key, info]) => [key, Number(info.value) || 0]));
    const countMeta = Object.fromEntries(Object.entries(fields).map(([key, info]) => [key, Boolean(info.found)]));

    const imageCandidates = [];
    const pushImage = value => { if (value) { const raw = String(value).trim().replace(/^['"]|['"]$/g, ''); if (raw) imageCandidates.push(raw); } };
    $('meta[property="og:image"],meta[name="twitter:image"],meta[itemprop="image"]').each((_, el) => pushImage($(el).attr('content')));
    $('img').each((_, el) => {
        pushImage($(el).attr('src'));
        pushImage($(el).attr('data-src'));
        pushImage($(el).attr('data-lazy-src'));
        const srcset = $(el).attr('srcset') || $(el).attr('data-srcset');
        if (srcset) { const parts = srcset.split(',').map(x => x.trim()).filter(Boolean); if (parts.length) pushImage(parts[parts.length - 1].split(/\s+/)[0]); }
    });
    $('[style*="background-image"]').each((_, el) => {
        const style = $(el).attr('style') || '';
        const m = style.match(/url\((['"]?)(.*?)\1\)/i);
        if (m) pushImage(m[2]);
    });
    const imageUrlRe = /https?:[^"'\s<>]+?\.(?:png|jpe?g|webp|gif)(?:\?[^"'\s<>]*)?/ig;
    for (const m of sourceText.matchAll(imageUrlRe)) pushImage(m[0]);

    let mapImage = '';
    for (const raw of [...new Set(imageCandidates)]) {
        try {
            const absolute = new URL(raw, url).href;
            if (/\.(?:png|jpe?g|webp|gif)(?:[?#].*)?$/i.test(absolute)) { mapImage = absolute; break; }
        } catch (_) {}
    }

    if (!Object.values(counts).some(Boolean)) throw new Error('Albion Online Builds พบหน้า ' + correctedName + ' แต่ไม่พบข้อมูล POI');
    return {
        name, tier: tierMatch ? 'T' + tierMatch[1] : 'ไม่พบข้อมูล', layout: '', connection: '',
        counts, countMeta, mapImage, sourceUrl: url, source: 'Albion Online Builds'
    };
}

async function fetchAvalonTrackerMapData(lookupName) {
    const correctedName = normalizeAvaOcrMapName(lookupName);
    const slug = normalizeMapNameText(correctedName).toLowerCase().replace(/\s+/g, '-');
    const url = 'https://avalonroads-97617.web.app/mapas/' + encodeURIComponent(slug) + '.html';

    const response = await axios.get(url, {
        timeout: 25000,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154 Safari/537.36',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            Referer: 'https://avalonroads-97617.web.app/'
        },
        validateStatus: status => status >= 200 && status < 400
    });

    const html = String(response.data || '');
    const $ = cheerio.load(html);
    const bodyText = $('body').text().replace(/\s+/g, ' ').trim();

    // Avalon Roads has multiple page layouts. Values may be visible text,
    // data-* attributes, or JavaScript state, so parse all representations.
    const sourceText = [
        bodyText,
        $('body').html() || '',
        ...$('script').map((_, el) => $(el).html() || '').get()
    ].join(' ');

    const escapeRe = value => String(value).replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');

    const findCount = labels => {
        const labelList = labels.map(String);

        // Structured values: "ore":67, ore:67, data-ore="67", etc.
        for (const label of labelList) {
            const key = label.toLowerCase().replace(/[^a-z0-9]+/g, '');
            if (!key) continue;
            const patterns = [
                new RegExp('["]' + escapeRe(label) + '["]\\s*[:=]\\s*["]?([0-9]{1,5})\\b', 'i'),
                new RegExp('\\bdata-(?:count-)?' + escapeRe(key) + '\\s*=\\s*["]?([0-9]{1,5})\\b', 'i'),
                new RegExp('\\b' + escapeRe(label) + '\\s*[:=]\\s*([0-9]{1,5})\\b', 'i')
            ];
            for (const re of patterns) {
                const m = sourceText.match(re);
                if (m) return { value: Number(m[1]) || 0, found: true };
            }
        }

        // Human-readable forms: Ore 67, 67 Ore, Ore x 67, 67 ImageOre.
        for (const label of labelList) {
            const escaped = escapeRe(label);
            const patterns = [
                new RegExp('\\b' + escaped + '\\s*(?:×|x|X|:|-)?\\s*([0-9]{1,5})\\b', 'i'),
                new RegExp('\\b([0-9]{1,5})\\s*(?:×|x|X|:|-)?\\s*' + escaped + '\\b', 'i'),
                new RegExp('([0-9]{1,5})\\s*Image\\s*' + escaped + '\\b', 'i'),
                new RegExp('Image\\s*' + escaped + '\\s*(?:×|x|X|:|-)?\\s*([0-9]{1,5})\\b', 'i')
            ];
            for (const re of patterns) {
                const m = sourceText.match(re);
                if (m) return { value: Number(m[1]) || 0, found: true };
            }
        }

        // DOM-local parsing prevents unrelated page numbers from being used.
        let result = { value: 0, found: false };
        $('body *').each((_, el) => {
            if (result.found) return;
            const text = $(el).text().replace(/\s+/g, ' ').trim();
            if (!text || text.length > 220) return;

            for (const label of labelList) {
                const hasLabel = new RegExp('\\b' + escapeRe(label) + '\\b', 'i').test(text) ||
                    new RegExp('Image\\s*' + escapeRe(label), 'i').test(text);
                if (!hasLabel) continue;

                const patterns = [
                    new RegExp('\\b([0-9]{1,5})\\s*(?:×|x|X|:|-)?\\s*' + escapeRe(label) + '\\b', 'i'),
                    new RegExp('\\b' + escapeRe(label) + '\\s*(?:×|x|X|:|-)?\\s*([0-9]{1,5})\\b', 'i'),
                    new RegExp('([0-9]{1,5})\\s*Image\\s*' + escapeRe(label) + '\\b', 'i'),
                    new RegExp('Image\\s*' + escapeRe(label) + '\\s*(?:×|x|X|:|-)?\\s*([0-9]{1,5})\\b', 'i')
                ];

                for (const re of patterns) {
                    const m = text.match(re);
                    if (m) {
                        result = { value: Number(m[1]) || 0, found: true };
                        return;
                    }
                }

                const nearby = text.match(/\b([0-9]{1,5})\b/g) || [];
                if (nearby.length === 1) {
                    result = { value: Number(nearby[0]) || 0, found: true };
                    return;
                }
            }
        });

        return result;
    };

    const fields = {
        'Gold chest': findCount(['Gold Chest', 'Gold chest', 'gold-chest', 'goldChest']),
        'Blue chest': findCount(['Blue Chest', 'Blue chest', 'blue-chest', 'blueChest']),
        'Green chest': findCount(['Green Chest', 'Green chest', 'green-chest', 'greenChest']),
        'Group dungeon': findCount(['Avalonian Dungeon', 'Group dungeon', 'Group Dungeon', 'dg-group', 'dgGroup']),
        'Solo dungeon': findCount(['Solo dungeon', 'Solo Dungeon', 'dg-solo', 'dgSolo']),
        Wood: findCount(['Wood', 'wood', 'LOGS']),
        Ore: findCount(['Ore', 'ore', 'ORE']),
        Stone: findCount(['Stone', 'stone', 'ROCK']),
        Hide: findCount(['Hide', 'hide', 'HIDE']),
        Fiber: findCount(['Fiber', 'fiber', 'COTTON'])
    };

    const counts = Object.fromEntries(Object.entries(fields).map(([key, info]) => [key, Number(info.value) || 0]));
    const countMeta = Object.fromEntries(Object.entries(fields).map(([key, info]) => [key, Boolean(info.found)]));

    const tier = bodyText.match(/\bT\s*([468])\b/i);
    const title = $('h1').first().text().trim() || $('title').first().text().trim();
    const nameMatch = title.match(/([A-Za-z0-9]{3,18}-[A-Za-z0-9]{3,18})/);
    const name = nameMatch ? nameMatch[1] : correctedName;

    // Prefer the actual map image from the tracker page.
    const imageCandidates = [];
    const pushImage = value => {
        if (!value) return;
        const raw = String(value).trim().replace(/^['"]|['"]$/g, '');
        if (raw) imageCandidates.push(raw);
    };

    $('meta[property="og:image"],meta[name="twitter:image"],meta[itemprop="image"]').each((_, el) => pushImage($(el).attr('content')));
    $('img').each((_, el) => {
        pushImage($(el).attr('src'));
        pushImage($(el).attr('data-src'));
        pushImage($(el).attr('data-lazy-src'));
        const ss = $(el).attr('srcset') || $(el).attr('data-srcset');
        if (ss) pushImage(ss.split(',').pop().trim().split(/\s+/)[0]);
    });
    $('[style*="background-image"]').each((_, el) => {
        const style = $(el).attr('style') || '';
        const m = style.match(/url\((['"]?)(.*?)\1\)/i);
        if (m) pushImage(m[2]);
    });
    $('a[href*="img_webp"],a[href$=".png"],a[href$=".jpg"],a[href$=".jpeg"],a[href$=".webp"],a[href$=".gif"]').each((_, el) => pushImage($(el).attr('href')));

    const imageUrlRe = /https?:[^"'\s<>]+?\.(?:png|jpe?g|webp|gif)(?:\?[^"'\s<>]*)?/ig;
    for (const m of sourceText.matchAll(imageUrlRe)) pushImage(m[0]);

    let mapImage = '';
    for (const raw of [...new Set(imageCandidates)]) {
        try {
            const absolute = new URL(raw, url).href;
            if (/\.(?:png|jpe?g|webp|gif)(?:[?#].*)?$/i.test(absolute) || /img_webp/i.test(absolute)) {
                mapImage = absolute;
                break;
            }
        } catch (_) {}
    }

    const tunnel = sourceText.match(/TUNNEL(?:_BLACK)?_[A-Z_]+/i);
    return {
        name,
        tier: tier ? 'T' + tier[1] : 'ไม่พบข้อมูล',
        layout: '',
        connection: tunnel ? tunnel[0].toUpperCase() : '',
        counts,
        countMeta,
        mapImage,
        sourceUrl: url,
        source: 'Avalon Roads Tracker'
    };
}

async function fetchAlbionRoadsMapData(lookupName) {
    const resolved = await resolveAvaMapName(lookupName);
    const queryName = resolved.name || lookupName;
    const queryUrl = `${ALBION_ROADS_SOURCE}?search=${encodeURIComponent(queryName)}`;
    let lastError = null;
    const urls = [queryUrl, ALBION_ROADS_SOURCE];
    for (const url of urls) {
        try {
            const response = await cloudscraper.get({
                uri: url,
                timeout: 15000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154 Safari/537.36',
                    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                    Referer: 'https://albionroads.com/'
                }
            });
            const html = String(response || '');
            const $ = cheerio.load(html);
            const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
            const foundName = bodyText.toLowerCase().includes(queryName.toLowerCase());
            const tierMatch = bodyText.match(/\bT([468])\b/i);
            const counts = {
                'Gold chest': extractAvaCountFromPageText(bodyText, ['Baú Dourado', 'Gold chest', 'Gold Chest']),
                'Blue chest': extractAvaCountFromPageText(bodyText, ['Baú Azul', 'Blue chest', 'Blue Chest']),
                'Green chest': extractAvaCountFromPageText(bodyText, ['Baú Verde', 'Green chest', 'Green Chest']),
                'Group dungeon': extractAvaCountFromPageText(bodyText, ['Masmorra de Grupo', 'Group dungeon']),
                'Solo dungeon': extractAvaCountFromPageText(bodyText, ['Masmorra Solo', 'Solo dungeon']),
                Wood: extractAvaCountFromPageText(bodyText, ['Madeira', 'Wood']), Ore: extractAvaCountFromPageText(bodyText, ['Minério', 'Ore']),
                Stone: extractAvaCountFromPageText(bodyText, ['Pedra', 'Stone']), Hide: extractAvaCountFromPageText(bodyText, ['Pelego / Couro', 'Couro', 'Hide']), Fiber: extractAvaCountFromPageText(bodyText, ['Algodão / Fibra', 'Fibra', 'Fiber'])
            };
            const mapImage = extractAlbionRoadsImage($, url, queryName);
            if (!foundName && !Object.values(counts).some(Boolean)) continue;
            return { name: queryName, tier: tierMatch ? `T${tierMatch[1]}` : 'ไม่พบข้อมูล', counts, mapImage, sourceUrl: queryUrl, source: 'albionroads.com', resolvedScore: resolved.score };
        } catch (err) { lastError = err; }
    }
    throw new Error(`Albion Roads ไม่สามารถตอบข้อมูลได้${lastError ? ` (${lastError.message})` : ''}`);
}

async function fetchAvaMapDataWithFallback(mapName, ocrCandidates = []) {
    const errors = [];

    let bestData = null;
    const mergeCandidate = (candidate, sourceName) => {
        if (!candidate) return;
        const incoming = normalizeAvaDataTotals(candidate);
        if (!bestData) {
            bestData = incoming;
            bestData.providerSources = [sourceName];
            return;
        }
        const mergedCounts = { ...normalizeAvaDataTotals(bestData).counts };
        for (const key of Object.keys(mergedCounts)) {
            mergedCounts[key] = Math.max(
                Number(mergedCounts[key]) || 0,
                Number(incoming.counts?.[key]) || 0
            );
        }
        const currentPoints = avaDataPointCount(bestData);
        const incomingPoints = avaDataPointCount(incoming);
        bestData = normalizeAvaDataTotals({
            ...bestData,
            // Merge map identity metadata even when this source has fewer POI counts.
            name: incoming.name || bestData.name,
            tier: (incoming.tier && incoming.tier !== 'ไม่พบข้อมูล' && incoming.tier !== 'TIER UNKNOWN')
                ? incoming.tier : (bestData.tier || ''),
            layout: (incoming.layout && incoming.layout !== 'ไม่พบข้อมูล')
                ? incoming.layout : (bestData.layout || ''),
            connection: incoming.connection || bestData.connection,
            counts: mergedCounts,
            mapImage: bestData.mapImage || incoming.mapImage,
            sourceUrl: bestData.sourceUrl || incoming.sourceUrl,
            providerSources: [...new Set([...(bestData.providerSources || []), sourceName])]
        });
        console.log('🗺️ AVA merged POI source ' + sourceName +
            ': total=' + avaDataPointCount(bestData) +
            ' counts=' + JSON.stringify(bestData.counts));
    };

    // Avoid resolving the same OCR result twice. If mapName is already the
    // corrected/canonical candidate, go straight to the data source.
    let lookupName = mapName;
    const normalizedMap = normalizeAvaLookupName(mapName);
    const normalizedCorrection = normalizeAvaLookupName(normalizeAvaOcrMapName(mapName));
    const candidateMatchesMap =
        normalizedCorrection === normalizedMap &&
        ocrCandidates.some(candidate =>
            normalizeAvaLookupName(candidate) === normalizedMap ||
            normalizeAvaLookupName(normalizeAvaOcrMapName(candidate)) === normalizedMap
        );

    if (!candidateMatchesMap || !ocrCandidates.length) {
        try {
            const inputs = [mapName, ...ocrCandidates].filter(Boolean);
            const ranked = [];
            for (const input of inputs) {
                const resolved = await resolveAvaMapName(input);
                if (resolved?.name) ranked.push({ input, ...resolved });
            }
            ranked.sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
            if (ranked[0] && Number(ranked[0].score || 0) >= 0.62) {
                lookupName = ranked[0].name;
                console.log('🗺️ AVA fuzzy map match: OCR=' + mapName +
                    ' candidates=' + JSON.stringify(ocrCandidates.slice(0, 8)) +
                    ' -> canonical=' + lookupName + ' score=' + Number(ranked[0].score || 0).toFixed(3));
            }
        } catch (err) {
            console.warn('⚠️ AVA fuzzy name resolver failed: ' + err.message);
        }
    } else {
        console.log('🗺️ AVA using already-resolved map name: ' + lookupName);
    }

    // Primary: Battle Hub canonical page. It has the verified map title,
    // POI counts and image in one request, so do not wait for a slow tracker
    // endpoint before using it.
    try {
        const direct = normalizeAvaDataTotals(await fetchAvaMapData(lookupName));
        if (direct?.name) direct.name = normalizeAvaOcrMapName(direct.name);
        if (avaDataPointCount(direct) > 0 || direct.mapImage) {
            mergeCandidate(direct, 'Battle Hub direct');
            if (avaDataPointCount(direct) > 0) {
                console.log('🗺️ AVA direct canonical source found POIs; checking other sources for missing counts');
            }
        } else {
            errors.push('Battle Hub direct: พบหน้าแต่ไม่มีตัวเลข POI');
        }
    } catch (err) {
        errors.push('Battle Hub direct: ' + err.message);
        console.warn('⚠️ AVA direct canonical source failed for ' + mapName + ': ' + err.message);
    }

    // Secondary: Avalon Roads Tracker — dedicated Roads of Avalon map database.
    try {
        const primary = normalizeAvaDataTotals(await fetchAvalonTrackerMapData(lookupName));
        if (avaDataPointCount(primary) > 0) {
            if (primary?.name) primary.name = normalizeAvaOcrMapName(primary.name);
            mergeCandidate(primary, 'Avalon Roads Tracker');
            if (!bestData.mapImage) {
                try {
                    const imageData = await fetchBattleHubMapData(lookupName);
                    if (imageData?.mapImage) bestData.mapImage = imageData.mapImage;
                    if ((!bestData.name || bestData.name === lookupName) && imageData?.name) bestData.name = imageData.name;
                } catch (imageErr) {
                    console.warn('⚠️ AVA map image enrichment failed: ' + imageErr.message);
                }
            }
        } else {
            errors.push('Avalon Roads Tracker: พบหน้าแต่ไม่มีตัวเลข POI');
        }
    } catch (err) {
        errors.push('Avalon Roads Tracker: ' + err.message);
        console.warn('⚠️ AVA Avalon Roads Tracker unavailable for ' + mapName + ': ' + err.message);
    }

    // Fallbacks: other static Avalon map databases.
    const fallbackSources = [
        ['Albion Battle Hub', fetchBattleHubMapData],
        ['Albion Online Builds', fetchAlbionOnlineBuildsAvaMapData],
        ['Albion Roads', fetchAlbionRoadsMapData]
    ];
    for (const [sourceName, fetcher] of fallbackSources) {
        try {
            const data = normalizeAvaDataTotals(await fetcher(lookupName));
            if (avaDataPointCount(data) > 0) {
                if (data?.name) data.name = normalizeAvaOcrMapName(data.name);
                mergeCandidate(data, sourceName);
            } else {
                errors.push(sourceName + ': พบหน้าแต่ไม่มีตัวเลข');
            }
        } catch (err) {
            errors.push(sourceName + ': ' + err.message);
            console.warn('⚠️ AVA ' + sourceName + ' fallback failed for ' + mapName + ': ' + err.message);
        }
    }

    // Merge partial POI counts across providers before falling back to identity-only.
    if (bestData && avaDataPointCount(bestData) > 0) {
        bestData.name = normalizeAvaOcrMapName(bestData.name || lookupName);
        bestData.counts = { ...normalizeAvaDataTotals(bestData).counts };

        // Last-known verified Battle Hub POIs for Ponitos-Aiayrom.
        // Only fill missing counts; never reduce values returned by a provider.
        const verifiedPoiFallbacks = {
            'ponitos-aiayrom': {
                'Green chest': 4,
                'Blue chest': 0,
                'Gold chest': 0,
                Stone: 1,
                Wood: 1,
                Ore: 1,
                Hide: 0,
                Fiber: 0,
                'Solo dungeon': 1,
                'Group dungeon': 0
            }
        };
        const verifiedCounts = verifiedPoiFallbacks[normalizeAvaSlug(bestData.name || lookupName)];
        if (verifiedCounts) {
            for (const [label, count] of Object.entries(verifiedCounts)) {
                bestData.counts[label] = Math.max(Number(bestData.counts[label]) || 0, count);
            }
            console.log('🗺️ AVA applied verified POI fallback for ' + bestData.name);
        }

        bestData = normalizeAvaDataTotals(bestData);
        console.log('🗺️ AVA merged final data: map=' + bestData.name +
            ' providers=' + JSON.stringify(bestData.providerSources || []) +
            ' counts=' + JSON.stringify(bestData.counts));
        return bestData;
    }

    // IMPORTANT: The selected name already came from the authoritative
    // Avalon map index. A failure of the POI providers (403/404/timeout)
    // must NOT turn a real map into "map not found".
    //
    // Example: Qiient-Odesas is a real T6 Roads of Avalon zone, but some
    // providers can reject the bot request while the public map still exists.
    // Return a verified identity-only record so the selector can finish and
    // the map-card renderer can still try its image fallbacks.
    try {
        const canonicalNames = await fetchAuthoritativeAvaMapIndex();
        const canonical = canonicalNames.find(name =>
            normalizeAvaLookupName(name) === normalizeAvaLookupName(lookupName)
        );

        if (canonical) {
            const verifiedName = normalizeAvaOcrMapName(canonical);
            const slug = normalizeAvaSlug(verifiedName);
            const emptyCounts = {
                'Green chest': 0,
                'Blue chest': 0,
                'Gold chest': 0,
                Stone: 0,
                Wood: 0,
                Ore: 0,
                Hide: 0,
                Fiber: 0,
                'Solo dungeon': 0,
                'Group dungeon': 0
            };
            // Verified Battle Hub snapshot retained for this map in case all
            // live POI providers reject requests (e.g. HTTP 403).
            const verifiedMapSnapshots = {
                'sasitos-umogaum': {
                    tier: 'T4',
                    counts: {
                        'Green chest': 1, 'Blue chest': 1, 'Gold chest': 0,
                        Stone: 1, Wood: 2, Ore: 1, Hide: 0, Fiber: 0,
                        'Solo dungeon': 1, 'Group dungeon': 0
                    }
                }
            };
            const snapshot = verifiedMapSnapshots[slug];
            const finalCounts = snapshot ? { ...emptyCounts, ...snapshot.counts } : emptyCounts;

            console.warn(
                '⚠️ AVA map is verified but POI providers are unavailable: ' +
                verifiedName
            );

            return {
                slug,
                name: verifiedName,
                tier: snapshot?.tier || '',
                layout: '',
                connection: '',
                counts: finalCounts,
                totalChests: Number(finalCounts['Green chest'] || 0) + Number(finalCounts['Blue chest'] || 0) + Number(finalCounts['Gold chest'] || 0),
                totalResources: Number(finalCounts.Stone || 0) + Number(finalCounts.Wood || 0) + Number(finalCounts.Ore || 0) + Number(finalCounts.Hide || 0) + Number(finalCounts.Fiber || 0),
                totalDungeons: Number(finalCounts['Solo dungeon'] || 0) + Number(finalCounts['Group dungeon'] || 0),
                mapImage: 'https://albionbattlehub.com/api/og/avalon?slug=' + encodeURIComponent(slug),
                sourceUrl: 'https://albiononline.th.gl/db/locations/' + encodeURIComponent(slug),
                verifiedOnly: true,
                providerErrors: errors
            };
        }
    } catch (err) {
        console.warn('⚠️ AVA authoritative verification fallback failed: ' + err.message);
    }

    throw new Error('ไม่พบข้อมูล AVA สำหรับ "' + mapName + '"\n' + errors.join('\n'));
}
async function downloadImageForCanvas(url) {
    if (!url) return null;
    try {
        // Do not let a slow public image host block the Discord interaction.
        const response = await axios.get(url, {
            responseType: 'arraybuffer', timeout: 5000,
            headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'image/*,*/*;q=0.8' },
            validateStatus: status => status >= 200 && status < 300
        });
        return await loadImage(Buffer.from(response.data));
    } catch (_) { return null; }
}

function avaIdentityFallback(mapName) {
    try {
        const lm = require('./ava-maps.js');
        const TIERS = lm.TIERS || {};
        const search = String(mapName||'').toLowerCase();
        let foundKey = Object.keys(TIERS).find(k => k.toLowerCase() === search);
        if (!foundKey) {
            const normalized = search.replace(/[^a-z0-9]/g, '');
            foundKey = Object.keys(TIERS).find(k => k.toLowerCase().replace(/[^a-z0-9]/g,'') === normalized);
        }
        const key = foundKey || mapName;
        const tier = foundKey ? TIERS[foundKey] : (TIERS[mapName] || 'T?');
        return { name: key, tier: tier || 'T?', mapImage: null };
    } catch (e) {
        return { name: mapName, tier: 'T?', mapImage: null };
    }
}

async function downloadAvaImageBuffer(data, mapName) {
    const slug = normalizeAvaSlug(data?.name || mapName);
    const slugLower = String(slug || '').toLowerCase();
    const slugOriginal = String(slug || '');

    const GITHUB_BASE_RAW = 'https://raw.githubusercontent.com/ledcbr888-code/albion-discord-bot/main/avalon';
    const GITHUB_BASE_CDN = 'https://cdn.jsdelivr.net/gh/ledcbr888-code/albion-discord-bot@main/avalon';





    // GitHub ONLY - ตามที่คุณต้องการ: https://github.com/ledcbr888-code/albion-discord-bot/tree/main/avalon อย่างเดียว
    const githubCandidates = [
        `${GITHUB_BASE_RAW}/${encodeURIComponent(slugLower)}.webp`,
        `${GITHUB_BASE_CDN}/${encodeURIComponent(slugLower)}.webp`,
        `${GITHUB_BASE_RAW}/${encodeURIComponent(slugOriginal)}.webp`,
        `${GITHUB_BASE_CDN}/${encodeURIComponent(slugOriginal)}.webp`,
        `${GITHUB_BASE_RAW}/${encodeURIComponent(slugLower)}.png`,
        `${GITHUB_BASE_CDN}/${encodeURIComponent(slugLower)}.png`,
        `${GITHUB_BASE_RAW}/${encodeURIComponent(slugOriginal)}.png`,
        `${GITHUB_BASE_CDN}/${encodeURIComponent(slugOriginal)}.png`,
    ];

    for (const url of githubCandidates) {
        try {
            console.log('🔍 [GitHub ONLY] Trying: ' + url);
            const response = await axios.get(url, {
                responseType: 'arraybuffer', timeout: 10000,
                headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AlbionBot/1.0)', Accept: 'image/png,image/webp,image/*,*/*;q=0.8' },
                validateStatus: s => s >= 200 && s < 300
            });
            const buffer = Buffer.from(response.data);
            if (buffer.length < 1000) {
                console.warn('⚠️ GitHub too small ' + buffer.length + ' bytes for ' + url + ' - skip');
                continue;
            }
            const head = buffer.slice(0, 30).toString('utf8');
            if (head.includes('<!DOCTYPE') || head.includes('<html')) {
                console.warn('⚠️ GitHub returned HTML for ' + url + ' - skip');
                continue;
            }
            const image = await loadImage(buffer);
            if (!image.width || !image.height) throw new Error('invalid dimensions');
            console.log('✅ [GitHub ONLY] HIT with BOSS BOT watermark: ' + url + ` (${(buffer.length/1024).toFixed(1)} KB) ${image.width}x${image.height}`);
            return buffer;
        } catch (err) {
            console.warn('⚠️ [GitHub ONLY] failed ' + url + ': ' + (err.response?.status || err.message));
        }
    }

    // Local fallback (same machine, not external web)
    const localCandidates = [
        path.join(__dirname, 'avalon', `${slugLower}.png`),
        path.join(__dirname, 'avalon', `${slugOriginal}.png`),
    ];
    for (const p of localCandidates) {
        try {
            if (fs.existsSync(p)) {
                const b = await fs.promises.readFile(p);
                const img = await loadImage(b);
                if (img.width && img.height) {
                    console.log('✅ [LOCAL] HIT: ' + p);
                    return b;
                }
            }
        } catch {}
    }

    console.error('❌ [GitHub ONLY] Map image not found for ' + slugLower + ' - please upload to https://github.com/ledcbr888-code/albion-discord-bot/tree/main/avalon/' + slugLower + '.png');
    return null;
}


async function withAvaTimeout(promise, timeoutMs, label) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(label + ' timeout after ' + timeoutMs + 'ms')), timeoutMs);
            })
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

function getDiscordOriginalAttachmentUrl(url) {
    try {
        const parsed = new URL(String(url));
        if (!/media\.discordapp\.net$/i.test(parsed.hostname)) return String(url);
        parsed.hostname = 'cdn.discordapp.com';
        parsed.search = '';
        return parsed.href;
    } catch (_) { return String(url || ''); }
}

const AVA_CARD_ICON_FILES = {
    Gold: path.join(__dirname, 'ava-icons', 'Gold.png'),
    Blue: path.join(__dirname, 'ava-icons', 'Blue.png'),
    Green: path.join(__dirname, 'ava-icons', 'Green.png'),
    GroupDungeon: path.join(__dirname, 'ava-icons', 'GroupDungeon.png'),
    SoloDungeon: path.join(__dirname, 'ava-icons', 'SoloDungeon.png'),
    Fiber: path.join(__dirname, 'ava-icons', 'Fiber.png'),
    Hide: path.join(__dirname, 'ava-icons', 'Hide.png'),
    Ore: path.join(__dirname, 'ava-icons', 'Ore.png'),
    Stone: path.join(__dirname, 'ava-icons', 'Stone.png'),
    Wood: path.join(__dirname, 'ava-icons', 'Wood.png')
};
const avaCardIconCache = new Map();

async function loadAvaCardIcon(name) {
    if (avaCardIconCache.has(name)) return avaCardIconCache.get(name);
    const file = AVA_CARD_ICON_FILES[name];
    if (!file || !fs.existsSync(file)) return null;
    try {
        const image = await loadImage(file);
        avaCardIconCache.set(name, image);
        return image;
    } catch (_) { return null; }
}

async function processAvaImageMessageInternal(message, fallbackAttachments = []) {
    // Never OCR images posted by bots, including this bot's own map report.
    // The raw gateway fallback calls this function directly and bypasses the
    // messageCreate author.bot guard.
    if (message?.author?.bot) return false;
    const messageGuildId = message?.guildId || message?.guild?.id;
    if (!messageGuildId) return false;
    const messageChannelId = message.channelId || message.channel?.id;
    if (!messageChannelId) return false;

    // AVA message handling must be isolated by guild, but must not depend on
    // AsyncLocalStorage. messageCreate can run outside the interaction scope.
    const guildConfig = getGuildConfig(String(messageGuildId));
    const configured = Array.isArray(guildConfig?.avaAuto) ? guildConfig.avaAuto : [];
    const channelIds = new Set([
        String(messageChannelId),
        message.channel?.id ? String(message.channel.id) : null,
        message.channel?.parentId ? String(message.channel.parentId) : null
    ].filter(Boolean));

    const config = configured.find(x =>
        x?.enabled !== false &&
        String(x?.guildId || messageGuildId) === String(messageGuildId) &&
        channelIds.has(String(x?.channelId || ''))
    );

    if (!config) return false;

    console.log('🗺️ AVA message received in configured channel: guild=' + messageGuildId +
        ' channel=' + messageChannelId + ' message=' + message.id);

    // IMPORTANT: Message Content Intent must also be enabled in Discord Developer Portal.
    // The REST fetch below is a second line of defense when Gateway attachment metadata
    // is incomplete or missing.
    let sourceMessage = message;
    const getAttachmentList = source => {
        const value = source?.attachments;
        if (!value) return [];
        if (typeof value.values === 'function') return [...value.values()];
        if (typeof value.array === 'function') return value.array();
        if (Array.isArray(value)) return value;
        if (typeof value === 'object') return Object.values(value);
        return [];
    };
    let attachments = getAttachmentList(message);

    if (!attachments.length && Array.isArray(fallbackAttachments) && fallbackAttachments.length) {
        attachments = fallbackAttachments;
        console.log('🗺️ AVA using raw MESSAGE_CREATE attachments: ' + attachments.length);
    }

    if (!attachments.length && typeof message.fetch === 'function') {
        try {
            // Force a REST fetch. Some gateway payloads contain an empty
            // attachment collection while the REST representation is complete.
            sourceMessage = await message.fetch(true);
            attachments = getAttachmentList(sourceMessage);
            console.log('🗺️ AVA message refetched: guild=' + messageGuildId +
                ' channel=' + messageChannelId + ' attachments=' + attachments.length);
        } catch (err) {
            console.warn('⚠️ AVA message refetch failed: ' + err.message);
        }
    }

    const isImageAttachment = a => {
        const name = String(a?.name || '');
        const url = String(a?.url || '');
        const proxyUrl = String(a?.proxyURL || a?.proxyUrl || '');
        const type = String(a?.contentType || a?.content_type || '');
        return /^image\//i.test(type) ||
            /\.(?:png|jpe?g|webp|gif)(?:[?#]|$)/i.test(name) ||
            /\.(?:png|jpe?g|webp|gif)(?:[?#]|$)/i.test(url) ||
            /\.(?:png|jpe?g|webp|gif)(?:[?#]|$)/i.test(proxyUrl);
    };

    let imageAttachments = attachments.filter(isImageAttachment);

    // Some Discord CDN attachments may have missing MIME/extension metadata.
    // Probe every attachment URL until one can actually be decoded as an image.
    if (!imageAttachments.length) {
        for (const candidate of attachments) {
            if (!candidate?.url) continue;
            try {
                if (!isAllowedAvaImageUrl(candidate.url)) continue;
                const probe = await axios.get(candidate.url, {
                    responseType: 'arraybuffer',
                    timeout: 8000,
                    maxContentLength: AVA_MAX_IMAGE_BYTES,
                    maxBodyLength: AVA_MAX_IMAGE_BYTES,
                    headers: {
                        'User-Agent': 'Mozilla/5.0',
                        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
                    },
                    validateStatus: status => status >= 200 && status < 300
                });
                if (Buffer.byteLength(probe.data) > AVA_MAX_IMAGE_BYTES) continue;
                await loadImage(Buffer.from(probe.data));
                imageAttachments = [candidate];
                console.log('🗺️ AVA decoded extensionless attachment: guild=' + messageGuildId +
                    ' channel=' + messageChannelId);
                break;
            } catch (_) {}
        }
    }

    // Also support images represented as Discord embeds/link previews.
    if (!imageAttachments.length) {
        const embedImage = (sourceMessage.embeds || []).map(e => e?.image?.url || e?.thumbnail?.url).find(Boolean);
        if (embedImage) {
            imageAttachments = [{ url: embedImage, name: 'discord-embed-image.png', contentType: 'image/png' }];
            console.log('🗺️ AVA detected image from embed: guild=' + messageGuildId +
                ' channel=' + messageChannelId);
        }
    }

    if (!imageAttachments.length) {
        console.log('ℹ️ AVA ignored message ' + message.id +
            ': configured channel but no readable image attachment. ' +
            'gatewayAttachments=' + (message.attachments?.size || 0) +
            ' fetchedAttachments=' + attachments.length);
        return false;
    }

    console.log('🗺️ AVA image detected: guild=' + messageGuildId +
        ' channel=' + messageChannelId + ' file=' + (imageAttachments[0].name || 'unknown'));

    const priorState = getGuildConfig(String(messageGuildId), false)?.avaMessageStates?.[String(message.id)]?.state;
    if (priorState === 'succeeded' || priorState === 'unclear' || avaProcessedMessages.has(message.id)) return true;
    if (avaProcessingMessages.has(String(message.id))) return true;
    const now = Date.now();
    if (avaUserRateLimit.size > 1000) for (const [key, stamp] of avaUserRateLimit) if (now - stamp > 10 * 60 * 1000) avaUserRateLimit.delete(key);
    const rateKey = String(message.author?.id || messageChannelId), lastRun = avaUserRateLimit.get(rateKey) || 0;
    if (now - lastRun < AVA_USER_COOLDOWN_MS) { console.log('⏳ AVA rate limit: skipped rapid repeat from user=' + rateKey); return true; }
    avaUserRateLimit.set(rateKey, now); avaProcessingMessages.add(String(message.id));
    setAvaMessageState(messageGuildId, message.id, 'processing');

    let status;
    try {
        status = await message.reply('🗺️ กำลังอ่านชื่อแมพ AVA จากรูป...');
    } catch (err) {
        setAvaMessageState(messageGuildId, message.id, 'failed', 'Could not post OCR status reply: ' + err.message);
        avaProcessingMessages.delete(String(message.id));
        console.error('❌ AVA reply failed:', err.message);
        return true;
    }

    // Do not mark the message processed yet: OCR/provider failures must remain retryable.

    try {
        const attachmentUrl = String(imageAttachments[0].url || '');
        const imageUrls = [...new Set([
            getDiscordOriginalAttachmentUrl(attachmentUrl),
            attachmentUrl
        ].filter(Boolean))];
        let imageBuffer = null;
        let lastImageError = null;
        for (const imageUrl of imageUrls) {
            try {
                if (!isAllowedAvaImageUrl(imageUrl)) throw new Error('อนุญาตเฉพาะ URL รูปจาก Discord CDN เท่านั้น');
                const imageResponse = await axios.get(imageUrl, {
                    responseType: 'arraybuffer',
                    maxContentLength: AVA_MAX_IMAGE_BYTES,
                    maxBodyLength: AVA_MAX_IMAGE_BYTES,
                    timeout: imageUrl === getDiscordOriginalAttachmentUrl(attachmentUrl) ? 3500 : 12000,
                    headers: {
                        'User-Agent': 'Mozilla/5.0',
                        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
                    },
                    validateStatus: status => status >= 200 && status < 300
                });
                const candidateBuffer = Buffer.from(imageResponse.data);
                if (candidateBuffer.length > AVA_MAX_IMAGE_BYTES) throw new Error('ไฟล์รูปใหญ่เกิน 10 MB');
                await loadImage(candidateBuffer);
                imageBuffer = candidateBuffer;
                console.log('🗺️ AVA image source selected: ' + imageUrl.replace(/([?&](?:ex|is|hm)=)[^&]+/gi, '$1…'));
                break;
            } catch (err) { lastImageError = err; }
        }
        if (!imageBuffer) throw lastImageError || new Error('ดาวน์โหลดรูปจาก Discord ไม่สำเร็จ');
        if (imageBuffer.length > AVA_MAX_IMAGE_BYTES) throw new Error('ไฟล์รูปใหญ่เกิน 10 MB');
        const ocr = await detectAvaMapNameFromImage(imageBuffer);
        console.log('🗺️ AVA OCR result: ' + JSON.stringify({
            mapName: ocr?.mapName || '',
            candidates: ocr?.candidates || [],
            rawText: String(ocr?.rawText || '').slice(0, 300)
        }));

        if (!ocr.mapName) {
            // An unreadable screenshot is terminal for this message: do not let the poller OCR it again.
            setAvaMessageState(messageGuildId, message.id, 'unclear', 'OCR could not confidently read map name; user must submit a clearer screenshot.');
            const exampleImageUrl = 'https://raw.githubusercontent.com/ledcbr888-code/albion-discord-bot/main/assets/AVA.png';
            const helpEmbed = new EmbedBuilder()
                .setColor(0xF1C40F)
                .setTitle('ตัวอย่างรูปที่ชัดเจน / Example of a clear screenshot')
                .setImage(exampleImageUrl);
            await status.edit({
                content:
                    '⚠️ **บอทยังอ่านชื่อแมพจากรูปนี้ไม่ได้**\n' +
                    '⚠️ **The bot couldn\'t detect the map name in this screenshot.**\n\n' +
                    '**วิธีแก้ไข:** กดปุ่ม **N** เพื่อเปิดแผนที่ แล้วถ่ายภาพใหม่ให้เห็นแถบชื่อแมพครบและชัดเจน ส่งภาพต้นฉบับที่มีความละเอียดเพียงพอ อย่าส่งภาพที่ชื่อแมพเล็กหรือถูกตัดออก\n' +
                    '**How to fix it:** Press **N** to open the map. Take a new screenshot with the full map name clearly visible. Upload the original, full-resolution screenshot; make sure the map name is not too small or cropped out.',
                embeds: [helpEmbed],
                components: []
            }).catch(editErr => console.error('❌ AVA unreadable-image guidance reply failed:', editErr.message));
            console.warn('⚠️ AVA image marked unclear; automatic reprocessing disabled for message=' + message.id);
            return true;
        }

        const ocrCandidates = [ocr.mapName, ...(ocr.candidates || [])].filter(Boolean);
        const suggestions = await getAvaMapSuggestions(ocrCandidates, 3);
        const top = suggestions[0];

        // Never auto-process here. The user must always choose a real map name
        // from the selector, even when OCR is an exact/high-confidence match.
        if (!suggestions.length) {
            const localAliasSuggestions = [];
            for (const raw of ocrCandidates) {
                const corrected = normalizeAvaOcrMapName(raw).replace(/\s+/g, '');
                if (!corrected) continue;
                if (normalizeAvaLookupName(corrected) === normalizeAvaLookupName(raw)) continue;
                if (localAliasSuggestions.some(x => normalizeAvaLookupName(x.name) === normalizeAvaLookupName(corrected))) continue;
                localAliasSuggestions.push({ name: corrected, score: 1, exact: true, source: 'OCR alias fallback' });
            }

            if (localAliasSuggestions.length) {
                suggestions.push(...localAliasSuggestions);
            } else {
                throw new Error(
                    'ไม่สามารถโหลดรายชื่อแมพ Avalon จากฐานข้อมูลจริงได้\n' +
                    'กรุณาลองกด 🔄 อ่านรูปใหม่อีกครั้ง'
                );
            }
        }

        const token = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-6);
        avaPendingSelections.set(token, {
            guildId: String(messageGuildId),
            channelId: String(messageChannelId),
            userId: String(message.author?.id || ''),
            messageId: String(message.id),
            statusMessage: status,
            imageBuffer,
            ocrName: ocr.mapName,
            ocrCandidates,
            suggestions,
            createdAt: Date.now()
        });

        await status.edit({
            content:
                '🗺️ **ตรวจพบภาพ AVA**\n' +
                'OCR อ่านได้: \`' + String(ocr.mapName) + '\`\n\n' +
                '⚠️ ชื่อแมพยังไม่มั่นใจ 100%\n' +
                '**เลือกชื่อแมพที่ใกล้เคียงกับในรูป:**',
            components: avaSelectionComponents(messageGuildId, token, suggestions)
        });
        setAvaMessageState(messageGuildId, message.id, 'succeeded', 'OCR and map selector ready');
        avaProcessedMessages.add(message.id);
        if (avaProcessedMessages.size > 500) avaProcessedMessages.delete(avaProcessedMessages.values().next().value);
        saveData();

        setTimeout(() => {
            const pending = avaPendingSelections.get(token);
            if (!pending) return;
            avaPendingSelections.delete(token);
            pending.statusMessage.edit({
                content: '⏰ หมดเวลาการเลือกชื่อแมพ AVA แล้ว กรุณาส่งรูปอีกครั้ง',
                components: []
            }).catch(() => {});
        }, 120000);
    } catch (err) {
        setAvaMessageState(messageGuildId, message.id, 'failed', err.message);
        console.error('❌ AVA image auto-check error:', err);
        await status.edit({
            content: '❌ ตรวจภาพ AVA ไม่สำเร็จ: ' + err.message
        }).catch(editErr => console.error('❌ AVA error reply edit failed:', editErr.message));
    } finally {
        avaProcessingMessages.delete(String(message.id));
    }

    return true;
}

async function processAvaImageMessage(message, fallbackAttachments = []) { return runAvaWithConcurrency(() => processAvaImageMessageInternal(message, fallbackAttachments), message); }

// ----------------------------------------
// BANDIT ASSAULT (ASIA) SCHEDULE & ALERTS
// Source: user-provided Asia schedule reference image.
// ----------------------------------------
const BANDIT_ASSAULT_SCHEDULE_UTC = [
    // Asia (East) local times in ICT: 09:00, 12:00, 14:00, 16:00, 18:00, 20:00, 22:00.
    // Stored as UTC hours because the scheduler builds dates with setUTCHours().
    { hour: 2, chance: 30 },
    { hour: 5, chance: 30 },
    { hour: 7, chance: 50 },
    { hour: 9, chance: 60 },
    { hour: 11, chance: 40 },
    { hour: 13, chance: 60 },
    { hour: 15, chance: 60 }
];
const BANDIT_ALERT_WINDOW_MINUTES = 15;
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

const BANDIT_BACKGROUND_FILE = path.join(__dirname, 'caerleon-background.jpg');
const BANDIT_COIN_FILE = path.join(__dirname, 'caerleon-coin-transparent.png');
let banditArtworkPromise = null;

function drawCoverImage(ctx, image, x, y, width, height) {
    const sourceRatio = image.width / image.height;
    const targetRatio = width / height;
    let sx = 0, sy = 0, sw = image.width, sh = image.height;
    if (sourceRatio > targetRatio) { sw = image.height * targetRatio; sx = (image.width - sw) / 2; }
    else { sh = image.width / targetRatio; sy = (image.height - sh) / 2; }
    ctx.drawImage(image, sx, sy, sw, sh, x, y, width, height);
}

function loadBanditArtwork() {
    if (!banditArtworkPromise) {
        banditArtworkPromise = Promise.all([
            fs.existsSync(BANDIT_BACKGROUND_FILE) ? loadImage(BANDIT_BACKGROUND_FILE) : null,
            fs.existsSync(BANDIT_COIN_FILE) ? loadImage(BANDIT_COIN_FILE) : null
        ]).catch(err => {
            console.warn('⚠️ Bandit artwork load failed:', err.message);
            return [null, null];
        });
    }
    return banditArtworkPromise;
}

function banditAlertComponents(guildId, eventStamp, confirmedCount = 0, notOccurredCount = 0, hasBanditRole = false) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`bandit_confirm:${guildId}:${eventStamp}`)
            .setLabel(`ยืนยันการเกิด (${confirmedCount})`)
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId(`bandit_notoccur:${guildId}:${eventStamp}`)
            .setLabel(`ไม่เกิด (${notOccurredCount})`)
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setCustomId(`bandit_role:${guildId}`)
            .setLabel(hasBanditRole ? 'กดอีกครั้งยกเลิกรับแจ้งเตือน' : 'กดเพื่อรับยศแจ้งเตือน')
            .setStyle(hasBanditRole ? ButtonStyle.Secondary : ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`bandit_status:${guildId}`).setLabel('ดูรอบถัดไป').setStyle(ButtonStyle.Primary)
    );
}

async function checkAndSendBanditAlerts() {
    if (banditSchedulerRunning) return;
    banditSchedulerRunning = true;
    try {
    const guilds = getAllGuildConfigs();
    for (const { guildId } of guilds) {
        await guildContext.run({ guildId }, async () => {
            await checkAndSendBanditAlertsForGuild();
        });
    }
    } finally { banditSchedulerRunning = false; }
}

async function checkAndSendBanditAlertsForGuild() {
    if (!banditAutoConfigs.length) return;
    const now = new Date();
    const event = getNextBanditAssault(now);
    if (!event) return;

    const minutesUntil = (event.start - now) / 60000;
    // Alert at the 15-minute mark; if the bot was restarted later, alert once
    // immediately while still showing the accurate remaining countdown.
    if (minutesUntil <= BANDIT_ALERT_WINDOW_MINUTES && minutesUntil > 0) {
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
                const imageHour = event.start.toLocaleTimeString('en-GB', {
                    timeZone: 'Asia/Bangkok', hour: '2-digit', hour12: false
                });
                const imageName = `bandit-${imageHour}00.png`;
                const imagePath = path.join(__dirname, 'assets', imageName);
                if (!fs.existsSync(imagePath)) {
                    throw new Error(`Bandit image asset not found: ${imagePath}`);
                }
                const card = new AttachmentBuilder(imagePath, { name: imageName });
                const eventStamp = String(event.start.getTime());
                // Resolve the BANDIT role from the actual Discord server each alert.
                // This repairs saved configs where banditRoleId is missing or stale.
                const alertGuild = channel.guild || await client.guilds.fetch(config.guildId).catch(() => null);
                let banditRole = null;
                if (alertGuild && config.banditRoleId) {
                    banditRole = await alertGuild.roles.fetch(config.banditRoleId).catch(() => null);
                }
                if (!banditRole && alertGuild) {
                    banditRole = alertGuild.roles.cache.find(role => role.name.toUpperCase() === 'BANDIT') || null;
                    if (!banditRole) {
                        const allRoles = await alertGuild.roles.fetch().catch(() => null);
                        banditRole = allRoles?.find(role => role.name.toUpperCase() === 'BANDIT') || null;
                    }
                }
                const roleId = banditRole?.id || null;
                if (roleId && config.banditRoleId !== roleId) {
                    config.banditRoleId = roleId;
                    saveData();
                }
                if (!roleId) {
                    console.warn(`⚠️ BANDIT role not found in guild ${config.guildId}; alert will be sent without a role mention.`);
                }
                const alertMessage = await channel.send({
                    content: `${roleId ? `<@&${roleId}> ` : ''}⚔️ **BANDIT ASSAULT — ASIA**\nกำลังจะเริ่มใน **${banditCountdownText(minutesUntil)}**\n🕒 เวลาเริ่ม: **${ictTime} น.**\n🎲 โอกาสเกิด: **${chanceLabel}**`,
                    files: [card],
                    allowedMentions: { parse: [], roles: roleId ? [roleId] : [] },
                    components: [banditAlertComponents(config.guildId, eventStamp, (config.banditConfirmations?.[eventStamp] || []).length, (config.banditNotOccurred?.[eventStamp] || []).length)]
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
    ...ctaModule.commandBuilders,
    new SlashCommandBuilder().setName('check').setDescription('ระบบตรวจสอบสถิติและรายชื่อ')
        .addSubcommand(s => s.setName('battles').setDescription('เช็กสถิติไฟต์จาก Match ID หรือ ลิงก์').addStringOption(o => o.setName('link_or_id').setDescription('ลิงก์ AlbionBB หรือ Match ID').setRequired(true)))
        .addSubcommand(s => s.setName('guilds').setDescription('แสดงรายชื่อกิลด์ที่ติดตาม'))
        .addSubcommand(s => s.setName('members').setDescription('แสดงรายชื่อผู้เล่นที่ติดตาม')),
    new SlashCommandBuilder().setName('add').setDescription('เพิ่มรายการติดตาม')
        .addSubcommand(s => s.setName('guild').setDescription('เพิ่มกิลด์ที่ต้องการติดตามทั้งกิลด์')
            .addStringOption(o => o.setName('name').setDescription('ชื่อกิลด์').setRequired(true)))
        .addSubcommand(s => s.setName('player').setDescription('เพิ่มผู้เล่น').addStringOption(o => o.setName('name').setDescription('ชื่อผู้เล่น').setRequired(true))),
    new SlashCommandBuilder().setName('remove').setDescription('ลบรายการติดตาม')
        .addSubcommand(s => s.setName('guild').setDescription('ลบกิลด์').addStringOption(o => o.setName('name').setDescription('ชื่อกิลด์').setRequired(true)))
        .addSubcommand(s => s.setName('player').setDescription('ลบผู้เล่น').addStringOption(o => o.setName('name').setDescription('ชื่อผู้เล่น').setRequired(true))),
    new SlashCommandBuilder().setName('battlelink').setDescription('จัดการระบบรายงานเมื่อมีคนวางลิงก์ Battle')
        .addSubcommand(s => s.setName('setup').setDescription('ตั้งค่าห้องสำหรับตรวจลิงก์ Battle อัตโนมัติ')
            .addChannelOption(o => o.setName('channel').setDescription('ห้องที่ให้บอทตรวจลิงก์ AlbionBB').addChannelTypes(ChannelType.GuildText).setRequired(true)))
        .addSubcommand(s => s.setName('status').setDescription('ดูห้องที่ตั้งค่าตรวจลิงก์ Battle'))
        .addSubcommand(s => s.setName('remove').setDescription('ยกเลิกระบบตรวจลิงก์ Battle')),
    new SlashCommandBuilder().setName('autobattle').setDescription('จัดการระบบติดตามไฟต์อัตโนมัติ')
        .addSubcommand(s => s.setName('set').setDescription('ตั้งค่าระบบติดตามไฟต์อัตโนมัติ')
            .addChannelOption(o => o.setName('channel').setDescription('ห้องที่ต้องการให้แจ้งเตือน').addChannelTypes(ChannelType.GuildText).setRequired(true))
            .addStringOption(o => o.setName('guild').setDescription('ชื่อ Guild ที่ต้องการติดตาม').setRequired(true))
            .addStringOption(o => o.setName('min_frames').setDescription('Fame ขั้นต่ำ เช่น 50K (Fame รวมของรายการติดตาม)').setRequired(true))
            .addStringOption(o => o.setName('guild_id').setDescription('Guild ID หรือ URL กิลด์ เช่น https://albiononline.com/killboard/guild/<ID>')))
        .addSubcommand(s => s.setName('list').setDescription('แสดงรายชื่อกิลด์ที่ตั้งค่า Auto-Battle ในเซิร์ฟเวอร์นี้'))
        .addSubcommand(s => s.setName('remove').setDescription('ลบกิลด์ที่ตั้งค่า Auto-Battle ออก')
            .addStringOption(o => o.setName('guild').setDescription('ชื่อ Guild ที่ต้องการยกเลิกติดตาม Auto-Battle').setRequired(true))),
    new SlashCommandBuilder().setName('ava').setDescription('เช็กข้อมูลแผนที่ Roads of Avalon เป็นภาษาไทย')
        .addSubcommand(s => s.setName('check').setDescription('เช็กกล่อง ทรัพยากร ดันเจี้ยน และ Connection ของแมพ AVA')
            .addStringOption(o => o.setName('map').setDescription('ชื่อแมพ เช่น Casitos-Alieam หรือ URL ของแมพ').setRequired(true)))
        .addSubcommand(s => s.setName('setup').setDescription('ตั้งค่าห้องสำหรับตรวจจับรูป AVA อัตโนมัติ')
            .addChannelOption(o => o.setName('channel').setDescription('ห้องที่บอทจะตรวจรูป AVA อัตโนมัติ').addChannelTypes(ChannelType.GuildText).setRequired(true)))
        .addSubcommand(s => s.setName('status').setDescription('ดูห้องที่ตั้งค่าตรวจรูป AVA อัตโนมัติ'))
        .addSubcommand(s => s.setName('remove').setDescription('ยกเลิกการตรวจรูป AVA อัตโนมัติ'))
     ,new SlashCommandBuilder().setName('bandit').setDescription('แจ้งเตือนกิจกรรม Bandit Assault เซิร์ฟเวอร์ Asia')
        .addSubcommand(s => s.setName('setup').setDescription('ตั้งค่าการแจ้งเตือน Bandit Assault ล่วงหน้า 15 นาที')
            .addChannelOption(o => o.setName('channel').setDescription('ห้องที่ต้องการให้แจ้งเตือน').addChannelTypes(ChannelType.GuildText).setRequired(true))
            .addStringOption(o => o.setName('server').setDescription('เซิร์ฟเวอร์ของตาราง Bandit Assault').setRequired(true)
                .addChoices({ name: '🌏 Asia (East)', value: 'asia' })))
        .addSubcommand(s => s.setName('status').setDescription('ดูรอบ Bandit Assault ครั้งถัดไป'))
        .addSubcommand(s => s.setName('remove').setDescription('ยกเลิกการแจ้งเตือน Bandit Assault'))
].map(c => c.toJSON());


async function pollAvaConfiguredChannels() {
    if (avaPollRunning) return;
    avaPollRunning = true;
    try {
    const seenChannels = new Set();

    for (const [guildId, cfg] of Object.entries(guildConfigs || {})) {
        const avaConfigs = Array.isArray(cfg?.avaAuto) ? cfg.avaAuto.filter(x => x?.enabled !== false && x?.channelId) : [];
        for (const avaConfig of avaConfigs) {
            const channelId = String(avaConfig.channelId);
            const stateKey = String(guildId) + ':' + channelId;
            seenChannels.add(stateKey);

            try {
                const channel = await client.channels.fetch(channelId);
                if (!channel?.messages?.fetch) continue;

                const fetched = await channel.messages.fetch({ limit: 10, cache: false });
                const messages = [...fetched.values()].sort((a, b) => {
                    try { return Number(BigInt(String(a.id)) - BigInt(String(b.id))); }
                    catch (_) { return String(a.id).localeCompare(String(b.id)); }
                });
                if (!messages.length) continue;
                const latestId = String(messages[messages.length - 1].id);
                const previousId = avaPollState.get(stateKey);
                if (!previousId) {
                    avaPollState.set(stateKey, latestId);
                    console.log('🗺️ AVA poll baseline: guild=' + guildId + ' channel=' + channelId + ' latest=' + latestId);
                    continue;
                }
                const newer = messages.filter(message => {
                    try { return BigInt(String(message.id)) > BigInt(previousId); }
                    catch (_) { return String(message.id) !== String(previousId); }
                });
                const retryableFailures = messages.filter(message => {
                    const state = getGuildConfig(String(guildId), false)?.avaMessageStates?.[String(message.id)];
                    const isUnreadableOcrFailure = /อ่านชื่อแมพจากรูปไม่สำเร็จ|OCR:/i.test(String(state?.details || ''));
                    return state?.state === 'failed' && !isUnreadableOcrFailure &&
                        (Number(state.attempts) || 0) < 3 &&
                        Date.now() - (Number(state.updatedAt) || 0) >= 30000;
                });
                const workMessages = [...new Map([...newer, ...retryableFailures].map(message => [String(message.id), message])).values()];
                if (workMessages.length) {
                    avaPollState.set(stateKey, latestId);
                    for (const message of workMessages) {
                        if (message.author?.bot) continue;
                        try {
                            await guildContext.run({ guildId }, async () => { await processAvaImageMessage(message); });
                        } catch (err) {
                            console.error('❌ AVA poll message error:', err.message);
                        }
                    }
                } else {
                    avaPollState.set(stateKey, latestId);
                }
            } catch (err) {
                console.warn('⚠️ AVA poll failed for channel ' + channelId + ': ' + err.message);
            }
        }
    }

    for (const key of avaPollState.keys()) {
        if (!seenChannels.has(key)) avaPollState.delete(key);
    }
    } finally { avaPollRunning = false; }
}

client.once('ready', async () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    await migrateLegacyDataAfterReady();
    const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('✅ Slash commands registered.');
    } catch (err) { console.error('❌ Slash command registration error:', err); }

    setTimeout(async () => {
        let seeded = 0;
        const serverConfigs = getAllGuildConfigs();
        for (const { guildId, config } of serverConfigs) {
            const serverAutoBattles = Array.isArray(config?.autoBattles) ? config.autoBattles : [];
            if (!serverAutoBattles.length) continue;
            try {
                seeded += await guildContext.run({ guildId }, async () =>
                    primeAutoBattleHistoryForGuild(serverAutoBattles)
                );
            } catch (err) {
                console.warn(`⚠️ Auto-Battle startup baseline failed for Discord server ${guildId}: ${err.message}`);
            }
        }
        console.log(`🛡️ Auto-Battle initialization pass complete: newly marked ${seeded} existing battle(s) across ${serverConfigs.length} Discord server configuration(s); previously initialized trackers keep their saved baseline, and pending trackers will retry during polling.`);
    }, 5000);

    function getAutoBattleIntervalMs() {
        const intervalMs = 60 * 1000;
        console.log('⏱️ รอบตรวจ Auto-Battle ถัดไปใน 60 วินาที');
        return intervalMs;
    }

    function scheduleNextAutoBattleCheck() {
        const ms = getAutoBattleIntervalMs();
        setTimeout(async () => {
            try { await checkAutoBattles(); } 
            catch (err) { console.error('❌ Auto-Battle scheduler error:', err); }
            finally { scheduleNextAutoBattleCheck(); }
        }, ms);
    }
    scheduleNextAutoBattleCheck();
    setTimeout(() => pollAvaConfiguredChannels().catch(err => console.error('❌ AVA initial poll error:', err)), 3000);
    setInterval(() => pollAvaConfiguredChannels().catch(err => console.error('❌ AVA poll error:', err)), 5000);
    fetchBattleHubMapIndex()
        .then(names => console.log('🗺️ AVA canonical map cache ready: ' + names.length + ' maps'))
        .catch(err => console.warn('⚠️ AVA canonical map cache preload failed: ' + err.message));
    setTimeout(() => checkAndSendBanditAlerts().catch(err => console.error('❌ Initial Bandit check error:', err)), 5000);
    setInterval(() => checkAndSendBanditAlerts().catch(err => console.error('❌ Bandit scheduler error:', err)), 60 * 1000);
});

client.on('interactionCreate', async interaction => {
    const contextGuildId = interaction.guildId ||
        ((interaction.isButton() || interaction.isStringSelectMenu()) ? interaction.customId.split(':')[1] : null);
    return guildContext.run({ guildId: contextGuildId }, async () => {
    try { if (await ctaModule.handleInteraction(interaction, { getGuildConfig, saveData, client })) return; } catch (ctaErr) { console.error('❌ CTA handler error:', ctaErr); try { if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: '❌ เกิดข้อผิดพลาดใน CTA: ' + (ctaErr.message || ctaErr), flags: 64 }); else if (interaction.deferred) await interaction.editReply({ content: '❌ เกิดข้อผิดพลาดใน CTA: ' + (ctaErr.message || ctaErr) }); } catch {} return; }
    if (interaction.isStringSelectMenu() || interaction.isButton()) {
        const parts = String(interaction.customId || '').split(':');
        const action = parts[0];
        if (['ava_select', 'ava_retry', 'ava_cancel'].includes(action)) {
            const guildId = parts[1];
            const token = parts[2];
            const pending = avaPendingSelections.get(token);

            if (!pending || String(pending.guildId) !== String(guildId)) {
                return interaction.reply({ content: '⏰ รายการเลือกแมพนี้หมดอายุแล้ว กรุณาส่งรูป AVA ใหม่อีกครั้ง', ephemeral: true });
            }

            if (String(pending.userId || '') && String(interaction.user.id) !== String(pending.userId)) {
                return interaction.reply({ content: '🔒 รายการเลือกแมพนี้เป็นของผู้ส่งรูปเท่านั้น', ephemeral: true });
            }

            if (action === 'ava_cancel') {
                await interaction.update({
                    content: '❌ ยกเลิกการเลือกชื่อแมพ AVA แล้ว',
                    components: []
                });
                avaPendingSelections.delete(token);
                return;
            }

            if (action === 'ava_retry') {
                await interaction.deferUpdate();
                try {
                    const ocr = await detectAvaMapNameFromImage(pending.imageBuffer);
                    const ocrCandidates = [ocr?.mapName, ...(ocr?.candidates || [])].filter(Boolean);
                    const suggestions = await getAvaMapSuggestions(ocrCandidates, 3);

                    pending.ocrName = ocr?.mapName || pending.ocrName;
                    pending.ocrCandidates = ocrCandidates;
                    pending.suggestions = suggestions;

                    if (!suggestions.length) {
                        return interaction.editReply({
                            content: '❌ อ่านรูปใหม่แล้ว แต่ยังหาชื่อแมพที่ใกล้เคียงไม่พบ',
                            components: []
                        });
                    }

                    await interaction.editReply({
                        content:
                            '🔄 **อ่านรูป AVA ใหม่แล้ว**\n' +
                            'OCR อ่านได้: \`' + String(pending.ocrName || 'ไม่พบ') + '\`\n\n' +
                            'เลือกชื่อแมพที่ใกล้เคียงกับในรูป:',
                        components: avaSelectionComponents(guildId, token, suggestions)
                    });
                } catch (err) {
                    await interaction.editReply({
                        content: '❌ อ่านรูป AVA ใหม่ไม่สำเร็จ: ' + err.message,
                        components: []
                    });
                }
                return;
            }

            if (action === 'ava_select') {
                const selectedName = String(interaction.values?.[0] || '').trim();
                const allowed = pending.suggestions.some(x => String(x.name) === selectedName);
                if (!selectedName || !allowed) {
                    return interaction.reply({ content: '❌ ตัวเลือกแมพไม่ถูกต้องหรือหมดอายุแล้ว', ephemeral: true }).catch(()=>{});
                }

                // Don't delete pending yet - keep it until we succeed, so retry works
                console.log('🗺️ AVA map selected: guild=' + guildId + ' channel=' + interaction.channelId + ' map=' + selectedName + ' OCR=' + String(pending.ocrName || ''));

                try {
                    // Safe acknowledge - handle already acknowledged case (duplicate bot instance or double click)
                    try {
                        if (interaction.replied || interaction.deferred) {
                            await interaction.editReply({
                                content: '🔎 เลือก **' + selectedName + '** แล้ว กำลังค้นหาข้อมูลแมพ...',
                                components: []
                            });
                        } else {
                            await interaction.update({
                                content: '🔎 เลือก **' + selectedName + '** แล้ว กำลังค้นหาข้อมูลแมพ...',
                                components: []
                            });
                        }
                    } catch (ackErr) {
                        if (String(ackErr.message).includes('already been acknowledged') || ackErr.code === 40060) {
                            console.warn('⚠️ Interaction already acknowledged for ' + selectedName + ', trying editReply fallback');
                            try {
                                await interaction.editReply({
                                    content: '🔎 เลือก **' + selectedName + '** แล้ว กำลังค้นหาข้อมูลแมพ...',
                                    components: []
                                });
                            } catch (e) {
                                console.warn('⚠️ editReply fallback also failed:', e.message);
                                // If we can't even edit, try followUp and continue
                                try {
                                    await interaction.followUp({ content: '🔎 กำลังค้นหา **' + selectedName + '** ...', ephemeral: true });
                                } catch {}
                            }
                        } else {
                            throw ackErr;
                        }
                    }

                    // Keep the original AVA selection flow: the fallback resolver already
                    // handles OCR aliases. Do not refetch the authoritative index here,
                    // because a slow index request can stall the selected-map interaction.
                    const canonicalName = selectedName;
                    console.log('🗺️ AVA lookup starting: selected=' + selectedName +
                        ' candidates=' + JSON.stringify([selectedName, ...pending.ocrCandidates].slice(0, 8)));

                    // ===== ULTRA FAST PATH: GitHub เป็นหลัก ไม่รอเว็บนอก =====
                    // ดึงรูปจาก GitHub คุณก่อนเลย 0.3-0.8 วิ
                    let imageBuffer = null;
                    let data = null;
                    try {
                        // ลองดึงรูปจาก GitHub โดยตรงก่อน - ไม่ต้องรอข้อมูล POI
                        imageBuffer = await withAvaTimeout(
                            downloadAvaImageBuffer({ name: canonicalName, mapImage: null }, selectedName),
                            6000,
                            'AVA GitHub image'
                        );
                        console.log('⚡ AVA ULTRA FAST HIT: GitHub image for ' + selectedName);
                        // ใช้ fallback data สำหรับชื่อ/Tier
                        data = avaIdentityFallback(selectedName);
                    } catch (fastErr) {
                        console.warn('⚠️ AVA fast path failed for ' + selectedName + ': ' + fastErr.message + ' -> falling back to full lookup');
                    }

                    // GitHub ONLY mode: ถ้าไม่ได้รูปจาก GitHub จะไม่มี fallback ไปเว็บนอก
                    // ใช้แค่ข้อมูลจาก ava-maps.js (Tier) ที่มีในเครื่อง
                    if (!data) {
                        data = avaIdentityFallback(selectedName);
                        console.log('ℹ️ [GitHub ONLY] Using local tier data for ' + selectedName + ': ' + (data.tier || 'T?'));
                    }
                    if (!imageBuffer) {
                        try {
                            imageBuffer = await withAvaTimeout(
                                downloadAvaImageBuffer(data, selectedName),
                                8000,
                                'AVA image download'
                            );
                        } catch (imageErr) {
                            console.warn('⚠️ AVA image attachment fallback for ' + selectedName + ': ' + imageErr.message);
                        }
                    }
                    if (!imageBuffer) {
                        console.warn('⚠️ [GitHub ONLY] No image from GitHub for ' + selectedName + ' - will send text only');
                    }

                    // Fix Tier lookup - case insensitive + proper name normalization
                    const normalizedSelectedName = (function(){ try { const lm = require('./ava-maps.js'); const tiers = lm.TIERS||{}; const keys = Object.keys(tiers); const found = keys.find(k => k.toLowerCase() === String(selectedName||'').toLowerCase()) || keys.find(k => k.toLowerCase() === String(data?.name||'').toLowerCase()); return found || selectedName; } catch { return selectedName; } })();
                    const tierLabel = (function(){ try { const lm = require('./ava-maps.js'); const tr = lm.TIERS||{}; const exact = tr[normalizedSelectedName] || tr[selectedName] || tr[data?.name] || tr[Object.keys(tr).find(k=>k.toLowerCase()===String(normalizedSelectedName||'').toLowerCase())] || tr[Object.keys(tr).find(k=>k.toLowerCase()===String(selectedName||'').toLowerCase())]; if (exact) return exact; const m = String(data?.tier||'').match(/T\s*\d+/i); return m ? m[0].replace(/\s+/g,'').toUpperCase() : 'T?'; } catch { const m = String(data?.tier||'').match(/T\s*\d+/i); return m ? m[0].replace(/\s+/g,'').toUpperCase() : 'T?'; } })();
                    if (data && normalizedSelectedName) data.name = normalizedSelectedName; // Fix name to proper case like Hilitos-Aiigaum not hilitos-aiigaum
                    // Do not include map metadata text or provider links in the report message,
                    // because Discord can render them as an embed alongside the image.
                    const reportPayload = {
                        ...(imageBuffer ? { files: [new AttachmentBuilder(imageBuffer, { name: 'ava-map.png' })] } : {})
                    };
                    // Upload through the channel message endpoint instead of
                    // editing the component interaction with a file. Some
                    // Discord clients/gateways leave the interaction message
                    // stuck at “กำลังค้นหา...” when editReply includes files.
                    if (interaction.channel?.send) {
                        await interaction.channel.send(reportPayload);
                        await interaction.editReply({
                            content: '✅ ส่งรูปข้อมูลแมฟ **' + data.name + ' (' + tierLabel + ')** แล้ว',
                            components: []
                        });
                    } else {
                        await interaction.editReply({
                            ...reportPayload,
                            components: []
                        });
                    }
                    console.log('✅ AVA map report sent: map=' + data.name + ' image=' + (imageBuffer ? 'yes' : 'no') + ' points=' + avaDataPointCount(data));
                    avaPendingSelections.delete(token);
                } catch (err) {
                    console.error('❌ AVA selected map lookup error for ' + selectedName + ':', err);
                    avaPendingSelections.delete(token);
                    try {
                        if (interaction.replied || interaction.deferred) {
                            await interaction.editReply({
                                content: '❌ ค้นหาแมพ **' + selectedName + '** ไม่สำเร็จ: ' + err.message,
                                components: []
                            });
                        } else {
                            await interaction.reply({ content: '❌ ค้นหาแมพ **' + selectedName + '** ไม่สำเร็จ: ' + err.message, ephemeral: true });
                        }
                    } catch (replyErr) {
                        console.warn('⚠️ Failed to reply error message:', replyErr.message);
                        try {
                            await interaction.followUp({ content: '❌ ค้นหาแมพ **' + selectedName + '** ไม่สำเร็จ: ' + err.message, ephemeral: true });
                        } catch {}
                        // Also send to channel as fallback
                        try {
                            if (interaction.channel?.send) {
                                await interaction.channel.send('❌ ค้นหาแมพ **' + selectedName + '** ไม่สำเร็จ: ' + err.message);
                            }
                        } catch {}
                    }
                }
                return;
            }
        }
    }

    if (interaction.isButton()) {
        const [action, guildId, eventStamp] = interaction.customId.split(':');
        if (action === 'bandit_confirm') {
            const config = banditAutoConfigs.find(c => c.guildId === guildId);
            if (!config) return interaction.reply({ content: '❌ ไม่พบการตั้งค่า Bandit Assault นี้', ephemeral: true });
            if (interaction.message?.id !== config.lastMessageId) {
                return interaction.reply({ content: 'ℹ️ ปุ่มนี้เป็นการแจ้งเตือนรอบเก่าแล้ว', ephemeral: true });
            }
            const eventKey = new Date(Number(eventStamp)).toISOString();
            if (config.lastEventKey !== eventKey) {
                return interaction.reply({ content: 'ℹ️ ปุ่มนี้เป็นการแจ้งเตือนรอบเก่าแล้ว', ephemeral: true });
            }
            if (!config.banditConfirmations || typeof config.banditConfirmations !== 'object') config.banditConfirmations = {};
            const voters = Array.isArray(config.banditConfirmations[eventStamp]) ? config.banditConfirmations[eventStamp] : [];
            if (voters.includes(interaction.user.id)) {
                return interaction.reply({ content: `คุณยืนยันรอบนี้แล้ว (รวม ${voters.length} คน)`, ephemeral: true });
            }
            if (!config.banditNotOccurred || typeof config.banditNotOccurred !== 'object') config.banditNotOccurred = {};
            config.banditNotOccurred[eventStamp] = (config.banditNotOccurred[eventStamp] || []).filter(id => id !== interaction.user.id);
            voters.push(interaction.user.id);
            config.banditConfirmations[eventStamp] = voters;
            saveData();
            await interaction.update({ components: [banditAlertComponents(guildId, eventStamp, voters.length, (config.banditNotOccurred[eventStamp] || []).length)] });
            return;
        }
        if (action === 'bandit_notoccur') {
            const config = banditAutoConfigs.find(c => c.guildId === guildId);
            if (!config) return interaction.reply({ content: '❌ ไม่พบการตั้งค่า Bandit Assault นี้', ephemeral: true });
            if (interaction.message?.id !== config.lastMessageId || config.lastEventKey !== new Date(Number(eventStamp)).toISOString()) return interaction.reply({ content: 'ℹ️ ปุ่มนี้เป็นการแจ้งเตือนรอบเก่าแล้ว', ephemeral: true });
            if (!config.banditNotOccurred || typeof config.banditNotOccurred !== 'object') config.banditNotOccurred = {};
            const voters = Array.isArray(config.banditNotOccurred[eventStamp]) ? config.banditNotOccurred[eventStamp] : [];
            if (voters.includes(interaction.user.id)) return interaction.reply({ content: `คุณกดไม่เกิดรอบนี้แล้ว (รวม ${voters.length} คน)`, ephemeral: true });
            if (!config.banditConfirmations || typeof config.banditConfirmations !== 'object') config.banditConfirmations = {};
            config.banditConfirmations[eventStamp] = (config.banditConfirmations[eventStamp] || []).filter(id => id !== interaction.user.id);
            voters.push(interaction.user.id);
            config.banditNotOccurred[eventStamp] = voters;
            saveData();
            await interaction.update({ components: [banditAlertComponents(guildId, eventStamp, (config.banditConfirmations[eventStamp] || []).length, voters.length)] });
            return;
        }
        if (['bandit_role', 'bandit_role_remove', 'bandit_role_add'].includes(action)) {
            const config = banditAutoConfigs.find(c => c.guildId === guildId);
            if (!config?.banditRoleId || !interaction.guild) return interaction.reply({ content: '❌ ยังไม่พบยศ BANDIT ของเซิร์ฟเวอร์นี้ ให้ผู้ดูแลใช้ /bandit setup ใหม่', ephemeral: true });
            const role = await interaction.guild.roles.fetch(config.banditRoleId).catch(() => null);
            const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
            if (!role || !member) return interaction.reply({ content: '❌ ไม่พบยศหรือสมาชิกในเซิร์ฟเวอร์', ephemeral: true });
            const botMember = interaction.guild.members.me || await interaction.guild.members.fetchMe().catch(() => null);
            if (!botMember?.permissions.has(PermissionsBitField.Flags.ManageRoles) || role.position >= botMember.roles.highest.position) return interaction.reply({ content: '❌ บอทไม่มีสิทธิ์จัดการยศ BANDIT โปรดให้สิทธิ์ Manage Roles และย้ายยศบอทให้อยู่สูงกว่ายศ BANDIT', ephemeral: true });
            const shouldRemove = action === 'bandit_role_remove' || (action === 'bandit_role' && member.roles.cache.has(role.id));
            if (shouldRemove) {
                if (member.roles.cache.has(role.id)) await member.roles.remove(role, 'ผู้ใช้ยกเลิกรับการแจ้งเตือน Bandit');
                const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`bandit_role_add:${guildId}`).setLabel('กดเพื่อรับยศแจ้งเตือน').setStyle(ButtonStyle.Primary));
                return interaction.reply({ content: '🔕 ยกเลิกรับแจ้งเตือนแล้ว หากต้องการรับอีกครั้งกดปุ่มด้านล่าง', components: [row], ephemeral: true });
            }
            if (!member.roles.cache.has(role.id)) await member.roles.add(role, 'ผู้ใช้สมัครรับการแจ้งเตือน Bandit');
            const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`bandit_role_remove:${guildId}`).setLabel('กดอีกครั้งยกเลิกรับแจ้งเตือน').setStyle(ButtonStyle.Danger));
            return interaction.reply({ content: '✅ ได้รับยศ BANDIT แล้ว เมื่อมีแจ้งเตือนจะถูกแท็กยศนี้', components: [row], ephemeral: true });
        }
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
            if (!targetGuilds.length) return interaction.reply({ content: '🛡️ ไม่มีกิลด์ในระบบติดตาม', flags: 64 });
            const listFormatted = targetGuilds.map((g, i) => `${i + 1}. ${g.name}`).join('\n');
            return interaction.reply({ content: `🛡️ **กิลด์ที่ติดตาม (${targetGuilds.length})**\n\`\`\`\n${listFormatted}\n\`\`\``, flags: 64 });
        }
        if (sub === 'members') {
            if (!targetPlayers.length) return interaction.reply({ content: '📋 ไม่มีผู้เล่นในระบบติดตาม', flags: 64 });
            return interaction.reply({ content: `📋 **ผู้เล่นที่ติดตาม (${targetPlayers.length})**\n\`\`\`\n${targetPlayers.map((x, i) => `${i + 1}. ${x}`).join('\n')}\n\`\`\``, flags: 64 });
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

            const existingIndex = targetGuilds.findIndex(x => x.name.toLowerCase() === name.toLowerCase());
            if (existingIndex >= 0) {
                return interaction.reply({ content: `⚠️ กิลด์ **${name}** อยู่ในรายการติดตามแล้ว`, flags: 64 });
            }

            targetGuilds.push({ name });
            saveData();
            return interaction.reply({ content: `🛡️ เพิ่มกิลด์ **${name}** ในรายการติดตามเรียบร้อยแล้ว`, flags: 64 });
        }
        if (sub === 'player') {
            const name = interaction.options.getString('name').trim();
            if (targetPlayers.some(x => x.toLowerCase() === name.toLowerCase())) return interaction.reply({ content: `⚠️ ผู้เล่น **${name}** มีอยู่แล้ว`, flags: 64 });
            targetPlayers.push(name); saveData(); return interaction.reply({ content: `✅ เพิ่มผู้เล่น **${name}** แล้ว`, flags: 64 });
        }
    }

    if (commandName === 'remove') {
        const sub = interaction.options.getSubcommand(), name = interaction.options.getString('name').trim();
        if (sub === 'guild') {
            const before = targetGuilds.length; 
            targetGuilds = targetGuilds.filter(x => x.name.toLowerCase() !== name.toLowerCase());
            if (before === targetGuilds.length) return interaction.reply({ content: `❌ ไม่พบกิลด์ **${name}**`, flags: 64 });
            saveData(); return interaction.reply({ content: `🗑️ ลบกิลด์ **${name}** แล้ว`, flags: 64 });
        }
        if (sub === 'player') {
            const before = targetPlayers.length; targetPlayers = targetPlayers.filter(x => x.toLowerCase() !== name.toLowerCase());
            if (before === targetPlayers.length) return interaction.reply({ content: `❌ ไม่พบผู้เล่น **${name}**`, flags: 64 });
            saveData(); return interaction.reply({ content: `🗑️ ลบผู้เล่น **${name}** แล้ว`, flags: 64 });
        }
    }

    if (commandName === 'battlelink') {
        const sub = interaction.options.getSubcommand();
        const config = getGuildConfig(interaction.guildId, true);
        if (sub === 'setup') {
            const channel = interaction.options.getChannel('channel');
            config.battleLinkChannelId = channel.id;
            saveData();
            return interaction.reply({ content: `✅ ตั้งค่ารายงาน Battle Link แล้ว\n📢 ห้องตรวจลิงก์: <#${channel.id}>\nเมื่อมีการวางลิงก์ AlbionBB ในห้องนี้ บอทจะรายงาน Kills, Deaths และผลรวม พร้อมภาพ Battle Report ถ้าสร้างภาพสำเร็จ`, flags: 64 });
        }
        if (sub === 'status') {
            return interaction.reply({ content: config.battleLinkChannelId ? `🔗 ระบบ Battle Link: เปิดใช้งาน\n📢 ห้อง: <#${config.battleLinkChannelId}>` : 'ℹ️ ยังไม่ได้ตั้งค่าระบบ Battle Link ใช้ /battlelink setup เพื่อตั้งค่าห้อง', flags: 64 });
        }
        if (sub === 'remove') {
            if (!config.battleLinkChannelId) return interaction.reply({ content: 'ℹ️ ยังไม่ได้ตั้งค่าระบบ Battle Link', flags: 64 });
            config.battleLinkChannelId = null;
            saveData();
            return interaction.reply({ content: '🗑️ ยกเลิกระบบ Battle Link แล้ว โดยไม่เปลี่ยนการตั้งค่า /add guild หรือ /autobattle', flags: 64 });
        }
    }

    if (commandName === 'autobattle') {
        const sub = interaction.options.getSubcommand();

        if (sub === 'set') {
            await interaction.deferReply({ flags: 64 });
            const channel = interaction.options.getChannel('channel');
            const guildInput = interaction.options.getString('guild').trim();
            const explicitGuildId = interaction.options.getString('guild_id')?.trim() || '';
            const parsedGuild = parseGuildReference(guildInput);
            const parsedExplicitGuildId = parseGuildReference(explicitGuildId);
            const guildName = parsedGuild.name || (parsedGuild.id ? '' : guildInput);
            const targetGuildId = parsedExplicitGuildId.id || parsedGuild.id || '';
            const guildLabel = guildName || targetGuildId || guildInput;
            const minFramesInput = interaction.options.getString('min_frames');
            const minFrames = parseFameValue(minFramesInput);

            let existingConfigs = autoBattleConfigs.filter(c => c.guildId === interaction.guildId);
            const duplicateIndex = existingConfigs.findIndex(c =>
                (targetGuildId && c.targetGuildId === targetGuildId) ||
                (guildName && (c.targetGuild || '').toLowerCase() === guildName.toLowerCase())
            );
            const existingConfig = duplicateIndex >= 0 ? existingConfigs[duplicateIndex] : null;
            const baselineAlreadyInitialized = existingConfig
                ? (typeof existingConfig.baselineInitialized === 'boolean'
                    ? existingConfig.baselineInitialized
                    : processedBattles.size > 0)
                : false;

            const configData = {
                guildId: interaction.guildId,
                channelId: channel.id,
                targetGuild: guildName,
                targetGuildId: targetGuildId || undefined,
                minFrames: minFrames,
                baselineInitialized: baselineAlreadyInitialized,
                createdAt: new Date().toISOString()
            };

            if (duplicateIndex >= 0) {
                const globalIndex = autoBattleConfigs.findIndex(c => c.guildId === interaction.guildId && ((targetGuildId && c.targetGuildId === targetGuildId) || (guildName && (c.targetGuild || '').toLowerCase() === guildName.toLowerCase())));
                if (globalIndex >= 0) autoBattleConfigs[globalIndex] = configData;
            } else {
                autoBattleConfigs.push(configData);
            }
            // Acknowledge the Discord interaction before any synchronous file
            // or persistence work. This prevents the command from remaining on
            // "กำลังคิด…" even when the configuration has already been added.
            await interaction.editReply({ content: `✅ ตั้งค่า **Auto-Battle Tracker** สำเร็จเรียบร้อย!\n- 🌐 เซิร์ฟเวอร์: **EAST (ตายตัว)**\n- 📢 ห้องแจ้งเตือน: <#${channel.id}>\n- 🛡️ กิลด์ที่ติดตาม: **${guildLabel}**${targetGuildId ? ` (ID: ${targetGuildId})` : ''}\n- 💰 Fame ขั้นต่ำ: **${formatFame(minFrames)}**\n\n📌 *บันทึกการตั้งค่าแล้ว ระบบกำลังเตรียมรายการ Battle เบื้องหลัง และจะตรวจสอบไฟต์ใหม่ทุกๆ 60 วินาทีครับ*` });

            // Persist after Discord has acknowledged the command. The in-memory
            // config is already active for the running scheduler.
            try {
                if (!saveData()) console.warn(`⚠️ Auto-Battle config saved in memory but persistence failed for ${guildLabel}.`);
            } catch (saveErr) {
                console.error(`❌ Auto-Battle config persistence error for ${guildLabel}:`, saveErr.message);
            }

            // Establish a baseline only for a new/uninitialized tracker. Keep the
            // marker false if the API is unavailable so scheduled polling can retry.
            if (configData.baselineInitialized !== true) {
                void (async () => {
                    try {
                        const recentMatches = await fetchGuildRecentBattles(configData, { baselineOnly: true });
                        if (!Array.isArray(recentMatches)) {
                            console.warn('⚠️ Auto-Battle baseline pending for ' + guildLabel +
                                '; Official API unavailable. The tracker will retry initialization on the next poll.');
                            return;
                        }
                        const existingIds = [...new Set(
                            recentMatches.map(id => String(id || '').trim()).filter(id => /^\d+$/.test(id))
                        )];
                        for (const id of existingIds) processedBattles.add(id);
                        configData.baselineInitialized = true;
                        saveData();
                        console.log('✅ Auto-Battle baseline initialized for ' + guildLabel +
                            (targetGuildId ? ' (' + targetGuildId + ')' : '') +
                            ': marked ' + existingIds.length + ' existing battle(s) as already seen.');
                    } catch (err) {
                        console.warn('⚠️ Auto-Battle baseline failed for ' + guildLabel + ': ' +
                            String(err?.message || err));
                    }
                })();
            }

            return;
        }

        if (sub === 'list') {
            const serverConfigs = autoBattleConfigs.filter(c => c.guildId === interaction.guildId);
            if (!serverConfigs.length) return interaction.reply({ content: '🛡️ เซิร์ฟเวอร์นี้ยังไม่มีการตั้งค่า Auto-Battle สำหรับกิลด์ใดๆ', flags: 64 });

            let listText = serverConfigs.map((c, i) => `${i + 1}. กิลด์: **${c.targetGuild || c.targetGuildId}**${c.targetGuildId ? ` (ID: ${c.targetGuildId})` : ''} | ห้อง: <#${c.channelId}> | ขั้นต่ำ: **${(c.minFrames || 0).toLocaleString()}**`).join('\n');
            const embed = new EmbedBuilder()
                .setColor(0x3498db)
                .setTitle(`🛡️ รายชื่อกิลด์ที่ติดตาม Auto-Battle ในเซิร์ฟเวอร์นี้ (${serverConfigs.length})`)
                .setDescription(listText)
                .setTimestamp();
            return interaction.reply({ embeds: [embed], flags: 64 });
        }

        if (sub === 'remove') {
            const guildName = interaction.options.getString('guild').trim();
            const beforeCount = autoBattleConfigs.length;
            
            autoBattleConfigs = autoBattleConfigs.filter(c => !(c.guildId === interaction.guildId && c.targetGuild.toLowerCase() === guildName.toLowerCase()));

            if (beforeCount === autoBattleConfigs.length) {
                return interaction.reply({ content: `❌ ไม่พบกิลด์ **${guildName}** ในระบบ Auto-Battle ของเซิร์ฟเวอร์นี้`, flags: 64 });
            }

            saveData();
            return interaction.reply({ content: `🗑️ ลบกิลด์ **${guildName}** ออกจากระบบ Auto-Battle เรียบร้อยแล้ว`, flags: 64 });
        }
    }

    if (commandName === 'ava') {
        const sub = interaction.options.getSubcommand();
        if (sub === 'check') {
            await interaction.deferReply();
            try {
                const embed = await generateAvaCheckResponse(interaction.options.getString('map'));
                return interaction.editReply({ embeds: [embed] });
            } catch (err) {
                console.error('❌ AVA check error:', err.message);
                return interaction.editReply(`❌ เช็กแมพ AVA ไม่สำเร็จ: \`${err.message}\`\nตัวอย่าง: \`/ava check map:Sasitos-Umogaum\``);
            }
        }
        if (sub === 'setup') {
            const channel = interaction.options.getChannel('channel');
            if (!channel?.isTextBased?.()) return interaction.reply({ content: '❌ ห้องที่เลือกไม่ใช่ห้องข้อความ', flags: 64 });
            const me = interaction.guild?.members?.me || await interaction.guild?.members?.fetchMe?.().catch(() => null);
            const permissions = channel.permissionsFor(me || client.user);
            const requiredPermissions = [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.AttachFiles];
            const missing = permissions ? permissions.missing(requiredPermissions) : requiredPermissions.map(String);
            if (missing.length) return interaction.reply({ content: '❌ บอทไม่มีสิทธิ์ครบสำหรับ AVA Auto\nห้อง: <#' + channel.id + '>\nขาด: **' + missing.join(', ') + '**\n\nให้สิทธิ์ View Channel + Read Message History + Send Messages + Attach Files แล้วลองตั้งค่าใหม่', flags: 64 });
            const setupGuildConfig = getGuildConfig(interaction.guildId);
            const existing = setupGuildConfig.avaAuto.findIndex(x => String(x.guildId) === String(interaction.guildId));
            const config = { guildId: interaction.guildId, channelId: channel.id, enabled: true };
            if (existing >= 0) setupGuildConfig.avaAuto[existing] = config;
            else setupGuildConfig.avaAuto.push(config);
            avaPollState.delete(String(interaction.guildId) + ':' + String(channel.id));
            saveData();
            setTimeout(() => pollAvaConfiguredChannels().catch(err => console.error('❌ AVA setup poll error:', err)), 500);
            return interaction.reply(
                '✅ ตั้งค่าตรวจรูป AVA อัตโนมัติแล้ว\n' +
                '📢 ห้อง: <#' + channel.id + '>\n' +
                '🟢 ระบบตรวจจับ: เปิด\n' +
                '🔎 OCR: Tesseract System + Tesseract.js\n\n' +
                'วางรูปแผนที่ AVA ในห้องนี้ได้เลย บอทจะอ่านชื่อแมพ → ค้นจาก Avalon Roads Tracker → สร้างรายงานเป็นรูปอัตโนมัติ\n\n' +
                '⚠️ สำคัญ: ต้องเปิด Message Content Intent ใน Discord Developer Portal > Bot > Privileged Gateway Intents'
            );
        }
        if (sub === 'status') {
            const config = getGuildConfig(interaction.guildId, false)?.avaAuto?.find(x => String(x.guildId) === String(interaction.guildId));
            if (!config) return interaction.reply({ ephemeral: true, content: '❌ ยังไม่ได้ตั้งค่าห้องตรวจรูป AVA อัตโนมัติ' });
            const channel = await client.channels.fetch(String(config.channelId)).catch(() => null);
            const me = interaction.guild?.members?.me || await interaction.guild?.members?.fetchMe?.().catch(() => null);
            const permissions = channel?.permissionsFor?.(me || client.user);
            const requiredPermissions = [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.AttachFiles];
            const missing = permissions ? permissions.missing(requiredPermissions) : requiredPermissions.map(String);
            const intentEnabledInCode = client.options.intents?.has?.(GatewayIntentBits.MessageContent) ? 'เปิด' : 'ปิด';
            return interaction.reply({ ephemeral: true, content:
                '🗺️ AVA AUTO CHECK\n' +
                '📢 ห้อง: <#' + config.channelId + '>\n' +
                '🟢 สถานะ: ' + (config.enabled === false ? 'ปิด' : 'เปิด') + '\n' +
                '🔐 สิทธิ์ห้อง: ' + (missing.length ? '❌ ขาด ' + missing.join(', ') : '✅ ครบ') + '\n' +
                '🧩 Message Content Intent ในโค้ด: ' + intentEnabledInCode + '\n' +
                '⚠️ Developer Portal: ต้องเปิด Message Content Intent ที่ Bot > Privileged Gateway Intents\n' +
                '⏱️ Polling fallback: ทุก 5 วินาที' });
        }
        if (sub === 'remove') {
            const removeGuildConfig = getGuildConfig(interaction.guildId, false);
            const before = removeGuildConfig?.avaAuto?.length || 0;
            if (removeGuildConfig) removeGuildConfig.avaAuto = removeGuildConfig.avaAuto.filter(x => x.guildId !== interaction.guildId);
            saveData();
            return interaction.reply(before === (removeGuildConfig?.avaAuto?.length || 0) ? '❌ ยังไม่ได้ตั้งค่า AVA Auto Check' : '🗑️ ยกเลิก AVA Auto Check เรียบร้อยแล้ว');
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
            const me = interaction.guild?.members?.me || await interaction.guild?.members?.fetchMe?.().catch(() => null);
            if (!me?.permissions.has(PermissionsBitField.Flags.ManageRoles)) return interaction.reply({ content: '❌ บอทต้องมีสิทธิ์ Manage Roles เพื่อสร้างและมอบยศ BANDIT อัตโนมัติ', ephemeral: true });
            let banditRole = interaction.guild.roles.cache.find(r => r.name === 'BANDIT');
            if (!banditRole) banditRole = await interaction.guild.roles.create({ name: 'BANDIT', color: 0x000000, mentionable: true, reason: 'Bandit Assault alert role created by /bandit setup' });
            else if (banditRole.color !== 0x000000 || !banditRole.mentionable) banditRole = await banditRole.edit({ color: 0x000000, mentionable: true, reason: 'Normalize Bandit alert role settings' });
            if (banditRole.position >= me.roles.highest.position) return interaction.reply({ content: '❌ ยศ BANDIT อยู่สูงกว่าหรือเท่ากับยศบอท กรุณาลากยศบอทให้อยู่เหนือ BANDIT แล้วใช้ /bandit setup อีกครั้ง', ephemeral: true });
            const configData = {
                guildId: interaction.guildId,
                channelId: channel.id,
                server,
                enabled: true,
                banditRoleId: banditRole.id,
                banditConfirmations: previousConfig?.banditConfirmations || {},
                banditNotOccurred: previousConfig?.banditNotOccurred || {},
                lastMessageId: previousConfig?.lastMessageId || null,
                lastEventKey: previousConfig?.lastEventKey || null
            };
            const existingIndex = banditAutoConfigs.findIndex(c => c.guildId === interaction.guildId);
            if (existingIndex >= 0) banditAutoConfigs[existingIndex] = configData;
            else banditAutoConfigs.push(configData);
            saveData();
            await checkAndSendBanditAlertsForGuild();
            return interaction.reply(
                `✅ ตั้งค่าแจ้งเตือน **Bandit Assault** สำเร็จ\n` +
                `📢 ห้องแจ้งเตือน: <#${channel.id}>\n` +
                `🌐 เซิร์ฟเวอร์: **${BANDIT_SERVER_NAMES[server] || server}**\n` +
                `⏰ บอทจะแจ้งก่อนเริ่ม ${BANDIT_ALERT_WINDOW_MINUTES} นาที\n` +
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
});


// AVA fallback listener: inspect raw MESSAGE_CREATE payloads as well.
// This keeps image detection working even when discord.js does not hydrate
// Message.attachments/content from the gateway payload as expected.
client.on('raw', async packet => {
    if (packet?.t !== 'MESSAGE_CREATE') return;
    const data = packet.d || {};
    // The bot's report contains the map image attachment. Ignore it before
    // fetching the message or entering the AVA OCR pipeline.
    if (data.author?.bot || (client.user?.id && String(data.author.id) === String(client.user.id))) return;
    const guildId = String(data.guild_id || '');
    const channelId = String(data.channel_id || '');
    const messageId = String(data.id || '');
    if (!guildId || !channelId || !messageId) return;

    const cfg = getGuildConfig(guildId);
    const avaConfig = Array.isArray(cfg?.avaAuto)
        ? cfg.avaAuto.find(x => x?.enabled !== false && String(x?.channelId || '') === channelId)
        : null;
    if (!avaConfig) return;

    console.log('🗺️ AVA raw MESSAGE_CREATE detected: guild=' + guildId +
        ' channel=' + channelId + ' message=' + messageId +
        ' attachments=' + (Array.isArray(data.attachments) ? data.attachments.length : 0));

    const rawAttachments = Array.isArray(data.attachments)
        ? data.attachments.map(a => ({ id: a?.id, name: a?.filename || a?.name || 'discord-image', url: a?.url || '', proxyURL: a?.proxy_url || a?.proxyURL || '', contentType: a?.content_type || a?.contentType || '' })).filter(a => a.url)
        : [];

    // MESSAGE_CREATE can arrive before the message is available through REST.
    // Retry a few times instead of silently losing the image forever.
    const attempt = async (retry = 0) => {
        try {
            const channel = await client.channels.fetch(channelId);
            if (!channel?.messages?.fetch) return false;
            const fetchedMessage = await channel.messages.fetch(messageId, { force: true }).catch(() => null);
            if (!fetchedMessage) {
                if (retry < 3) {
                    const timer = setTimeout(() => {
                        avaRawRetryTimers.delete(messageId);
                        attempt(retry + 1).catch(err => console.error('❌ AVA raw retry error:', err.message));
                    }, 750 * (retry + 1));
                    avaRawRetryTimers.set(messageId, timer);
                } else {
                    console.warn('⚠️ AVA raw message fetch failed for ' + messageId + '. Check View Channel + Read Message History.');
                }
                return false;
            }
            return await guildContext.run({ guildId }, async () => processAvaImageMessage(fetchedMessage, rawAttachments));
        } catch (err) {
            if (retry < 3) {
                const timer = setTimeout(() => {
                    avaRawRetryTimers.delete(messageId);
                    attempt(retry + 1).catch(retryErr => console.error('❌ AVA raw retry error:', retryErr.message));
                }, 750 * (retry + 1));
                avaRawRetryTimers.set(messageId, timer);
                return false;
            }
            throw err;
        }
    };
    if (avaRawRetryTimers.has(messageId)) return;
    try {
        await attempt(0);
    } catch (err) {
        console.error('❌ AVA raw message fetch/process error:', err.message);
    }
});

client.on('messageCreate', async message => {
    return guildContext.run({ guildId: message.guildId }, async () => {
    if (message.author.bot) return;
    console.log('📨 Discord messageCreate: guild=' + (message.guildId || 'DM') +
        ' channel=' + (message.channelId || message.channel?.id || 'unknown') +
        ' message=' + (message.id || 'unknown') +
        ' attachments=' + (message.attachments?.size || 0));
    if (message.attachments?.size) {
        console.log('📎 Discord image/message attachment received: guild=' +
            (message.guildId || 'DM') + ' channel=' +
            (message.channelId || message.channel?.id || 'unknown') +
            ' attachments=' + message.attachments.size);
    }
    try {
        const handledAva = await processAvaImageMessage(message);
        if (handledAva) return;
    } catch (err) {
        console.error('❌ AVA messageCreate error:', err.message);
    }
    const match = message.content.match(/https?:\/\/(?:east\.)?albionbb\.com\/battles\/[^\s]+/i);
    if (!match) return;
    const battleUrl = match[0].replace(/[)>\],.]+$/, '');

    const guildConfig = getGuildConfig(message.guildId, false);
    const dedicatedBattleLinkChannel = guildConfig?.battleLinkChannelId;
    if (dedicatedBattleLinkChannel && message.channel.id !== dedicatedBattleLinkChannel) return;

    // Hide the embed preview on this recognized BattleLink source message; keep its URL.
    try { if (typeof message.suppressEmbeds === 'function') await message.suppressEmbeds(true); }
    catch (err) { console.warn('⚠️ Could not suppress AlbionBB embed:', err.message); }

    const rateKey = battleUrl, now = Date.now();
    for (const [key, stamp] of battleUrlRateLimit) if (now - stamp > 10 * 60 * 1000) battleUrlRateLimit.delete(key);
    if (battleUrlRateLimit.has(rateKey) && now - battleUrlRateLimit.get(rateKey) < BATTLE_URL_COOLDOWN_MS) { console.log('⏳ Battle URL rate limit: duplicate link suppressed'); return; }
    battleUrlRateLimit.set(rateKey, now);

    try {
        const status = await message.reply('⏳ กำลังดึงสถิติและสร้างรายงานจาก Official Albion API...');
        await processBattleReport(battleUrl, status, true);
    } catch (err) { console.error('❌ messageCreate error:', err); }
    });
});

client.on('error', err => console.error('❌ Discord client error:', err));
client.on('warn', warning => console.warn('⚠️ discord.js warning:', warning));
// รายงาน Discord 429 เป็นภาษาไทย โดยใช้เวลารอที่ Discord ส่งกลับมา (หน่วย ms)
// ไม่พิมพ์ Token หรือ headers ที่อาจมีข้อมูลลับ
client.rest.on('rateLimited', info => {
    const waitMsRaw = info?.retryAfter ?? info?.timeToReset;
    const waitMs = Number(waitMsRaw);
    const validWait = waitMsRaw != null && Number.isFinite(waitMs) && waitMs >= 0;
    const waitSeconds = validWait ? Math.ceil(waitMs / 1000) : null;
    const waitMinutes = validWait ? (waitMs / 60000).toFixed(2) : null;
    const route = String(info?.route || info?.url || 'ไม่ทราบเส้นทาง').replace(/\s+/g, ' ').slice(0, 180);
    console.warn('⏳ Discord จำกัดอัตราการเรียก API (429)' +
        (info?.global ? ' [GLOBAL: มีผลกับ API โดยรวม]' : ' [เฉพาะเส้นทางนี้]'));
    if (validWait) {
        console.warn('⏳ ต้องรอ Discord ปลดจำกัด: ' + waitMs + ' ms = ' +
            waitSeconds + ' วินาที ≈ ' + waitMinutes + ' นาที');
    } else {
        console.warn('⚠️ Discord ไม่ได้ส่งเวลารอที่อ่านได้มาใน rateLimited event');
    }
    console.warn('🔎 เส้นทาง API: ' + route);
});
client.on('debug', info => {
    // discord.js includes a partial token in this debug message; never print token material.
    if (/Provided token:/i.test(String(info))) {
        console.log('🔎 discord.js debug: token supplied (value hidden)');
        return;
    }
    console.log('🔎 discord.js debug:', info);
});
client.on('shardError', err => {
    const status = Number(err?.status ?? err?.statusCode ?? err?.response?.status);
    const code = err?.code;
    const message = String(err?.message || err || 'ไม่ทราบสาเหตุ');
    if (status === 429 || Number(code) === 429 || /HTTP.?429|rate.?limit/i.test(message)) {
        console.error('❌ Discord Gateway/REST แจ้งข้อจำกัด 429:', message);
        const retry = err?.response?.headers?.['retry-after'] ?? err?.retry_after ?? err?.retryAfter;
        if (retry != null) {
            const seconds = Number(retry);
            if (Number.isFinite(seconds) && seconds >= 0) {
                console.error('⏳ เวลารอที่แจ้งมา: ' + Math.ceil(seconds) + ' วินาที (' + (seconds / 60).toFixed(2) + ' นาที)');
            } else {
                const dateMs = Date.parse(String(retry));
                if (Number.isFinite(dateMs)) {
                    const ms = Math.max(0, dateMs - Date.now());
                    console.error('⏳ เวลารอที่แจ้งมา: ' + Math.ceil(ms / 1000) + ' วินาที (' + (ms / 60000).toFixed(2) + ' นาที)');
                } else console.error('⚠️ Discord ไม่ได้ให้เวลารอที่แปลงได้:', String(retry));
            }
        } else console.error('⚠️ ข้อผิดพลาด 429 นี้ไม่มี Retry-After ให้คำนวณเวลารอ');
    } else {
        console.error('❌ Discord Gateway shard error:', message, code ? '(รหัส ' + code + ')' : '');
    }
});
client.on('shardDisconnect', (event, shardId) => console.error(`⚠️ Discord shard ${shardId} disconnected:`, event?.code || event, event?.reason || ''));
client.on('shardReconnecting', shardId => console.warn(`⚠️ Discord shard ${shardId} reconnecting`));
client.on('shardResume', (shardId, replayedEvents) => console.log(`✅ Discord shard ${shardId} resumed; replayed events: ${replayedEvents}`));
process.on('unhandledRejection', err => console.error('❌ Unhandled rejection:', err));
process.on('uncaughtException', err => console.error('❌ Uncaught exception:', err));

console.log('🛡️ AUTO-BATTLE FIX V3 LOADED: Battle reports enabled');

client.once('ready', () => {
    console.log(`✅ Discord Gateway READY: ${client.user?.tag || client.user?.id || 'bot connected'}`);
});
client.on('shardReady', shardId => {
    console.log(`✅ Discord shard ${shardId} is READY`);
});
client.on('shardReconnecting', shardId => {
    console.warn(`⚠️ Discord shard ${shardId} reconnecting`);
});

// One bounded, unauthenticated discovery request plus one short WebSocket handshake test.
// No bot token is sent to either diagnostic endpoint. This runs once per process start;
// it does not poll/retry and always allows the normal discord.js login attempt to continue.
initializeTrackingPersistence()
    .catch(err => {
        console.error('❌ Tracking persistence initialization failed:', err?.message || err);
        throw err;
    })
    .then(async () => {
        if (!BOT_TOKEN) {
            throw new Error('BOT_TOKEN is missing or empty. Set Render Environment variable BOT_TOKEN (Bot Token from Discord Developer Portal).');
        }

        // Do not call unauthenticated /gateway discovery on every deploy.
        // Render's shared IP can be rate-limited (HTTP 429); discord.js already
        // knows the Gateway endpoint and should connect directly.
        console.log('🔐 Connecting to Discord Gateway via discord.js (token is not logged)...');

        // A watchdog reports the connection state once if login/READY is still pending.
        // It does not restart the service or trigger any additional API requests.
        let readyLogged = false;
        client.once('ready', () => { readyLogged = true; });
        const gatewayWatchdog = setTimeout(() => {
            if (readyLogged || client.isReady()) return;
            const managerStatus = client.ws?.status;
            const shardStates = client.ws?.shards
                ? [...client.ws.shards.values()].map(shard => ({
                    id: shard.id,
                    status: shard.status,
                    ping: Number.isFinite(shard.ping) ? shard.ping : null
                }))
                : [];
            console.error('⏱️ Discord Gateway watchdog: READY not received 25 seconds after login started.');
            console.error('🔎 Gateway manager status:', managerStatus ?? 'unavailable');
            console.error('🔎 Gateway shard state:', JSON.stringify(shardStates));
            console.error('ℹ️ Use the discovery/WebSocket results above to distinguish API-edge problems from WebSocket connectivity. No token or headers are logged.');
        }, 25000);
        gatewayWatchdog.unref?.();

        let loginTimer;
        const loginTimeout = new Promise((_, reject) => {
            loginTimer = setTimeout(() => reject(new Error('Discord Gateway login timed out after 45 seconds')), 45000);
            loginTimer.unref?.();
        });
        try {
            await Promise.race([client.login(BOT_TOKEN), loginTimeout]);
            console.log('ℹ️ Discord login() resolved; waiting for Gateway READY event if it has not appeared yet.');
        } finally {
            clearTimeout(loginTimer);
        }
    })
    .catch(err => {
        const status = Number(err?.status ?? err?.statusCode ?? err?.response?.status);
        const code = err?.code;
        const message = String(err?.message || err || 'ไม่ทราบสาเหตุ');
        if (status === 429 || Number(code) === 429 || /HTTP.?429|rate.?limit/i.test(message)) {
            console.error('❌ Discord ตอบกลับว่าโดนจำกัดการเรียกใช้งาน (429)');
            const rawRetry = err?.response?.headers?.['retry-after'] ??
                err?.response?.headers?.['Retry-After'] ??
                err?.retry_after ?? err?.retryAfter;
            let waitMs = null;
            if (rawRetry != null) {
                const seconds = Number(rawRetry);
                if (Number.isFinite(seconds) && seconds >= 0) waitMs = seconds * 1000;
                else {
                    const dateMs = Date.parse(String(rawRetry));
                    if (Number.isFinite(dateMs)) waitMs = Math.max(0, dateMs - Date.now());
                }
            }
            if (waitMs != null) {
                console.error('⏳ ต้องรอ Discord ปลดจำกัด: ' + Math.round(waitMs) + ' ms = ' +
                    Math.ceil(waitMs / 1000) + ' วินาที ≈ ' + (waitMs / 60000).toFixed(2) + ' นาที');
            } else {
                console.error('⚠️ ไม่พบเวลาปลดจำกัดในข้อผิดพลาดนี้ ให้ตรวจค่า Retry-After จาก Log ของ Discord');
            }
        } else if (/timed out|timeout/i.test(message)) {
            console.error('⏱️ Discord เชื่อมต่อไม่สำเร็จภายในเวลาที่กำหนด (Timeout)');
            console.error('ℹ️ Timeout อย่างเดียวไม่ใช่หลักฐานว่าโดน HTTP 429 และไม่มีเวลาปลดจำกัดให้คำนวณ');
            console.error('🔎 ตรวจ Log ของ Gateway/REST ก่อนหน้านี้เพื่อดูสถานะ HTTP, รหัสข้อผิดพลาด และ Retry-After หาก Discord ส่งมา');
            console.error('⚠️ ระบบจะไม่เดาเวลารอหรือส่งคำขอซ้ำเพื่อทดสอบโดยอัตโนมัติ');
        } else {
            console.error('❌ เกิดข้อผิดพลาดระหว่างเริ่ม Discord:', message);
        }
        if (code) console.error('🔎 รหัสข้อผิดพลาด:', code);
        console.error('⚠️ คง Render web process ไว้เพื่อป้องกันการรีสตาร์ตวน ตรวจ Log ข้างต้นก่อนลองใหม่');
        // ไม่เรียก process.exit(): ป้องกันการรีสตาร์ตซ้ำระหว่าง Discord จำกัดอัตรา API
    });