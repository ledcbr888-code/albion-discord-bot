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
        targetGuilds = Array.isArray(data.guilds) ? data.guilds : [];
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

function extractMainHandFromObject(obj) {
    if (!obj || typeof obj !== 'object') return '';
    const direct = [
        obj.MainHand, obj.mainHand, obj.MAINHAND, obj.mainhand, obj.Mainhand,
        obj.Equipment?.MainHand, obj.equipment?.MainHand, obj.Equipment?.mainHand, obj.equipment?.mainHand,
        obj.Equipment?.mainhand, obj.equipment?.mainhand, obj.weapon, obj.Weapon, obj.weaponId, obj.WeaponId,
        obj.mainHandItem, obj.MainHandItem
    ];
    for (const candidate of direct) {
        const id = normalizeAlbionItemId(candidate);
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
        const attrs = [
            $el.attr('src'), $el.attr('data-src'), $el.attr('data-original'), $el.attr('data-item-id'), $el.attr('data-itemid'), $el.attr('data-type'), 
            $el.attr('data-unique-name'), $el.attr('href')
        ].filter(Boolean);
        
        let id = '';
        for (const raw of attrs) {
            const candidate = normalizeAlbionItemId(raw);
            if (candidate) { id = candidate; break; }
        }
        if (!id || !isWeaponItemId(id)) return;
        
        const ownText = [$el.attr('alt'), $el.attr('title'), $el.attr('class'), $el.attr('data-slot'), $el.attr('data-equipment-slot')].filter(Boolean).join(' ').toLowerCase();
        const parent = $el.closest('td, div, li, a').first();
        const parentText = `${parent.text()} ${parent.attr('class') || ''} ${parent.attr('data-slot') || ''} ${parent.attr('data-equipment-slot') || ''}`.toLowerCase();
        const context = `${ownText} ${parentText}`;
        let score = 10 - Math.min(index, 20) * 0.1;
        if (/main[\s_-]?hand/.test(context)) score += 100;
        if (/weapon/.test(context)) score += 25;
        if (/off[\s_-]?hand|shield|torch|tome|book|orb|horn/.test(context)) score -= 100;
        candidates.push({ id, score });
    });
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0]?.id || '';
}

async function fetchAlbionBBPage(matchId) {
    // AlbionBB is Cloudflare-protected. This remains a non-critical fallback.
    const url = `https://east.albionbb.com/battles/${encodeURIComponent(matchId)}`;
    try {
        return await cloudscraper.get({
            url, timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            }
        });
    } catch (err) {
        console.warn(`⚠️ AlbionBB unavailable (Cloudflare/HTTP): ${err.message}`);
        return null;
    }
}

async function fetchRecentOfficialBattles() {
    const url = 'https://gameinfo-sgp.albiononline.com/api/gameinfo/battles?sort=recent';
    try {
        const response = await axios.get(url, {
            timeout: 20000,
            headers: {
                'User-Agent': 'Albion-Discord-Bot/1.0',
                'Accept': 'application/json'
            }
        });

        const data = response.data;
        const list = Array.isArray(data)
            ? data
            : Array.isArray(data?.battles)
                ? data.battles
                : Array.isArray(data?.data)
                    ? data.data
                    : [];

        return list
            .map(b => String(b?.id ?? b?.Id ?? b?.battleId ?? b?.BattleId || '').trim())
            .filter(id => /^\d+$/.test(id));
    } catch (err) {
        console.warn(`⚠️ Official recent battles API (East) error: ${err.message}`);
        return [];
    }
}

function readCellNumber(value) {
    return parseInt(String(value || '').replace(/[^\d.-]/g, ''), 10) || 0;
}

