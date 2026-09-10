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
    const width = 980;
    const rowHeight = 72;
    const headerHeight = 92;
    const padding = 26;
    const titleHeight = 54;
    const height = padding * 2 + titleHeight + headerHeight + (topGuilds.length * rowHeight);

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    const bg = ctx.createLinearGradient(0, 0, width, height);
    bg.addColorStop(0, '#07101c');
    bg.addColorStop(0.55, '#0b1423');
    bg.addColorStop(1, '#030811');
    ctx.fillStyle = bg;
    drawRoundRect(ctx, 0, 0, width, height, 18);
    ctx.fill();

    // Premium top edge
    const edge = ctx.createLinearGradient(0, 0, width, 0);
    edge.addColorStop(0, '#dc2626');
    edge.addColorStop(0.5, '#f59e0b');
    edge.addColorStop(1, '#dc2626');
    ctx.fillStyle = edge;
    ctx.fillRect(0, 0, width, 4);

    ctx.fillStyle = '#f8fafc';
    ctx.font = '900 25px Arial, sans-serif';
    ctx.fillText('⚔ BATTLE GUILD RANKING', padding, padding + 27);
    ctx.fillStyle = '#64748b';
    ctx.font = '900 9px Arial, sans-serif';
    ctx.fillText('GUILD PERFORMANCE / PLAYERS / KILLS / DEATHS / KILL FAME', padding, padding + 45);

    const tableY = padding + titleHeight;

    ctx.fillStyle = '#0a1627';
    drawRoundRect(ctx, padding, tableY, width - padding * 2, headerHeight + topGuilds.length * rowHeight, 14);
    ctx.fill();
    ctx.strokeStyle = '#1e3049';
    ctx.lineWidth = 1;
    ctx.stroke();

    const col = { rank: padding + 28, name: padding + 78, players: 590, kills: 690, deaths: 780, fame: 870 };
    ctx.fillStyle = '#64748b';
    ctx.font = '900 10px Arial, sans-serif';
    ctx.fillText('#', col.rank, tableY + 34);
    ctx.fillText('GUILD', col.name, tableY + 34);
    ctx.fillText('PLAYERS', col.players - 24, tableY + 34);
    ctx.fillText('KILLS', col.kills, tableY + 34);
    ctx.fillText('DEATHS', col.deaths, tableY + 34);
    ctx.fillText('FAME', col.fame, tableY + 34);

    ctx.strokeStyle = '#20344f';
    ctx.beginPath();
    ctx.moveTo(padding + 16, tableY + headerHeight);
    ctx.lineTo(width - padding - 16, tableY + headerHeight);
    ctx.stroke();

    topGuilds.forEach((g, i) => {
        const y = tableY + headerHeight + i * rowHeight;
        const tracked = i === 0;
        const rank = i + 1;
        const rankColor = rank === 1 ? '#fbbf24' : rank === 2 ? '#cbd5e1' : rank === 3 ? '#cd7f32' : '#64748b';

        if (tracked) {
            ctx.save();
            ctx.fillStyle = 'rgba(245,158,11,.075)';
            drawRoundRect(ctx, padding + 8, y + 5, width - padding * 2 - 16, rowHeight - 10, 10);
            ctx.fill();
            ctx.strokeStyle = '#8b6518';
            ctx.lineWidth = 1;
            ctx.stroke();
            ctx.restore();
        }

        centerText(String(rank).padStart(2, '0'), col.rank, y + 45, 14, rankColor, '900');

        let gName = String(g.name || 'Unknown').trim();
        if (gName.length > 30) gName = `${gName.slice(0, 27)}...`;
        ctx.fillStyle = tracked ? '#fef3c7' : '#f8fafc';
        ctx.font = '900 18px Arial, sans-serif';
        ctx.fillText(gName, col.name, y + 35);
        if (tracked) {
            ctx.fillStyle = '#f59e0b';
            ctx.font = '900 8px Arial, sans-serif';
            ctx.fillText('TRACKED GUILD', col.name, y + 51);
        }

        centerText(String(g.playersCount || 0), col.players, y + 43, 17, '#60a5fa', '900');
        centerText(String(g.kills || 0), col.kills, y + 43, 17, '#ef4444', '900');
        centerText(String(g.deaths || 0), col.deaths, y + 43, 17, '#f87171', '900');
        centerText(formatFame(g.killFame || 0), col.fame, y + 43, 17, '#fbbf24', '900');
    });

    return new AttachmentBuilder(canvas.toBuffer('image/png'), { name: 'guild-summary.png' });
}

