// ALBION DISCORD BOT - ULTRA DASHBOARD BATTLE REPORT EDITION
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

if (!BOT_TOKEN) {
    console.error('❌ BOT_TOKEN is missing. Set it in Environment Variables.');
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

// 🎨 DASHBOARD UI BATTLE REPORT CANVAS GENERATOR (เหมือนภาพตัวอย่าง)
async function generateDashboardReportImage({ matchId, battleTime, guildName, players }) {
    if (!players || !players.length) return null;

    const totalPlayers = players.length;
    let totalKills = 0, totalDeaths = 0, totalFame = 0;
    let topKiller = { name: 'None', kills: 0 };
    let mvp = { name: players[0]?.displayName || 'None', fame: players[0]?.fame || 0 };

    players.forEach(p => {
        totalKills += p.kills || 0;
        totalDeaths += p.deaths || 0;
        totalFame += p.fame || 0;
        if (p.kills > topKiller.kills) {
            topKiller = { name: p.displayName, kills: p.kills };
        }
        if (p.fame > mvp.fame) {
            mvp = { name: p.displayName, fame: p.fame };
        }
    });

    const playersPerRow = 10;
    const columns = Math.min(playersPerRow, totalPlayers);
    const rows = Math.ceil(totalPlayers / playersPerRow);

    const cardW = 108;
    const cardH = 125;
    const gap = 10;
    const padding = 28;

    const gridWidth = columns * cardW + (columns - 1) * gap;
    const width = Math.max(1220, padding * 2 + gridWidth);
    const startX = Math.floor((width - gridWidth) / 2);

    const headerHeight = 180;
    const footerHeight = 60;
    const height = padding + headerHeight + rows * cardH + (rows - 1) * gap + footerHeight + padding;

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // Background Gradient
    const bgGradient = ctx.createLinearGradient(0, 0, 0, height);
    bgGradient.addColorStop(0, '#0c0e12');
    bgGradient.addColorStop(0.5, '#080a0d');
    bgGradient.addColorStop(1, '#040507');
    ctx.fillStyle = bgGradient;
    ctx.fillRect(0, 0, width, height);

    // Subtle Grid pattern
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.02)';
    ctx.lineWidth = 1;
    for (let x = 0; x < width; x += 40) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
    }

    // Header Title
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 34px sans-serif';
    ctx.fillText('BATTLE REPORT', padding, padding + 36);

    ctx.fillStyle = '#8e96a3';
    ctx.font = '13px sans-serif';
    ctx.fillText(`EAST SERVER   |   ${formatUTCTime(battleTime)}   |   MATCH ID: ${matchId}`, padding, padding + 58);

    // Total Players Badge
    const badgeW = 110, badgeH = 44, badgeX = width - padding - badgeW, badgeY = padding + 12;
    ctx.fillStyle = '#171c26';
    ctx.beginPath(); ctx.roundRect(badgeX, badgeY, badgeW, badgeH, 10); ctx.fill();
    ctx.strokeStyle = '#2d3748'; ctx.stroke();

    ctx.fillStyle = '#a0aec0';
    ctx.font = 'bold 13px sans-serif';
    ctx.fillText('👥 PLAYERS', badgeX + 16, badgeY + 22);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 18px sans-serif';
    ctx.fillText(String(totalPlayers), badgeX + 42, badgeY + 39);

    // Dashboard Stat Cards Row (5 Cards)
    const statCardsY = padding + 80;
    const statCardW = Math.floor((width - padding * 2 - 4 * 12) / 5);
    const statCardH = 75;

    const statsData = [
        { label: 'TOTAL KILLS', val: String(totalKills), icon: '⚔️', color: '#a855f7' },
        { label: 'TOTAL DEATHS', val: String(totalDeaths), icon: '💀', color: '#ef4444' },
        { label: 'TOTAL FAME', val: formatFame(totalFame), icon: '👑', color: '#eab308' },
        { label: 'TOP KILLER', val: topKiller.name, sub: `${topKiller.kills} KILLS`, icon: '🎯', color: '#c084fc' },
        { label: 'MVP (TOP FAME)', val: mvp.name, sub: `${formatFame(mvp.fame)} FAME`, icon: '🏆', color: '#f59e0b' }
    ];

    statsData.forEach((s, idx) => {
        const cx = padding + idx * (statCardW + 12);
        ctx.fillStyle = '#131822';
        ctx.beginPath(); ctx.roundRect(cx, statCardsY, statCardW, statCardH, 8); ctx.fill();
        ctx.strokeStyle = '#222c3c'; ctx.stroke();

        ctx.font = '22px sans-serif';
        ctx.fillText(s.icon, cx + 12, statCardsY + 36);

        ctx.fillStyle = '#718096';
        ctx.font = 'bold 10px sans-serif';
        ctx.fillText(s.label, cx + 46, statCardsY + 22);

        let displayVal = s.val;
        if (displayVal.length > 13) displayVal = `${displayVal.slice(0, 11)}..`;

        ctx.fillStyle = s.color;
        ctx.font = 'bold 18px sans-serif';
        ctx.fillText(displayVal, cx + 46, statCardsY + 45);

        if (s.sub) {
            ctx.fillStyle = '#a0aec0';
            ctx.font = 'bold 11px sans-serif';
            ctx.fillText(s.sub, cx + 46, statCardsY + 62);
        }
    });

    // Load Weapon Icons
    const weaponIcons = await Promise.all(players.map(p =>
        loadAlbionWeaponIcon(p.weapon, p.weaponQuality || 1)
    ));

    // Player Cards Grid
    const gridStartY = padding + headerHeight;

    players.forEach((p, idx) => {
        const col = idx % playersPerRow;
        const row = Math.floor(idx / playersPerRow);
        const x = startX + col * (cardW + gap);
        const y = gridStartY + row * (cardH + gap);

        const isMVP = idx === 0;
        const isTopKiller = topKiller.kills > 0 && p.displayName === topKiller.name;

        // Card Base
        ctx.fillStyle = isMVP ? '#1d1912' : '#121620';
        ctx.beginPath(); ctx.roundRect(x, y, cardW, cardH, 8); ctx.fill();

        // Border Styling
        if (isMVP) {
            ctx.strokeStyle = '#f59e0b';
            ctx.lineWidth = 2;
        } else if (isTopKiller) {
            ctx.strokeStyle = '#a855f7';
            ctx.lineWidth = 1.5;
        } else {
            ctx.strokeStyle = '#1e2636';
            ctx.lineWidth = 1;
        }
        ctx.stroke();

        // Rank Badge Top-Left
        const rankStr = String(idx + 1).padStart(2, '0');
        ctx.fillStyle = isMVP ? '#f59e0b' : '#232d3f';
        ctx.beginPath(); ctx.roundRect(x + 4, y + 4, 26, 18, 4); ctx.fill();

        ctx.fillStyle = isMVP ? '#000000' : '#a0aec0';
        ctx.font = 'bold 11px sans-serif';
        ctx.fillText(rankStr, x + 9, y + 17);

        // Weapon Icon Frame
        const iconSize = 46;
        const iconX = x + (cardW - iconSize) / 2;
        const iconY = y + 16;

        ctx.fillStyle = '#1a202c';
        ctx.beginPath(); ctx.roundRect(iconX, iconY, iconSize, iconSize, 6); ctx.fill();

        if (weaponIcons[idx]) {
            try {
                ctx.drawImage(weaponIcons[idx], iconX, iconY, iconSize, iconSize);
            } catch (_) {}
        }

        // Player Name
        let name = String(p.displayName || p.name || 'Unknown');
        if (name.length > 12) name = `${name.slice(0, 10)}..`;

        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 13px sans-serif';
        const nameWidth = ctx.measureText(name).width;
        ctx.fillText(name, x + (cardW - nameWidth) / 2, y + 80);

        // Kills / Deaths
        ctx.font = 'bold 12px monospace';
        const kdText = `${p.kills} / ${p.deaths}`;
        const kdWidth = ctx.measureText(kdText).width;
        const kdX = x + (cardW - kdWidth) / 2;

        ctx.fillStyle = p.kills > 0 ? '#c084fc' : '#a0aec0';
        ctx.fillText(String(p.kills), kdX, y + 98);

        ctx.fillStyle = '#718096';
        ctx.fillText(' / ', kdX + ctx.measureText(String(p.kills)).width, y + 98);

        ctx.fillStyle = p.deaths > 0 ? '#ef4444' : '#a0aec0';
        ctx.fillText(String(p.deaths), kdX + ctx.measureText(`${p.kills} / `).width, y + 98);

        // Fame Value
        ctx.fillStyle = '#f5c84c';
        ctx.font = 'bold 11px sans-serif';
        const fameText = `💰 ${formatFame(p.fame || 0)}`;
        const fameWidth = ctx.measureText(fameText).width;
        ctx.fillText(fameText, x + (cardW - fameWidth) / 2, y + 115);
    });

    // Footer Bar
    const footerY = height - footerHeight;
    ctx.strokeStyle = '#1e263c';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padding, footerY); ctx.lineTo(width - padding, footerY); ctx.stroke();

    ctx.fillStyle = '#a0aec0';
    ctx.font = 'bold 12px sans-serif';
    ctx.fillText(`GUILD BATTLE  |  [ ${guildName || 'ALL GUILDS'} ]`, padding, footerY + 35);

    ctx.fillStyle = '#4a5568';
    ctx.font = 'italic 12px sans-serif';
    const quote = 'VICTORY BELONGS TO THOSE WHO FIGHT TOGETHER';
    const quoteW = ctx.measureText(quote).width;
    ctx.fillText(quote, (width - quoteW) / 2, footerY + 35);

    ctx.fillStyle = '#718096';
    ctx.font = 'bold 11px sans-serif';
    const powered = 'POWERED BY Albion Auto Battle Bot';
    const poweredW = ctx.measureText(powered).width;
    ctx.fillText(powered, width - padding - poweredW, footerY + 35);

    return new AttachmentBuilder(canvas.toBuffer('image/png'), { name: 'battle-dashboard.png' });
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
    ctx.beginPath();
    ctx.roundRect(0, 0, width, height, 16);
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
        ctx.fillText(g.name, padding + 10, y + 36);

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
    const guildName = String(playerGuild || '').trim().toLowerCase();
    if (!guildName) return false;

    return targetGuilds.some(g => {
        const targetName = String(typeof g === 'string' ? g : (g?.name || '')).trim().toLowerCase();
        return targetName && guildName === targetName;
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
    const report = `🔗 **Battle Link:** <${battleUrl}>\n` + '```ansi\n' + header + body + footer + awardsText + '