function parseDataFromHTML(html) {
    const $ = cheerio.load(html);
    const players = [];
    const guilds = [];
    const battleTime = $('time[datetime]').attr('datetime') || $('time').first().text().trim() || $('.battle-time').first().text().trim() || null;

    $('table').each((_, table) => {
        const headers = [];
        $(table).find('thead tr').first().find('th,td').each((__, cell) => headers.push($(cell).text().replace(/\s+/g, ' ').trim().toLowerCase()));
        if (!headers.length) return;
        
        const indexOf = (...names) => {
            for (const name of names) { const i = headers.indexOf(name); if (i !== -1) return i; }
            return -1;
        };
        
        const nameIndex = indexOf('name', 'player', 'player name');
        const guildIndex = indexOf('guild', 'guild name', 'alliance');
        const killIndex = indexOf('kills', 'kill');
        const deathIndex = indexOf('deaths', 'death');
        const fameIndex = indexOf('fame', 'kill fame', 'killfame');
        const damageIndex = headers.findIndex(h => /damage|dmg/.test(h));
        const healingIndex = headers.findIndex(h => /heal|healing/.test(h));

        $(table).find('tbody tr').each((__, row) => {
            const cells = [];
            $(row).find('td').each((___, td) => cells.push($(td).text().replace(/\s+/g, ' ').trim()));
            if (!cells.length) return;

            if (nameIndex < 0) {
                const gName = guildIndex >= 0 ? cells[guildIndex] : cells[0];
                if (gName) guilds.push({ name: gName });
                return;
            }

            const name = cells[nameIndex] || '';
            const guild = guildIndex >= 0 ? cells[guildIndex] : '';
            if (!name) return;

            const p = {
                name, guild,
                kills: killIndex >= 0 ? readCellNumber(cells[killIndex]) : 0,
                deaths: deathIndex >= 0 ? readCellNumber(cells[deathIndex]) : 0,
                fame: fameIndex >= 0 ? parseFameValue(cells[fameIndex]) : 0,
                damage: damageIndex >= 0 ? parseFameValue(cells[damageIndex]) : 0,
                healing: healingIndex >= 0 ? parseFameValue(cells[healingIndex]) : 0,
                weapon: extractMainHandFromRow($, row)
            };

            if (killIndex >= 0 || deathIndex >= 0 || damageIndex >= 0 || healingIndex >= 0) players.push(p);
        });
    });
    return { players, guilds, battleTime };
}

function parseNextData(html) {
    const $ = cheerio.load(html);
    const raw = $('script#__NEXT_DATA__').html();
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (_) { return null; }
}

function findTimeInNextData(obj) {
    if (!obj || typeof obj !== 'object') return null;
    const keys = ['startTime', 'endTime', 'time', 'timestamp', 'date', 'createdAt'];
    if (Array.isArray(obj)) {
        for (const item of obj) { const found = findTimeInNextData(item); if (found) return found; }
        return null;
    }
    for (const [key, value] of Object.entries(obj)) {
        if (keys.includes(key) && value) return value;
        if (value && typeof value === 'object') { const found = findTimeInNextData(value); if (found) return found; }
    }
    return null;
}

function findPlayerArrays(obj) {
    const found = [];
    function walk(value, key = '') {
        if (!value || typeof value !== 'object') return;
        if (/guild|alliance|team/i.test(key)) return;

        if (Array.isArray(value)) {
            if (value.some(x => x && typeof x === 'object' && (x.playerName || x.PlayerName || (x.name && x.guildName)))) {
                found.push(value);
            }
            for (const item of value) walk(item, key);
            return;
        }
        for (const [k, child] of Object.entries(value)) {
            if (child && typeof child === 'object') walk(child, k);
        }
    }
    walk(obj);
    return found;
}

function objectToPlayer(obj) {
    if (!obj || typeof obj !== 'object') return null;
    const name = obj.name ?? obj.Name ?? obj.playerName ?? obj.PlayerName;
    if (!name || typeof name !== 'string') return null;
    const guild = obj.guildName ?? obj.GuildName ?? obj.guild ?? obj.Guild ?? '';
    return {
        name: String(name), guild: typeof guild === 'string' ? guild : '',
        kills: Number(obj.kills ?? obj.Kills ?? obj.kill ?? obj.Kill ?? 0) || 0,
        deaths: Number(obj.deaths ?? obj.Deaths ?? obj.death ?? obj.Death ?? 0) || 0,
        fame: parseFameValue(obj.killFame ?? obj.killfame ?? obj.fame ?? obj.Fame ?? obj.KillFame ?? 0),
        damage: parseFameValue(obj.damage ?? obj.Damage ?? obj.totalDamage ?? obj.TotalDamage ?? 0),
        healing: parseFameValue(obj.healing ?? obj.Healing ?? obj.totalHealing ?? obj.TotalHealing ?? 0),
        weapon: extractMainHandFromObject(obj)
    };
}