async function generatePlayerWeaponReportImage(players, battleInfo = {}) {
    if (!players || !players.length) return null;

    const fameImg = await loadFameIcon();
    const sortedPlayers = [...players].sort((a, b) =>
        (Number(b.fame) || 0) - (Number(a.fame) || 0) ||
        (Number(b.kills) || 0) - (Number(a.kills) || 0) ||
        (Number(b.damage) || 0) - (Number(a.damage) || 0)
    );

    let totalKills = 0, totalDeaths = 0, totalFame = 0;
    let mvp = { name: 'N/A', fame: 0 };
    let topKiller = { name: 'N/A', kills: 0 };
    sortedPlayers.forEach(p => {
        const k = Number(p.kills) || 0;
        const d = Number(p.deaths) || 0;
        const f = Number(p.fame) || 0;
        totalKills += k; totalDeaths += d; totalFame += f;
        if (k > topKiller.kills) topKiller = { name: p.displayName || p.name, kills: k };
        if (f > mvp.fame) mvp = { name: p.displayName || p.name, fame: f };
    });

    const width = 1600;
    const padding = 30;
    const playersPerRow = 7;
    const cardWidth = 210;
    const cardHeight = 214;
    const gapX = 14, gapY = 14;
    const headerHeight = 118;
    const statsHeight = 82;
    const guildSectionHeight = battleInfo.guildsData?.length ? 166 : 0;
    const topPerf = Array.isArray(battleInfo.performancePlayers) ? battleInfo.performancePlayers.slice(0, 3) : [];
    const perfHeight = topPerf.length ? 112 : 0;
    const rows = Math.ceil(sortedPlayers.length / playersPerRow);
    const gridHeight = rows * cardHeight + Math.max(0, rows - 1) * gapY;
    const sectionGap = 18;
    const footerHeight = 54;
    const height = padding + headerHeight + statsHeight + sectionGap + guildSectionHeight + sectionGap + gridHeight + sectionGap + perfHeight + footerHeight + padding;

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
            size--;
        }
        return size;
    }
    function centerText(text, cx, y, size, color, weight = 'bold', maxWidth = Infinity) {
        const fs = maxWidth < Infinity ? textFit(String(text), maxWidth, size, weight) : size;
        ctx.save(); ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
        ctx.font = `${weight} ${fs}px Arial, sans-serif`; ctx.fillStyle = color;
        ctx.fillText(String(text), cx, y); ctx.restore();
    }
    function truncate(text, maxChars) {
        const s = String(text || '').trim();
        return s.length > maxChars ? `${s.slice(0, maxChars - 2)}..` : s;
    }

    // ---------- Background / grid ----------
    ctx.fillStyle = '#02050a'; ctx.fillRect(0, 0, width, height);
    const bg = ctx.createRadialGradient(width * .50, 90, 20, width * .50, height * .45, width * .85);
    bg.addColorStop(0, '#18263e'); bg.addColorStop(.36, '#0a1424'); bg.addColorStop(1, '#010409');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, width, height);
    ctx.save();
    ctx.strokeStyle = 'rgba(148,163,184,.065)'; ctx.lineWidth = 1;
    for (let x = 0; x <= width; x += 32) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke(); }
    for (let y = 0; y <= height; y += 32) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke(); }
    ctx.strokeStyle = 'rgba(220,38,38,.035)';
    for (let x = -height; x < width; x += 210) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + height, height); ctx.stroke(); }
    ctx.restore();
    const edge = ctx.createLinearGradient(0, 0, width, 0);
    edge.addColorStop(0, '#dc2626'); edge.addColorStop(.5, '#f59e0b'); edge.addColorStop(1, '#dc2626');
    ctx.fillStyle = edge; ctx.fillRect(0, 0, width, 4);

    // ---------- Header ----------
    ctx.save(); ctx.shadowColor = 'rgba(255,255,255,.16)'; ctx.shadowBlur = 12;
    ctx.fillStyle = '#f8fafc'; ctx.font = '900 40px Arial, sans-serif'; ctx.fillText('BATTLE REPORT', padding, padding + 38); ctx.restore();

    const guildName = truncate(battleInfo.guildName || '', 38);
    if (guildName) {
        ctx.fillStyle = '#fbbf24'; ctx.font = '900 18px Arial, sans-serif';
        ctx.fillText(guildName, padding, padding + 64);
        ctx.fillStyle = '#64748b'; ctx.font = '900 9px Arial, sans-serif';
        ctx.fillText('TRACKED GUILD', padding, padding + 79);
    }
    ctx.fillStyle = '#94a3b8'; ctx.font = 'bold 11px Arial, sans-serif';
    ctx.fillText(`EAST SERVER  |  ${formatUTCTime(battleInfo.battleTime || Date.now())}  |  MATCH ID: ${battleInfo.matchId || 'N/A'}`, padding, padding + 97);
    ctx.fillStyle = '#ef4444'; ctx.font = '900 9px Arial, sans-serif';
    ctx.fillText(`BATTLE LINK  |  east.albionbb.com/battles/${battleInfo.matchId || 'N/A'}`, padding, padding + 111);

    const badgeW = 184, badgeH = 62, badgeX = width - padding - badgeW, badgeY = 23;
    rounded(badgeX, badgeY, badgeW, badgeH, 14, '#08111f', '#334b70', 1.2);
    ctx.fillStyle = '#101c2f'; drawRoundRect(ctx, badgeX + 6, badgeY + 6, 54, badgeH - 12, 10); ctx.fill();
    centerText(sortedPlayers.length, badgeX + 33, badgeY + 39, 25, '#f8fafc', '900');
    ctx.fillStyle = '#64748b'; ctx.font = '900 10px Arial, sans-serif'; ctx.fillText('PLAYERS', badgeX + 73, badgeY + 27);
    ctx.fillStyle = '#cbd5e1'; ctx.font = 'bold 11px Arial, sans-serif'; ctx.fillText('IN BATTLE', badgeX + 73, badgeY + 45);

    // ---------- Stats ----------
    const statY = padding + headerHeight;
    const statGap = 12, statH = statsHeight;
    const statW = (width - padding * 2 - statGap * 4) / 5;
    const kdRatio = totalDeaths > 0 ? (totalKills / totalDeaths).toFixed(2) : (totalKills > 0 ? totalKills.toFixed(2) : '0.00');
    const stats = [
        ['TOTAL KILLS', totalKills.toLocaleString(), 'ELIMINATIONS', '#ef4444', 'kills'],
        ['TOTAL DEATHS', totalDeaths.toLocaleString(), 'CASUALTIES', '#f87171', 'deaths'],
        ['K / D RATIO', kdRatio, 'COMBAT RATIO', '#60a5fa', 'kills'],
        ['TOTAL FAME', formatFame(totalFame), 'KILL FAME', '#fbbf24', 'fame'],
        ['MVP / TOP FAME', truncate(mvp.name, 17), `${formatFame(mvp.fame)} FAME`, '#f59e0b', 'mvp']
    ];
    stats.forEach((st, i) => {
        const x = padding + i * (statW + statGap);
        rounded(x, statY, statW, statH, 13, '#08111f', '#1e3049', 1.2);
        ctx.fillStyle = st[3]; drawRoundRect(ctx, x, statY, 4, statH, 3); ctx.fill();
        drawStatIcon(x + 32, statY + 41, st[3], st[4]);
        ctx.fillStyle = '#64748b'; ctx.font = '900 9px Arial, sans-serif'; ctx.fillText(st[0], x + 66, statY + 22);
        const fs = textFit(st[1], statW - 78, i === 2 ? 22 : (i === 4 ? 18 : 22), '900');
        ctx.font = `900 ${fs}px Arial, sans-serif`; ctx.fillStyle = '#f8fafc'; ctx.fillText(st[1], x + 66, statY + 49);
        ctx.fillStyle = st[3]; ctx.font = '900 8px Arial, sans-serif'; ctx.fillText(st[2], x + 66, statY + 67);
    });

    let cursorY = statY + statH + sectionGap;

    // ---------- Guild Ranking ----------
    const guildsData = Array.isArray(battleInfo.guildsData) ? battleInfo.guildsData.slice(0, 4) : [];
    if (guildsData.length) {
        const h = guildSectionHeight;
        rounded(padding, cursorY, width - padding * 2, h, 14, '#06101d', '#1f334d', 1.2);
        ctx.fillStyle = '#fbbf24'; ctx.font = '900 17px Arial, sans-serif'; ctx.fillText('BATTLE GUILD RANKING', padding + 20, cursorY + 28);
        ctx.fillStyle = '#64748b'; ctx.font = '900 9px Arial, sans-serif'; ctx.fillText('GUILD', padding + 20, cursorY + 54);
        ctx.fillText('PLAYERS', 1010, cursorY + 54); ctx.fillText('KILLS / DEATHS', 1130, cursorY + 54); ctx.fillText('FAME', 1370, cursorY + 54);
        ctx.strokeStyle = '#22364f'; ctx.beginPath(); ctx.moveTo(padding + 16, cursorY + 64); ctx.lineTo(width - padding - 16, cursorY + 64); ctx.stroke();

        guildsData.forEach((g, i) => {
            const y = cursorY + 70 + i * 22;
            const tracked = guildName && String(g.name || '').trim().toLowerCase() === guildName.toLowerCase();
            if (tracked) {
                rounded(padding + 10, y - 14, width - padding * 2 - 20, 21, 7, 'rgba(245,158,11,.09)', '#8b6518', 1);
            }
            const rankColor = i === 0 ? '#fbbf24' : i === 1 ? '#cbd5e1' : i === 2 ? '#cd7f32' : '#64748b';
            centerText(String(i + 1).padStart(2, '0'), padding + 30, y + 1, 11, rankColor, '900');
            ctx.fillStyle = tracked ? '#fef3c7' : '#f8fafc'; ctx.font = '900 13px Arial, sans-serif'; ctx.fillText(truncate(g.name || 'Unknown', 38), padding + 62, y + 1);
            if (tracked) { ctx.fillStyle = '#f59e0b'; ctx.font = '900 7px Arial, sans-serif'; ctx.fillText('TRACKED', padding + 62, y + 10); }
            centerText(g.playersCount || 0, 1030, y + 1, 13, '#60a5fa', '900');
            centerText(`${g.kills || 0} / ${g.deaths || 0}`, 1195, y + 1, 13, '#f87171', '900');
            centerText(formatFame(g.killFame || 0), 1390, y + 1, 13, '#fbbf24', '900');
        });
        cursorY += h + sectionGap;
    }

    // ---------- Player cards ----------
    const iconImages = await Promise.all(sortedPlayers.map(p => loadAlbionWeaponIcon(p.weapon, p.weaponQuality || 1)));
    const gridY = cursorY;
    sortedPlayers.forEach((p, i) => {
        const col = i % playersPerRow, row = Math.floor(i / playersPerRow);
        const x = padding + col * (cardWidth + gapX), y = gridY + row * (cardHeight + gapY);
        const isMVP = i === 0;
        const k = Number(p.kills) || 0, d = Number(p.deaths) || 0;
        const q = Math.max(1, Math.min(5, Number(p.weaponQuality) || 1)), qm = qualityMeta[q];
        const cx = x + cardWidth / 2;

        rounded(x, y, cardWidth, cardHeight, 15, isMVP ? '#111a2b' : '#07101c', isMVP ? '#f59e0b' : '#22344d', isMVP ? 2 : 1.2);
        if (isMVP) {
            ctx.save(); ctx.shadowColor = 'rgba(245,158,11,.35)'; ctx.shadowBlur = 20;
            ctx.strokeStyle = '#f59e0b'; ctx.lineWidth = 1.5; drawRoundRect(ctx, x, y, cardWidth, cardHeight, 15); ctx.stroke(); ctx.restore();
        }
        rounded(x + 10, y + 10, 38, 23, 7, isMVP ? '#f59e0b' : '#142238', isMVP ? '#fcd34d' : '#2a405e', 1);
        centerText(String(i + 1).padStart(2, '0'), x + 29, y + 26, 11, isMVP ? '#111827' : '#cbd5e1', '900');
        if (isMVP) { ctx.fillStyle = '#fbbf24'; ctx.font = '900 9px Arial, sans-serif'; ctx.fillText('MVP', x + cardWidth - 40, y + 26); }

        const wy = y + 63;
        ctx.save(); ctx.shadowColor = qm.color; ctx.shadowBlur = isMVP ? 18 : 10; ctx.fillStyle = '#030811';
        ctx.beginPath(); ctx.arc(cx, wy, 45, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
        ctx.strokeStyle = qm.color; ctx.lineWidth = isMVP ? 2.4 : 1.8; ctx.beginPath(); ctx.arc(cx, wy, 45, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = 'rgba(255,255,255,.13)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(cx, wy, 37, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
        ctx.save(); ctx.strokeStyle = qm.color; ctx.lineWidth = 2; ctx.globalAlpha = .65;
        [[0,-49,0,-56],[0,49,0,56],[-49,0,-56,0],[49,0,56,0]].forEach(a => { ctx.beginPath(); ctx.moveTo(cx+a[0],wy+a[1]); ctx.lineTo(cx+a[2],wy+a[3]); ctx.stroke(); }); ctx.restore();
        if (iconImages[i]) { try { ctx.drawImage(iconImages[i], cx - 36, wy - 36, 72, 72); } catch (_) {} } else drawSwordIcon(cx, wy, 1.7, qm.color);

        const qText = `Q${q}  ${qm.label}`; ctx.font = '900 8px Arial, sans-serif'; const qw = ctx.measureText(qText).width + 18;
        rounded(cx - qw / 2, y + 108, qw, 17, 8, '#050b14', qm.color, 1); centerText(qText, cx, y + 120, 8, qm.color, '900');

        const name = truncate(p.displayName || p.name || 'Unknown', 22); const nameSize = textFit(name, cardWidth - 20, 15, '900');
        ctx.save(); ctx.textAlign = 'center'; ctx.font = `900 ${nameSize}px Arial, sans-serif`; ctx.lineWidth = 3; ctx.strokeStyle = '#02060c'; ctx.strokeText(name, cx, y + 145);
        ctx.fillStyle = isMVP ? '#fef3c7' : '#f8fafc'; ctx.shadowColor = isMVP ? 'rgba(245,158,11,.25)' : 'rgba(255,255,255,.10)'; ctx.shadowBlur = 5; ctx.fillText(name, cx, y + 145); ctx.restore();
        const guild = truncate(p.guild || '', 21); if (guild) centerText(guild, cx, y + 158, 8, '#64748b', 'bold', cardWidth - 20);

        const metricY = y + 180;
        centerText(k, cx - 18, metricY, 12, k > 0 ? '#ef4444' : '#64748b', '900'); centerText('/', cx, metricY, 11, '#475569', '900'); centerText(d, cx + 18, metricY, 12, d > 0 ? '#f87171' : '#64748b', '900');
        const fameText = formatFame(p.fame || 0), famePillW = 112, famePillH = 23, fameX = cx - famePillW / 2, fameY = y + cardHeight - 31;
        rounded(fameX, fameY, famePillW, famePillH, 10, '#0b1422', isMVP ? '#8b6518' : '#263a55', 1);
        if (fameImg) { try { ctx.drawImage(fameImg, fameX + 10, fameY + 5, 13, 13); } catch (_) {} } else drawGemIcon(fameX + 17, fameY + 11, .35, '#fbbf24');
        centerText(fameText, fameX + 72, fameY + 16, 11, '#fbbf24', '900');
    });

    cursorY = gridY + gridHeight + sectionGap;

    // ---------- Top Performance ----------
    if (topPerf.length) {
        ctx.fillStyle = '#fbbf24'; ctx.font = '900 16px Arial, sans-serif'; ctx.fillText('TOP PERFORMANCE', padding, cursorY + 16);
        topPerf.forEach((p, i) => {
            const x = padding + i * 350, y = cursorY + 27, w = 332, h = 66;
            const rankColor = i === 0 ? '#fbbf24' : i === 1 ? '#94a3b8' : '#cd7f32';
            rounded(x, y, w, h, 12, '#07101c', rankColor, i === 0 ? 1.5 : 1);
            centerText(String(i + 1), x + 25, y + 40, 16, rankColor, '900');
            ctx.fillStyle = '#f8fafc'; ctx.font = '900 15px Arial, sans-serif'; ctx.fillText(truncate(p.name, 18), x + 50, y + 28);
            const typeLabel = p.type === 'heal' ? 'HEAL' : 'DMG';
            ctx.fillStyle = p.type === 'heal' ? '#34d399' : '#f87171'; ctx.font = '900 10px Arial, sans-serif';
            ctx.fillText(`${typeLabel}  ${Number(p.value || 0).toLocaleString()}  (${Number(p.percent || 0)}%)`, x + 50, y + 48);
        });
        cursorY += perfHeight;
    }

    // ---------- Footer ----------
    const footerY = height - padding - 10;
    ctx.strokeStyle = '#1b2b42'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(padding, footerY - 25); ctx.lineTo(width - padding, footerY - 25); ctx.stroke();
    ctx.fillStyle = '#64748b'; ctx.font = '900 9px Arial, sans-serif'; ctx.fillText('VICTORY BELONGS TO THOSE WHO FIGHT TOGETHER', padding, footerY);
    ctx.fillStyle = '#ef4444'; const powered = 'POWERED BY  •  BOTBOSS'; ctx.fillText(powered, width - padding - ctx.measureText(powered).width, footerY);

    return new AttachmentBuilder(canvas.toBuffer('image/png'), { name: 'battle-report-premium.png' });
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

    let guildsDataForImage = [];
    try {
        if (apiData.guilds) {
            const playerCountByGuild = new Map();
            for (const p of rawPlayers) {
                const guildName = String(p.guild || '').trim();
                const playerName = String(p.name || '').trim();
                if (!guildName || !playerName) continue;
                const guildKey = guildName.toLowerCase();
                if (!playerCountByGuild.has(guildKey)) playerCountByGuild.set(guildKey, new Set());
                playerCountByGuild.get(guildKey).add(playerName.toLowerCase());
            }

            guildsDataForImage = Object.values(apiData.guilds).map(g => {
                const guildName = String(g.name || 'Unknown').trim();
                return {
                    name: guildName,
                    playersCount: playerCountByGuild.get(guildName.toLowerCase())?.size || 0,
                    kills: Number(g.kills) || 0,
                    deaths: Number(g.deaths) || 0,
                    killFame: Number(g.killFame) || 0
                };
            });

            if (guildNamesList.length > 0) {
                const tracked = guildsDataForImage.filter(g => isExactGuildMatch(g.name, guildNamesList));
                const trackedKeys = new Set(tracked.map(g => g.name.toLowerCase()));
                const topOthers = guildsDataForImage
                    .filter(g => !trackedKeys.has(g.name.toLowerCase()))
                    .sort((a, b) => b.killFame - a.killFame || b.kills - a.kills)
                    .slice(0, 3);
                guildsDataForImage = options.autoBattle ? [...tracked, ...topOthers] : tracked;
            } else {
                guildsDataForImage.sort((a, b) => b.killFame - a.killFame);
            }
            guildsDataForImage = guildsDataForImage.slice(0, 4);
        }
    } catch (err) {
        console.error('❌ Guild ranking preparation error:', err.message);
    }

    const reportGuildName = guildNamesList.length === 1 ? guildNamesList[0] : (guildNamesList.length > 1 ? guildNamesList.join(' / ') : '');
    const top = performancePlayers.map(p => {
        const heal = p.healing > p.damage;
        const value = heal ? p.healing : p.damage;
        const max = heal ? Math.max(1, ...performancePlayers.map(x => x.healing)) : Math.max(1, ...performancePlayers.map(x => x.damage));
        return { name: p.displayName, guild: p.guild, weapon: p.weapon, value, percent: Math.round((value / max) * 100), type: heal ? 'heal' : 'damage' };
    });

    try {
        const playerReport = await generatePlayerWeaponReportImage(displayRows, {
            matchId,
            battleTime,
            guildName: reportGuildName,
            guildsData: guildsDataForImage,
            performancePlayers: top
        });
        if (playerReport) attachments.push(playerReport);
    } catch (err) {
        console.error('❌ Premium report image error:', err.message);
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