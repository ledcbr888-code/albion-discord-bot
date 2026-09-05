// AUTO-BATTLE FIX V3: Auto-alert + Auto Battle Report without manual link pasting
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
    return `${formatted.replace(',', '')} +07`;
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

async function generatePlayerWeaponReportImage(players, matchInfo = {}) {
    if (!players || !players.length) return null;

    const playersPerRow = 10;
    const cardWidth = 70;
    const cardHeight = 70;
    const gapX = 6;
    const gapY = 6;
    const padding = 24;
    const headerHeight = 145; 
    const footerHeight = 55;  

    const columns = Math.min(playersPerRow, players.length);
    const rows = Math.ceil(players.length / playersPerRow);
    
    const contentWidth = (columns * cardWidth) + ((columns - 1) * gapX);
    const width = Math.max(820, padding * 2 + contentWidth);
    const height = padding * 2 + headerHeight + (rows * cardHeight) + ((rows - 1) * gapY) + footerHeight;

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // 1. พื้นหลังหลัก (โทนเข้มหรูหราแบบ Albion)
    ctx.fillStyle = '#0f1115';
    ctx.fillRect(0, 0, width, height);

    // 2. ส่วน Header (หัวข้อ & กล่องสถิติรวม)
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 28px sans-serif';
    ctx.fillText('BATTLE REPORT', padding + 160, 48);

    ctx.fillStyle = '#8a9ba8';
    ctx.font = '14px sans-serif';
    const serverText = `EAST SERVER  |  ${matchInfo.time || 'N/A'}  |  MATCH ID: ${matchInfo.matchId || 'N/A'}`;
    ctx.fillText(serverText, padding + 160, 74);

    // กล่องจำนวนผู้เล่น (มุมขวาบนของ Header)
    const playerCountBoxX = width - padding - 130;
    ctx.fillStyle = '#1b222c';
    ctx.beginPath();
    ctx.roundRect(playerCountBoxX, 22, 130, 65, 8);
    ctx.fill();
    ctx.strokeStyle = '#2c3543';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = '#c5d1de';
    ctx.font = 'bold 13px sans-serif';
    ctx.fillText(`👥  ${players.length}`, playerCountBoxX + 38, 48);
    ctx.fillStyle = '#8a9ba8';
    ctx.font = 'bold 11px sans-serif';
    ctx.fillText('PLAYERS', playerCountBoxX + 38, 67);

    // แถบสถิติย่อย 5 ช่อง (Kills, Deaths, Fame, Top Killer, MVP)
    const statBarY = 100;
    const statBarWidth = width - (padding * 2);
    const statBarHeight = 52;
    ctx.fillStyle = '#151a21';
    ctx.beginPath();
    ctx.roundRect(padding, statBarY, statBarWidth, statBarHeight, 8);
    ctx.fill();
    ctx.stroke();

    let totalKills = players.reduce((acc, p) => acc + (p.kills || 0), 0);
    let totalDeaths = players.reduce((acc, p) => acc + (p.deaths || 0), 0);
    let totalFame = players.reduce((acc, p) => acc + (p.fame || 0), 0);
    const topKiller = [...players].sort((a, b) => b.kills - a.kills)[0] || { name: '-', kills: 0 };
    const topMvp = [...players].sort((a, b) => b.fame - a.fame)[0] || { name: '-', fame: 0 };

    const colW = statBarWidth / 5;
    const drawStatCol = (index, icon, label, valColor, valText) => {
        const x = padding + (index * colW);
        ctx.fillStyle = valColor;
        ctx.font = 'bold 15px sans-serif';
        ctx.fillText(`${icon} ${valText}`, x + 15, statBarY + 22);
        ctx.fillStyle = '#7a8b99';
        ctx.font = 'bold 11px sans-serif';
        ctx.fillText(label, x + 15, statBarY + 40);
    };

    drawStatCol(0, '⚔️', 'TOTAL KILLS', '#ffffff', totalKills);
    drawStatCol(1, '💀', 'TOTAL DEATHS', '#ff5555', totalDeaths);
    drawStatCol(2, '👑', 'TOTAL FAME', '#ffcc00', formatFame(totalFame));
    drawStatCol(3, '🎯', `TOP: ${topKiller.name}`, '#b58cff', `${topKiller.kills} KILLS`);
    drawStatCol(4, '🏆', `MVP: ${topMvp.name}`, '#ffaa00', formatFame(topMvp.fame));

    const iconImages = await Promise.all(players.map(p =>
        loadAlbionWeaponIcon(p.weapon, p.weaponQuality || 1)
    ));

    // โหลดไอคอนรูปที่ 2 สำหรับหัวข้อจำนวนเฟรม
    let frameIconImg = null;
    try {
        const frameIconPath = path.join(__dirname, 'T6_GVGSEASONREWARD_FAMEBUFF_SPELL.png');
        if (fs.existsSync(frameIconPath)) {
            frameIconImg = await loadImage(frameIconPath);
        }
    } catch (e) {
        console.warn('⚠️ ไม่สามารถโหลดไอคอนรูปที่ 2 ได้:', e.message);
    }

    const startY = padding + headerHeight;

    // 3. การ์ดผู้เล่นแต่ละคน (Grid 10 คอลัมน์)
    players.forEach((p, i) => {
        const col = i % playersPerRow;
        const row = Math.floor(i / playersPerRow);
        const x = padding + col * (cardWidth + gapX);
        const y = startY + row * (cardHeight + gapY);

        ctx.fillStyle = '#141922';
        ctx.beginPath();
        ctx.roundRect(x, y, cardWidth, cardHeight, 6);
        ctx.fill();

        ctx.strokeStyle = i === 0 ? '#e6c662' : '#222b38';
        ctx.lineWidth = i === 0 ? 2 : 1;
        ctx.stroke();

        ctx.fillStyle = i === 0 ? '#e6c662' : '#5a6b7c';
        ctx.font = 'bold 10px sans-serif';
        ctx.fillText(String(i + 1).padStart(2, '0'), x + 5, y + 12);

        const wpSize = 36;
        const wpX = x + (cardWidth - wpSize) / 2;
        const wpY = y + 14;

        ctx.fillStyle = '#1b222c';
        ctx.beginPath();
        ctx.roundRect(wpX, wpY, wpSize, wpSize, 4);
        ctx.fill();

        if (iconImages[i]) {
            try {
                ctx.drawImage(iconImages[i], wpX, wpY, wpSize, wpSize);
            } catch (_) {}
        }

        if (i === 0) {
            ctx.fillStyle = '#e6c662';
            ctx.font = '10px sans-serif';
            ctx.fillText('👑', x + cardWidth - 16, y + 12);
        }

        ctx.font = 'bold 9px monospace';
        const killsText = `${p.kills || 0}`;
        const deathsText = `${p.deaths || 0}`;
        const fameText = formatFame(p.fame || 0);

        const textY = y + 62;
        ctx.fillStyle = '#33bfff';
        ctx.fillText(killsText, x + 8, textY);
        ctx.fillStyle = '#5a6b7c';
        ctx.fillText('/', x + 22, textY);
        ctx.fillStyle = '#ff5555';
        ctx.fillText(deathsText, x + 28, textY);
        
        ctx.fillStyle = '#f5c84c';
        ctx.font = 'bold 8px monospace';
        ctx.textAlign = 'right';
        ctx.fillText(fameText, x + cardWidth - 6, textY);
        ctx.textAlign = 'left'; 
    });

    // 4. ส่วน Footer ด้านล่างสุด
    const footerY = height - 42;
    
    ctx.fillStyle = '#e6c662';
    ctx.font = 'bold 12px sans-serif';
    ctx.fillText('🛡️  GUILD BATTLE', padding, footerY);
    
    ctx.fillStyle = '#7a8b99';
    ctx.font = '11px sans-serif';
    ctx.fillText(matchInfo.targetGuildName ? `I ${matchInfo.targetGuildName} I` : 'VICTORY BELONGS TO THOSE WHO FIGHT TOGETHER', padding, footerY + 18);

    const brandRightX = width - padding;
    
    ctx.textAlign = 'right';
    ctx.fillStyle = '#7a8b99';
    ctx.font = 'bold 9px sans-serif';
    ctx.fillText('POWERED BY', brandRightX, footerY);
    
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 12px sans-serif';
    ctx.fillText('BossBot', brandRightX, footerY + 16);

    const brandIconSize = 24;
    const brandIconX = brandRightX - 110 - brandIconSize;
    const brandIconY = footerY - 2;

    if (frameIconImg) {
        try {
            ctx.drawImage(frameIconImg, brandIconX, brandIconY, brandIconSize, brandIconSize);
        } catch (e) {
            ctx.fillStyle = '#f5c84c';
            ctx.fillRect(brandIconX, brandIconY, brandIconSize, brandIconSize);
        }
    } else {
        ctx.fillStyle = '#f5c84c';
        ctx.beginPath();
        ctx.arc(brandIconX + 12, brandIconY + 12, 10, 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.textAlign = 'left';

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
        ctx.beginPath(); ctx.roundRect(cardX, y, cardWidth, cardHeight, 12); ctx.fill();
        const percent = Math.max(0, Math.min(100, Number(p.percent) || 0));
        const barWidth = Math.min(cardWidth, cardWidth * percent / 100);
        if (barWidth > 0) {
            ctx.fillStyle = p.type === 'heal' ? '#21b293' : '#ff4d6d';
            ctx.beginPath(); ctx.roundRect(cardX, y, barWidth, cardHeight, 12); ctx.fill();
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
        const typeLabel = p.type === 'heal' ? '💚 HEAL' : '⚔️ DMG';
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
    const report = `🔗 **Battle Link:** <${battleUrl}>\n` + '```ansi\n' + header + body + footer + awardsText + '