async function fetchOfficialBattle(matchId) {
    const url = `https://gameinfo-sgp.albiononline.com/api/gameinfo/battles/${encodeURIComponent(matchId)}`;
    try {
        const response = await axios.get(url, { timeout: 20000, headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
        if (response.data) return response.data;
    } catch (err) {
        console.warn(`⚠️ Official battle API (East) error: ${err.message}`);
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
    for (const list of lists) {
        for (const p of list || []) {
            if (!p?.name) continue;
            const key = p.name.toLowerCase();
            const old = map.get(key);
            if (!old) { map.set(key, { ...p }); continue; }
            old.guild ||= p.guild;
            old.kills = Math.max(old.kills, p.kills);
            old.deaths = Math.max(old.deaths, p.deaths);
            old.fame = Math.max(old.fame, p.fame);
            old.damage = Math.max(old.damage, p.damage);
            old.healing = Math.max(old.healing, p.healing);
            if (!old.weapon && p.weapon) old.weapon = p.weapon;
        }
    }
    return [...map.values()];
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
    if (!value) return { id: '', server: '' };
    
    // Check for URL and extract server if possible
    const urlMatch = value.match(/https?:\/\/(east|west|europe)\.albionbb\.com\/battles\/([^/?#\s]+)/i);
    if (urlMatch) {
        return { id: urlMatch[2], server: urlMatch[1].toLowerCase() };
    }
    
    // Generic battle link check
    if (/^https?:\/\//i.test(value)) {
        const match = value.match(/\/battles\/([^/?#]+)/i);
        if (match) return { id: match[1], server: '' };
    }
    
    return { id: value, server: '' };
}

async function buildBattleReportPayload(matchId, customTargetGuilds = targetGuilds) {
    const server = 'east';
    // Use the official Albion API first so Cloudflare on AlbionBB cannot block reports.
    const apiData = /^\d+$/.test(matchId) ? await fetchOfficialBattle(matchId) : null;

    // Keep the existing AlbionBB parser only as a fallback for non-API cases.
    const html = apiData ? null : await fetchAlbionBBPage(matchId, server);

    let htmlData = { players: [], guilds: [], battleTime: null };
    let nextPlayers = [], nextTime = null;

    if (html) {
        htmlData = parseDataFromHTML(html);
        const nextData = parseNextData(html);
        if (nextData) {
            nextTime = findTimeInNextData(nextData);
            nextPlayers = findPlayerArrays(nextData).flatMap(arr => arr.map(objectToPlayer).filter(Boolean));
        }
    }

    const battleTime = htmlData.battleTime || nextTime || null;

    const knownGuildNames = new Set([
        ...htmlData.guilds.map(g => g.name.trim().toLowerCase()),
        ...(apiData?.guilds ? Object.values(apiData.guilds).map(g => g.name?.trim().toLowerCase()).filter(Boolean) : []),
        ...(apiData?.alliances ? Object.values(apiData.alliances).map(a => a.name?.trim().toLowerCase()).filter(Boolean) : [])
    ]);

    let rawPlayers = mergePlayerRecords(htmlData.players, nextPlayers, getApiPlayers(apiData));

    let allPlayers = rawPlayers.filter(p => !knownGuildNames.has(p.name.trim().toLowerCase()));

    if (!allPlayers.length && rawPlayers.length > 0) {
        allPlayers = rawPlayers;
    }

    if (!allPlayers.length) throw new Error('ไม่พบข้อมูลผู้เล่นจาก AlbionBB หรือ Official Albion API');

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
                weapon: p.weapon || ''
            });
        } else {
            old.kills = Math.max(old.kills, Number(p.kills) || 0);
            old.deaths = Math.max(old.deaths, Number(p.deaths) || 0);
            old.fame = Math.max(old.fame, Number(p.fame) || 0);
            old.damage = Math.max(old.damage, Number(p.damage) || 0);
            old.healing = Math.max(old.healing, Number(p.healing) || 0);
            if (!old.weapon && p.weapon) old.weapon = p.weapon;
            if (!old.guild && p.guild) old.guild = p.guild;
        }
    }

    const widths = { name: 20, kills: 8, deaths: 8, fame: 10 };
    const totalWidth = widths.name + widths.kills + widths.deaths + widths.fame;
    const divider = '='.repeat(totalWidth);
    const subDivider = '-'.repeat(totalWidth);

    const allSortedRows = [...reportStats.values()].sort((a, b) => b.fame - a.fame || b.kills - a.kills || b.damage - a.damage);

    const rows = allSortedRows.filter(p => {
        if (customTargetGuilds.length === 0 && targetPlayers.length === 0) return true;
        const isExplicitPlayer = targetPlayers.some(pl => pl.trim().toLowerCase() === p.displayName.trim().toLowerCase());
        const isGuildMatch = p.guild && customTargetGuilds.some(g => p.guild.trim().toLowerCase().includes(g.trim().toLowerCase()) || g.trim().toLowerCase().includes(p.guild.trim().toLowerCase()));
        return isGuildMatch || isExplicitPlayer || customTargetGuilds.length === 0;
    });

    let totalKills = 0, totalDeaths = 0, totalFame = 0;
    const targetRowsToCalc = rows.length > 0 ? rows : allSortedRows;
    for (const p of targetRowsToCalc) {
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

    const awardCandidates = rows.length > 0 ? rows : allSortedRows;
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
    const displayRows = rows.length > 0 ? rows : allSortedRows;
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

    const battleUrl = `https://${server}.albionbb.com/battles/${matchId}`;
    const report = `🔗 **Battle Link:** <${battleUrl}>\n` + '```ansi\n' + header + body + footer + awardsText + '```';

    const performancePlayers = displayRows
        .filter(p => p.damage > 0 || p.healing > 0)
        .sort((a, b) => (b.damage + b.healing) - (a.damage + a.healing))
        .slice(0, 5);

    const attachments = [];

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

    return {
        matchId,
        totalFame,
        battleUrl,
        payload: { content: report, files: attachments }
    };
}

async function processBattleReport(input, targetContext, isMessage = false) {
    try {
        const { id: matchId } = extractMatchId(input);
        if (!matchId) throw new Error('ไม่พบ Match ID');
        
        const { payload } = await buildBattleReportPayload(matchId, targetGuilds);
        if (isMessage) await targetContext.edit(payload); else await targetContext.editReply(payload);
    } catch (err) {
        console.error('❌ Process battle report error:', err);
        const message = `❌ เกิดข้อผิดพลาดในการประมวลผลไฟต์: \`${err.message}\``;
        if (isMessage) await targetContext.edit(message); else await targetContext.editReply(message);
    }
}

async function checkAutoBattles() {
    if (!autoBattleConfigs.length) return;
    if (autoBattleCheckRunning) {
        console.warn('⚠️ Auto-Battle check skipped because the previous check is still running.');
        return;
    }

    autoBattleCheckRunning = true;
    try {
        // Do not scrape the Cloudflare-protected AlbionBB homepage.
        const recentMatches = await fetchRecentOfficialBattles();

        for (const matchId of recentMatches.slice(0, 15)) {
            if (processedBattles.has(matchId)) continue;
            
            for (const config of autoBattleConfigs) {
                try {
                    const result = await buildBattleReportPayload(matchId, [config.targetGuild]);
                    if (result.totalFame >= config.minFame) {
                        const channel = await client.channels.fetch(config.channelId).catch(() => null);
                        if (channel) {
                            await channel.send(`🚨 **Auto-Battle Alert!** ตรวจพบไฟต์ของกิลด์ **${config.targetGuild}**\n📊 Fame รวม: \`${formatFame(result.totalFame)}\`\n🔗 Link: <${result.battleUrl}>`);
                            await channel.send(result.payload);
                        }
                    }
                } catch (e) {
                    console.error(`⚠️ Auto-check error for match ${matchId}:`, e.message);
                }
            }
            processedBattles.add(matchId);
            if (processedBattles.size > 200) {
                const arr = [...processedBattles];
                processedBattles = new Set(arr.slice(100));
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
        .addSubcommand(s => s.setName('battles').setDescription('เช็กสถิติไฟต์จาก Match ID หรือ ลิงก์')
            .addStringOption(o => o.setName('link_or_id').setDescription('ลิงก์ AlbionBB หรือ Match ID').setRequired(true)))
        .addSubcommand(s => s.setName('guilds').setDescription('แสดงรายชื่อกิลด์ที่ติดตาม'))
        .addSubcommand(s => s.setName('members').setDescription('แสดงรายชื่อผู้เล่นที่ติดตาม')),
    new SlashCommandBuilder().setName('add').setDescription('เพิ่มรายการติดตาม')
        .addSubcommand(s => s.setName('guild').setDescription('เพิ่มกิลด์').addStringOption(o => o.setName('name').setDescription('ชื่อกิลด์').setRequired(true)))
        .addSubcommand(s => s.setName('player').setDescription('เพิ่มผู้เล่น').addStringOption(o => o.setName('name').setDescription('ชื่อผู้เล่น').setRequired(true))),
    new SlashCommandBuilder().setName('remove').setDescription('ลบรายการติดตาม')
        .addSubcommand(s => s.setName('guild').setDescription('ลบกิลด์').addStringOption(o => o.setName('name').setDescription('ชื่อกิลด์').setRequired(true)))
        .addSubcommand(s => s.setName('player').setDescription('ลบผู้เล่น').addStringOption(o => o.setName('name').setDescription('ชื่อผู้เล่น').setRequired(true))),
    new SlashCommandBuilder().setName('autobattle').setDescription('จัดการระบบติดตามไฟต์อัตโนมัติ')
        .addSubcommand(s => s.setName('set').setDescription('ตั้งค่าระบบติดตามไฟต์อัตโนมัติ')
            .addChannelOption(o => o.setName('channel').setDescription('ห้องที่ต้องการให้แจ้งเตือน').addChannelTypes(ChannelType.GuildText).setRequired(true))
            .addStringOption(o => o.setName('guild').setDescription('ชื่อ Guild ที่ต้องการติดตาม').setRequired(true))
            .addStringOption(o => o.setName('min_fame').setDescription('Fame ขั้นต่ำ เช่น 300K, 1M').setRequired(true)))
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

    try {
        const recentMatches = await fetchRecentOfficialBattles();
        for (const matchId of recentMatches) processedBattles.add(matchId);
        console.log(`✅ Initialized with ${processedBattles.size} existing matches from Official Albion API. Monitoring for new battles...`);
    } catch (err) {
        console.error('⚠️ Initial battle fetch failed:', err.message);
    }

    setTimeout(checkAutoBattles, 15000);
    setInterval(checkAutoBattles, 5 * 60 * 1000);
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    const { commandName } = interaction;

    if (commandName === 'check') {
        const sub = interaction.options.getSubcommand();
        if (sub === 'guilds') {
            if (!targetGuilds.length) return interaction.reply('🛡️ ไม่มีกิลด์ในระบบติดตาม');
            return interaction.reply(`🛡️ **กิลด์ที่ติดตาม (${targetGuilds.length})**\n\`\`\`\n${targetGuilds.map((x, i) => `${i + 1}. ${x}`).join('\n')}\n\`\`\``);
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
        const sub = interaction.options.getSubcommand(), name = interaction.options.getString('name').trim();
        if (sub === 'guild') {
            if (targetGuilds.some(x => x.toLowerCase() === name.toLowerCase())) return interaction.reply({ content: `⚠️ กิลด์ **${name}** มีอยู่แล้ว`, flags: 64 });
            targetGuilds.push(name); saveData(); return interaction.reply(`🛡️ เพิ่มกิลด์ **${name}** แล้ว`);
        }
        if (sub === 'player') {
            if (targetPlayers.some(x => x.toLowerCase() === name.toLowerCase())) return interaction.reply({ content: `⚠️ ผู้เล่น **${name}** มีอยู่แล้ว`, flags: 64 });
            targetPlayers.push(name); saveData(); return interaction.reply(`✅ เพิ่มผู้เล่น **${name}** แล้ว`);
        }
    }

    if (commandName === 'remove') {
        const sub = interaction.options.getSubcommand(), name = interaction.options.getString('name').trim();
        if (sub === 'guild') {
            const before = targetGuilds.length; targetGuilds = targetGuilds.filter(x => x.toLowerCase() !== name.toLowerCase());
            if (before === targetGuilds.length) return interaction.reply({ content: `❌ ไม่พบกิลด์ **${name}**`, flags: 64 });
            saveData(); return interaction.reply(`🗑️ ลบกิลด์ **${name}** แล้ว`);
        }
        if (sub === 'player') {
            const before = targetPlayers.length; targetPlayers = targetPlayers.filter(x => x.toLowerCase() !== name.toLowerCase());
            if (before === targetPlayers.length) return interaction.reply({ content: `❌ ไม่พบผู้เล่น **${name}**`, flags: 64 });
            saveData(); return interaction.reply(`🗑️ ผู้เล่น **${name}** แล้ว`);
        }
    }

    if (commandName === 'autobattle') {
        const sub = interaction.options.getSubcommand();

        if (sub === 'set') {
            await interaction.deferReply();
            const channel = interaction.options.getChannel('channel');
            const guildName = interaction.options.getString('guild').trim();
            const minFameInput = interaction.options.getString('min_fame');
            const minFame = parseFameValue(minFameInput);

            let existingConfigs = autoBattleConfigs.filter(c => c.guildId === interaction.guildId);
            const duplicateIndex = existingConfigs.findIndex(c => c.targetGuild.toLowerCase() === guildName.toLowerCase());

            const configData = {
                guildId: interaction.guildId,
                channelId: channel.id,
                targetGuild: guildName,
                minFame: minFame
            };

            if (duplicateIndex >= 0) {
                const globalIndex = autoBattleConfigs.findIndex(c => c.guildId === interaction.guildId && c.targetGuild.toLowerCase() === guildName.toLowerCase());
                if (globalIndex >= 0) autoBattleConfigs[globalIndex] = configData;
            } else {
                autoBattleConfigs.push(configData);
            }
            saveData();

            return interaction.editReply(`✅ ตั้งค่า **Auto-Battle Tracker** สำเร็จเรียบร้อย!\n- 🌍 เซิร์ฟเวอร์: **Asia (East)**\n- 📢 ห้องแจ้งเตือน: <#${channel.id}>\n- 🛡️ กิลด์ที่ติดตาม: **${guildName}**\n- 📊 ขั้นต่ำ Fame: **${formatFame(minFame)}**\n\n📌 *ระบบจะคอยตรวจสอบไฟต์การต่อสู้ใหม่ๆ ของกิลด์นี้ให้อัตโนมัติทุกๆ 5 นาทีครับ*`);
        }

        if (sub === 'list') {
            const serverConfigs = autoBattleConfigs.filter(c => c.guildId === interaction.guildId);
            if (!serverConfigs.length) return interaction.reply({ content: '🛡️ เซิร์ฟเวอร์นี้ยังไม่มีการตั้งค่า Auto-Battle สำหรับกิลด์ใดๆ', flags: 64 });

            let listText = serverConfigs.map((c, i) => {
                return `${i + 1}. กิลด์: **${c.targetGuild}** | ห้อง: <#${c.channelId}> | ขั้นต่ำ Fame: **${formatFame(c.minFame)}**`;
            }).join('\n');
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
    const match = message.content.match(/https?:\/\/(?:east|west|europe)\.albionbb\.com\/battles\/([^\s]+)/i);
    if (!match) return;
    
    const matchId = match[1];
    
    try {
        const status = await message.reply('⏳ กำลังดึงสถิติจาก AlbionBB (East)...');
        await processBattleReport(matchId, status, true);
    } catch (err) { console.error('❌ messageCreate error:', err); }
});

client.on('error', err => console.error('❌ Discord client error:', err));
process.on('unhandledRejection', err => console.error('❌ Unhandled rejection:', err));
process.on('uncaughtException', err => console.error('❌ Uncaught exception:', err));

client.login(BOT_TOKEN);