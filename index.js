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
const Tesseract = require('tesseract.js');
const sharp = require('sharp'); // 📦 เพิ่มไลบรารีสำหรับจัดการภาพ
const fs = require('fs');
const path = require('path');
const express = require('express');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
app.get('/', (_, res) => res.status(200).send('Albion Discord Bot is running.'));
app.listen(PORT, () => console.log(`🌐 Web server listening on port ${PORT}`));

const BOT_TOKEN = String(process.env.BOT_TOKEN || '').trim();

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
let autoBattleConfig = {
    channelId: null,
    minFame: 500000,
    guilds: [],
    enabled: false
};
let imageTimerConfig = {
    sourceChannelId: null,
    alertChannelId: null,
    enabled: true
};
let processedBattles = [];

function loadData() {
    try {
        if (!fs.existsSync(DATA_FILE)) {
            saveData();
            return;
        }
        const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        targetPlayers = Array.isArray(data.players) ? data.players : [];
        targetGuilds = Array.isArray(data.guilds) ? data.guilds : [];
        if (data.autoBattle) autoBattleConfig = { ...autoBattleConfig, ...data.autoBattle };
        if (data.imageTimer) imageTimerConfig = { ...imageTimerConfig, ...data.imageTimer };
        processedBattles = Array.isArray(data.processedBattles) ? data.processedBattles : [];
        console.log(`📁 Tracking loaded successfully.`);
    } catch (err) {
        console.error('❌ tracking.json load error:', err.message);
        targetPlayers = [];
        targetGuilds = [];
    }
}

function saveData() {
    try {
        if (processedBattles.length > 300) processedBattles = processedBattles.slice(-300);

        fs.writeFileSync(DATA_FILE, JSON.stringify({
            players: targetPlayers,
            guilds: targetGuilds,
            autoBattle: autoBattleConfig,
            imageTimer: imageTimerConfig,
            processedBattles: processedBattles
        }, null, 2), 'utf8');
    } catch (err) {
        console.error('❌ tracking.json save error:', err.message);
    }
}

loadData();

function parseFameValue(value) {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    let str = String(value).trim().toLowerCase().replace(/,/g, '');
    if (!str) return 0;
    let multiplier = 1;
    if (str.endsWith('b')) { multiplier = 1e9; str = str.slice(0, -1); }
    else if (str.endsWith('m')) { multiplier = 1e6; str = str.slice(0, -1); }
    else if (str.endsWith('k')) { multiplier = 1e3; str = str.slice(0, -1); }
    const n = parseFloat(str.replace(/[^\d.-]/g, ''));
    return Number.isFinite(n) ? Math.round(n * multiplier) : 0;
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
    return value.replace(/\s+/g, '_').replace(/\.png(?:\?.*)?$|/i, '').replace(/@(\d+)Q\d+/i, '@$1').trim();
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
    $(row).find('img, [data-item-id], [data-itemid], [data-type], a[href*="/items/"]').each((index, el) => {
        const $el = $(el);
        const attrs = [$el.attr('src'), $el.attr('data-src'), $el.attr('data-original'), $el.attr('data-item-id'),
            $el.attr('data-itemid'), $el.attr('data-type'), $el.attr('href')].filter(Boolean);
        let id = '';
        for (const raw of attrs) {
            const candidate = normalizeAlbionItemId(raw);
            if (candidate) { id = candidate; break; }
        }
        if (!id || !isWeaponItemId(id)) return;
        const ownText = [$el.attr('alt'), $el.attr('title'), $el.attr('class'), $el.attr('data-slot'),
            $el.attr('data-equipment-slot')].filter(Boolean).join(' ').toLowerCase();
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
    const url = `https://east.albionbb.com/battles/${encodeURIComponent(matchId)}`;
    try {
        return await cloudscraper.get({
            url, timeout: 20000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            }
        });
    } catch (err) {
        console.error('❌ AlbionBB fetch error:', err.message);
        return null;
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
            const name = nameIndex >= 0 ? cells[nameIndex] : cells[0] || '';
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
            if (guild && nameIndex < 0) guilds.push({ name: guild, kills: p.kills, deaths: p.deaths, fame: p.fame });
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
    function walk(value) {
        if (!value || typeof value !== 'object') return;
        if (Array.isArray(value)) {
            if (value.some(x => x && typeof x === 'object' && (x.name || x.Name || x.playerName || x.PlayerName))) found.push(value);
            for (const item of value) walk(item);
            return;
        }
        for (const child of Object.values(value)) if (child && typeof child === 'object') walk(child);
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
    const urls = [
        `https://gameinfo.albiononline.com/api/gameinfo/battles/${encodeURIComponent(matchId)}`,
        `https://gameinfo-sgp.albiononline.com/api/gameinfo/battles/${encodeURIComponent(matchId)}`
    ];
    for (const url of urls) {
        try {
            const response = await axios.get(url, { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
            if (response.data) return response.data;
        } catch (err) { console.log(`⚠️ Official API failed: ${err.message}`); }
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
    const width = 760, cardHeight = 84, gap = 12, padding = 18;
    const height = padding * 2 + players.length * cardHeight + Math.max(0, players.length - 1) * gap;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#bda289';
    ctx.fillRect(0, 0, width, height);

    for (let i = 0; i < players.length; i++) {
        const p = players[i], y = padding + i * (cardHeight + gap), cardX = padding, cardWidth = width - padding * 2;
        ctx.fillStyle = '#a28c78';
        ctx.beginPath(); ctx.roundRect(cardX, y, cardWidth, cardHeight, 12); ctx.fill();
        const percent = Math.max(0, Math.min(100, Number(p.percent) || 0));
        const barWidth = Math.min(cardWidth, cardWidth * percent / 100);
        if (barWidth > 0) {
            ctx.fillStyle = p.type === 'heal' ? '#21b293' : '#ff4d6d';
            ctx.beginPath(); ctx.roundRect(cardX, y, barWidth, cardHeight, 12); ctx.fill();
        }

        const weaponId = normalizeAlbionItemId(p.weapon);
        if (weaponId && isWeaponItemId(weaponId)) {
            try {
                const weaponImg = await loadImage(`https://render.albiononline.com/v1/item/${encodeURIComponent(weaponId)}.png`);
                const size = 60;
                ctx.drawImage(weaponImg, cardX + 12, y + (cardHeight - size) / 2, size, size);
            } catch (err) { console.error(`⚠️ Weapon image failed: ${weaponId}: ${err.message}`); }
        }

        let name = p.name;
        if (name.length > 25) name = `${name.slice(0, 22)}...`;
        ctx.fillStyle = '#000000';
        ctx.font = 'bold 22px sans-serif';
        ctx.fillText(name, cardX + 88, y + 36);

        ctx.fillStyle = '#111111';
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

async function processBattleReport(input, targetContext, isMessage = false, isAuto = false) {
    try {
        const matchId = extractMatchId(input);
        const html = await fetchAlbionBBPage(matchId);
        let htmlData = { players: [], guilds: [], battleTime: null };
        if (html) htmlData = parseDataFromHTML(html);

        let nextPlayers = [], nextTime = null;
        if (html) {
            const nextData = parseNextData(html);
            if (nextData) {
                nextTime = findTimeInNextData(nextData);
                nextPlayers = findPlayerArrays(nextData).flatMap(arr => arr.map(objectToPlayer).filter(Boolean));
            }
        }

        let allPlayers = mergePlayerRecords(htmlData.players, nextPlayers);
        const apiData = /^\d+$/.test(matchId) ? await fetchOfficialBattle(matchId) : null;
        allPlayers = mergePlayerRecords(allPlayers, getApiPlayers(apiData));
        const battleTime = htmlData.battleTime || nextTime || apiData?.startTime || apiData?.endTime || null;
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
        const activeGuilds = autoBattleConfig.guilds.length > 0 ? autoBattleConfig.guilds : targetGuilds;

        const rows = allSortedRows.filter(p => {
            if (activeGuilds.length === 0 && targetPlayers.length === 0) return true;
            const isGuildName = activeGuilds.some(g => g.trim().toLowerCase() === p.displayName.trim().toLowerCase());
            const isExplicitPlayer = targetPlayers.some(pl => pl.trim().toLowerCase() === p.displayName.trim().toLowerCase());
            if (isGuildName && !isExplicitPlayer) return false;
            const isGuildMatch = p.guild && activeGuilds.some(g => g.trim().toLowerCase() === p.guild.trim().toLowerCase());
            return isGuildMatch || isExplicitPlayer;
        });

        let totalKills = 0, totalDeaths = 0, totalFame = 0;
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

        const awardCandidates = rows.length > 0 ? rows : allSortedRows;
        const mvp = [...awardCandidates].sort((a, b) => (b.damage + b.healing) - (a.damage + a.healing))[0];
        const executioner = [...awardCandidates].sort((a, b) => b.kills - a.kills)[0];
        const feeder = [...awardCandidates].sort((a, b) => b.deaths - a.deaths)[0];

        let awardsText = `\x1b[30m${subDivider}\x1b[0m\n`;
        awardsText += `\x1b[1;35m🏆 BATTLE AWARDS\x1b[0m\n`;
        if (mvp && (mvp.damage > 0 || mvp.healing > 0)) {
            const valText = mvp.healing > mvp.damage ? `Heal: ${formatFame(mvp.healing)}` : `DMG: ${formatFame(mvp.damage)}`;
            awardsText += `\x1b[1;33m👑 MVP        :\x1b[0m \x1b[1;37m${mvp.displayName.padEnd(14)}\x1b[0m \x1b[36m(${valText})\x1b[0m\n`;
        }
        if (executioner && executioner.kills > 0) {
            awardsText += `\x1b[1;32m🎯 Executioner :\x1b[0m \x1b[1;37m${executioner.displayName.padEnd(14)}\x1b[0m \x1b[32m(${executioner.kills} Kills)\x1b[0m\n`;
        }
        if (feeder && feeder.deaths > 0) {
            awardsText += `\x1b[1;31m💀 Feeder      :\x1b[0m \x1b[1;37m${feeder.displayName.padEnd(14)}\x1b[0m \x1b[31m(${feeder.deaths} Deaths)\x1b[0m\n`;
        }

        let body = '';
        if (rows.length === 0) {
            body = `\x1b[30m(ไม่พบกิลด์หรือผู้เล่นที่ติดตามในไฟต์นี้)\x1b[0m\n`;
        } else {
            for (let i = 0; i < rows.length; i++) {
                const p = rows[i];
                const name = p.displayName.slice(0, widths.name - 1).padEnd(widths.name);
                const kills = centerString(p.kills, widths.kills);
                const deaths = centerString(p.deaths, widths.deaths);
                const fame = centerString(formatFame(p.fame), widths.fame);

                const line = `\x1b[1;37m${name}\x1b[0m${p.kills > 0 ? `\x1b[32m${kills}\x1b[0m` : `\x1b[30m${kills}\x1b[0m`}${p.deaths > 0 ? `\x1b[31m${deaths}\x1b[0m` : `\x1b[30m${deaths}\x1b[0m`}${p.fame > 0 ? `\x1b[33m${fame}\x1b[0m` : `\x1b[30m${fame}\x1b[0m`}\n`;

                const remainingCount = rows.length - i;
                const testReportLength = ('```ansi\n' + header + body + line + `\x1b[30m... +${remainingCount} more players\x1b[0m\n` + footer + awardsText + '```').length;

                if (testReportLength > 1950) {
                    body += `\x1b[30m... +${remainingCount} more players\x1b[0m\n`;
                    break;
                }
                body += line;
            }
        }

        const report = '```ansi\n' + header + body + footer + awardsText + '```';

        const performancePlayers = rows
            .filter(p => p.damage > 0 || p.healing > 0)
            .sort((a, b) => (b.damage + b.healing) - (a.damage + a.healing))
            .slice(0, 5);

        let imageAttachment = null;
        if (performancePlayers.length) {
            const maxDamage = Math.max(1, ...performancePlayers.map(p => p.damage));
            const maxHealing = Math.max(1, ...performancePlayers.map(p => p.healing));
            const top = performancePlayers.map(p => {
                const heal = p.healing > p.damage, value = heal ? p.healing : p.damage, max = heal ? maxHealing : maxDamage;
                return { name: p.displayName, guild: p.guild, weapon: p.weapon, value, percent: Math.round((value / max) * 100), type: heal ? 'heal' : 'damage' };
            });
            imageAttachment = await generateTopPerformanceImage(top);
        }

        const payload = { content: report, files: imageAttachment ? [imageAttachment] : [] };

        if (isAuto) {
            await targetContext.send(payload);
        } else if (isMessage) {
            await targetContext.edit(payload);
        } else {
            await targetContext.editReply(payload);
        }
    } catch (err) {
        console.error('❌ Process battle report error:', err);
        const message = `❌ เกิดข้อผิดพลาดในการประมวลผลไฟต์: \`${err.message}\``;
        if (isAuto) {
            await targetContext.send(message);
        } else if (isMessage) {
            await targetContext.edit(message);
        } else {
            await targetContext.editReply(message);
        }
    }
}

async function checkAutoBattles() {
    if (!autoBattleConfig.enabled || !autoBattleConfig.channelId) return;

    try {
        const channel = await client.channels.fetch(autoBattleConfig.channelId).catch(() => null);
        if (!channel) return;

        const urls = [
            'https://gameinfo-sgp.albiononline.com/api/gameinfo/battles?limit=20&sort=recent',
            'https://gameinfo.albiononline.com/api/gameinfo/battles?limit=20&sort=recent'
        ];

        let battles = [];
        for (const url of urls) {
            try {
                const res = await axios.get(url, { timeout: 15000 });
                if (Array.isArray(res.data) && res.data.length > 0) {
                    battles = res.data;
                    break;
                }
            } catch (_) {}
        }

        if (!battles.length) return;

        const trackedGuilds = (autoBattleConfig.guilds.length > 0 ? autoBattleConfig.guilds : targetGuilds).map(g => g.toLowerCase().trim());

        for (const battle of battles) {
            const matchId = String(battle.id);
            if (processedBattles.includes(matchId)) continue;

            const totalFame = Number(battle.totalFame || battle.killFame || 0);
            const battleGuilds = Object.values(battle.guilds || {}).map(g => (g.name || '').toLowerCase().trim());
            const hasTrackedGuild = trackedGuilds.length === 0 || battleGuilds.some(bg => trackedGuilds.includes(bg));

            if (hasTrackedGuild) {
                processedBattles.push(matchId);
                saveData();

                if (totalFame >= autoBattleConfig.minFame) {
                    console.log(`🔔 Auto-Battle detected Match ID: ${matchId} (Total Fame: ${totalFame})`);
                    await processBattleReport(matchId, channel, false, true);
                }
            }
        }
    } catch (err) {
        console.error('❌ Auto Battle Check Error:', err.message);
    }
}

async function checkMarketPrice(itemId, city, interaction) {
    const encoded = encodeURIComponent(itemId);
    const priceUrl = `https://east.albion-online-data.com/api/v2/stats/prices/${encoded}.json?locations=${encodeURIComponent(city)}`;
    const historyUrl = `https://east.albion-online-data.com/api/v2/stats/history/${encoded}.json?locations=${encodeURIComponent(city)}&time-scale=24`;
    try {
        const [priceRes, historyRes] = await Promise.all([
            axios.get(priceUrl, { timeout: 15000 }).catch(() => null),
            axios.get(historyUrl, { timeout: 15000 }).catch(() => null)
        ]);
        if (!priceRes?.data?.length) return interaction.editReply(`❌ ไม่พบข้อมูลราคา \`${itemId}\` ที่เมือง \`${city}\``);
        const price = priceRes.data[0];
        const history = historyRes?.data?.[0]?.data;
        const volume = Array.isArray(history) && history.length ? history[history.length - 1].item_count || 0 : 0;
        const embed = new EmbedBuilder().setColor(0x9b59b6).setTitle(`🏷️ Price Check: ${city} (Asia Server)`)
            .setDescription(`**Item ID:** \`${itemId}\``)
            .setThumbnail(`https://render.albiononline.com/v1/item/${encoded}.png`)
            .addFields(
                { name: '💰 Buy Order สูงสุด', value: `\`${Number(price.buy_price_max || 0).toLocaleString()}\` Silver`, inline: true },
                { name: '🏷️ Sell Order ต่ำสุด', value: `\`${Number(price.sell_price_min || 0).toLocaleString()}\` Silver`, inline: true },
                { name: '📊 ยอดขายล่าสุด 24 ชม.', value: `\`${Number(volume).toLocaleString()}\` ชิ้น`, inline: false },
                { name: '🕒 อัปเดต Buy Order', value: price.buy_price_max_date ? formatUTCTime(price.buy_price_max_date) : 'N/A', inline: false }
            ).setFooter({ text: 'ข้อมูลจาก Albion Online Data Project' }).setTimestamp();
        await interaction.editReply({ embeds: [embed] });
    } catch (err) {
        console.error('❌ Price error:', err);
        await interaction.editReply(`❌ เกิดข้อผิดพลาดในการดึงราคา: \`${err.message}\``);
    }
}

// 🔧 ปรับปรุง handleImageTimer: ตัดชั่วโมงหรือ 'h' ออก เหลือเฉพาะนาทีและวินาที
async function handleImageTimer(message, imageUrl) {
    let statusMsg = null;
    let alertChannel = message.channel;
    if (imageTimerConfig.alertChannelId) {
        const fetchedChannel = await client.channels.fetch(imageTimerConfig.alertChannelId).catch(() => null);
        if (fetchedChannel) alertChannel = fetchedChannel;
    }

    const sentMessages = [];

    try {
        statusMsg = await message.reply('🔍 กำลังแต่งภาพและสแกนเวลาถอยหลัง...');

        // 📥 ดาวน์โหลดรูปภาพต้นฉบับเป็น Buffer
        const imageResponse = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 15000 });
        const imageBuffer = Buffer.from(imageResponse.data);

        // 🛠️ 1. ใช้ Sharp ทำ Image Preprocessing ขยายและปรับภาพให้คมชัดสำหรับ OCR
        const processedBuffer = await sharp(imageBuffer)
            .resize({ width: 1000 })
            .grayscale()
            .normalize()
            .threshold(150)
            .toBuffer();

        // 🔍 2. สแกนด้วย Tesseract (ตัด 'h' ออกจาก Whitelist เหลือเฉพาะตัวเลข m, s และเครื่องหมายโคลอน)
        const { data: { text } } = await Tesseract.recognize(processedBuffer, 'eng', {
            tessedit_char_whitelist: '0123456789ms: '
        });
        console.log('🔍 OCR Raw Text:', text);

        // 🧹 3. ทำความสะอาดข้อความ ตัดอักขระขยะออก
        const textClean = text.replace(/[^\w\s:]/gi, ' ').toLowerCase();
        console.log('🧹 Cleaned Text:', textClean);

        let totalSeconds = 0;
        let objectType = 'Power Object / Anomaly';

        if (textClean.includes('anomaly')) objectType = '🔮 Power Anomaly';
        else if (textClean.includes('vortex')) objectType = '🌀 Power Vortex';
        else if (textClean.includes('core')) objectType = '💎 Power Core';
        else if (textClean.includes('chest')) objectType = '📦 Treasure Chest';

        let m = 0, s = 0; // ตัดตัวแปร h ออก เหลือแค่นาที (m) และวินาที (s)
        
        const timeRegexLetter = /(\d+)\s*([ms])/gi;
        let match;
        let foundLetterTime = false;
        while ((match = timeRegexLetter.exec(textClean)) !== null) {
            foundLetterTime = true;
            const val = parseInt(match[1], 10);
            const unit = match[2].toLowerCase();
            if (unit === 'm') m = val;
            else if (unit === 's') s = val;
        }

        if (!foundLetterTime) {
            const colonRegex = /(\d{1,2}):(\d{2})/g;
            const colonMatch = colonRegex.exec(textClean);
            if (colonMatch) {
                m = parseInt(colonMatch[1], 10);
                s = parseInt(colonMatch[2], 10);
            }
        }

        totalSeconds = (m * 60) + s;

        if (totalSeconds <= 0) {
            await statusMsg.edit('⚠️ ไม่พบเวลาถอยหลังในรูปภาพนี้ (โปรดตรวจสอบภาพให้ชัดเจนยิ่งขึ้น)');
            return;
        }

        const unlockTimeMs = Date.now() + (totalSeconds * 1000);
        const unlockTimestamp = Math.floor(unlockTimeMs / 1000);

        let imageAttachment = null;
        try {
            const baseImage = await loadImage(imageBuffer);
            const canvas = createCanvas(baseImage.width, baseImage.height);
            const ctx = canvas.getContext('2d');
            
            ctx.drawImage(baseImage, 0, 0);

            const bannerHeight = 85;
            ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
            ctx.fillRect(0, baseImage.height - bannerHeight, baseImage.width, bannerHeight);

            ctx.strokeStyle = '#f39c12';
            ctx.lineWidth = 4;
            ctx.strokeRect(0, baseImage.height - bannerHeight, baseImage.width, bannerHeight);

            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 26px sans-serif';
            ctx.fillText(`⏱️ ${objectType}`, 20, baseImage.height - 48);

            ctx.fillStyle = '#f39c12';
            ctx.font = 'bold 22px sans-serif';
            ctx.fillText(`Unlocks in: ${m}m ${s}s`, 20, baseImage.height - 18);

            imageAttachment = new AttachmentBuilder(canvas.toBuffer('image/png'), { name: 'timer-annotated.png' });
        } catch (imgErr) {
            console.error('⚠️ ไม่สามารถสร้างรูปภาพแปะเวลาได้:', imgErr.message);
        }

        const embed = new EmbedBuilder()
            .setColor(0xf39c12)
            .setTitle(`⏱️ ตรวจพบเวลาถอยหลัง: ${objectType}`)
            .setDescription(`ตรวจพบเวลาถอยหลัง **${m} นาที ${s} วินาที**\n\n🎯 **เวลาเปิดโดยประมาณ:** <t:${unlockTimestamp}:F> (<t:${unlockTimestamp}:R>)`)
            .setFooter({ text: `บอทจะแจ้งเตือนนับถอยหลังทุกๆ 5 นาที (แจ้งเตือนที่ห้อง: #${alertChannel.name})` })
            .setTimestamp();

        if (imageAttachment) {
            embed.setImage('attachment://timer-annotated.png');
        }

        await statusMsg.edit({ 
            content: '✅ สแกนและสร้างภาพตัวจับเวลาเรียบร้อยแล้ว!', 
            embeds: [embed], 
            files: imageAttachment ? [imageAttachment] : [] 
        });
        sentMessages.push(statusMsg);

        const intervalMs = 5 * 60 * 1000;
        const timerInterval = setInterval(async () => {
            const remainingMs = unlockTimeMs - Date.now();
            const remainingMins = Math.ceil(remainingMs / 60000);

            if (remainingMs <= 0) {
                clearInterval(timerInterval);
                const alertMsg = await alertChannel.send(`🚨 **เตือนด่วน!** ${objectType} **ปลดล็อก/เปิดแล้วตอนนี้!** 🚨`);
                sentMessages.push(alertMsg);

                setTimeout(async () => {
                    for (const msg of sentMessages) {
                        try {
                            if (msg && typeof msg.delete === 'function') {
                                await msg.delete();
                            }
                        } catch (delErr) {
                            console.error('❌ ไม่สามารถลบข้อความอัตโนมัติได้:', delErr.message);
                        }
                    }
                }, 5 * 60 * 1000);

                return;
            }

            let alertMsg;
            if (remainingMins <= 5) {
                alertMsg = await alertChannel.send(`⚠️ **เตือนด่วน!** ${objectType} จะเปิดในอีก **${remainingMins} นาที** (<t:${unlockTimestamp}:R>)`);
            } else {
                alertMsg = await alertChannel.send(`⏳ **อัปเดตเวลา:** ${objectType} เหลือเวลาอีกประมาณ **${remainingMins} นาที** (<t:${unlockTimestamp}:R>)`);
            }
            if (alertMsg) sentMessages.push(alertMsg);

        }, intervalMs);

    } catch (err) {
        console.error('❌ OCR Error:', err);
        if (statusMsg) await statusMsg.edit(`❌ ไม่สามารถอ่านรูปภาพได้: \`${err.message}\``);
    }
}

const commands = [
    new SlashCommandBuilder().setName('check').setDescription('ระบบตรวจสอบสถิติและรายชื่อ')
        .addSubcommand(s => s.setName('battles').setDescription('เช็กสถิติไฟต์จาก Match ID หรือ ลิงก์').addStringOption(o => o.setName('link_or_id').setDescription('ลิงก์ AlbionBB หรือ Match ID').setRequired(true)))
        .addSubcommand(s => s.setName('guilds').setDescription('แสดงรายชื่อกิลด์ที่ติดตาม'))
        .addSubcommand(s => s.setName('members').setDescription('แสดงรายชื่อผู้เล่นที่ติดตาม')),
    new SlashCommandBuilder().setName('guild').setDescription('ดึงข้อมูลสถิติของกิลด์').addStringOption(o => o.setName('name').setDescription('ชื่อกิลด์').setRequired(true)),
    new SlashCommandBuilder().setName('mvp').setDescription('วิเคราะห์ MVP / Executioner / Feeder').addStringOption(o => o.setName('link_or_id').setDescription('ลิงก์ AlbionBB หรือ Match ID').setRequired(true)),
    new SlashCommandBuilder().setName('ราคา').setDescription('เช็กราคาไอเทมเซิร์ฟเวอร์ Asia')
        .addStringOption(o => o.setName('name').setDescription('ชื่อหรือ Item ID').setRequired(true))
        .addStringOption(o => o.setName('city').setDescription('เมือง').addChoices(
            { name: 'Black Market', value: 'BlackMarket' }, { name: 'Martlock', value: 'Martlock' }, { name: 'Bridgewatch', value: 'Bridgewatch' },
            { name: 'Caerleon', value: 'Caerleon' }, { name: 'Lymhurst', value: 'Lymhurst' }, { name: 'Fort Sterling', value: 'FortSterling' }, { name: 'Thetford', value: 'Thetford' }))
        .addIntegerOption(o => o.setName('tier').setDescription('Tier 1-8').addChoices(
            { name: 'Tier 1', value: 1 }, { name: 'Tier 2', value: 2 }, { name: 'Tier 3', value: 3 }, { name: 'Tier 4', value: 4 },
            { name: 'Tier 5', value: 5 }, { name: 'Tier 6', value: 6 }, { name: 'Tier 7', value: 7 }, { name: 'Tier 8', value: 8 }))
        .addIntegerOption(o => o.setName('enhancement').setDescription('Enhancement 0-4').addChoices(
            { name: '.0', value: 0 }, { name: '.1', value: 1 }, { name: '.2', value: 2 }, { name: '.3', value: 3 }, { name: '.4', value: 4 })),
    new SlashCommandBuilder().setName('add').setDescription('เพิ่มรายการติดตาม')
        .addSubcommand(s => s.setName('guild').setDescription('เพิ่มกิลด์').addStringOption(o => o.setName('name').setDescription('ชื่อกิลด์').setRequired(true)))
        .addSubcommand(s => s.setName('player').setDescription('เพิ่มผู้เล่น').addStringOption(o => o.setName('name').setDescription('ชื่อผู้เล่น').setRequired(true))),
    new SlashCommandBuilder().setName('remove').setDescription('ลบรายการติดตาม')
        .addSubcommand(s => s.setName('guild').setDescription('ลบกิลด์').addStringOption(o => o.setName('name').setDescription('ชื่อกิลด์').setRequired(true)))
        .addSubcommand(s => s.setName('player').setDescription('ลบผู้เล่น').addStringOption(o => o.setName('name').setDescription('ชื่อผู้เล่น').setRequired(true))),
    new SlashCommandBuilder().setName('autobattle').setDescription('ตั้งค่าระบบแจ้งเตือนไฟต์อัตโนมัติ')
        .addSubcommand(s => s.setName('config').setDescription('ตั้งค่าห้องแจ้งเตือน, Fame ขั้นต่ำ และการเปิดใช้งาน')
            .addChannelOption(o => o.setName('channel').setDescription('เลือกห้อง Discord ที่ต้องการให้แจ้งเตือน').addChannelTypes(ChannelType.GuildText))
            .addIntegerOption(o => o.setName('min_fame').setDescription('Fame ขั้นต่ำในการต่อสู้'))
            .addStringOption(o => o.setName('guild').setDescription('ชื่อกิลด์ที่ต้องการติดตาม'))
            .addBooleanOption(o => o.setName('enabled').setDescription('เปิด/ปิด ระบบแจ้งเตือน')))
        .addSubcommand(s => s.setName('status').setDescription('แสดงสถานะการตั้งค่าแจ้งเตือนไฟต์')),
    new SlashCommandBuilder().setName('timer').setDescription('ตั้งค่าระบบจับเวลาภาพอัตโนมัติ (Image OCR Timer)')
        .addSubcommand(s => s.setName('config').setDescription('กำหนดห้องสแกนรูปภาพและห้องแจ้งเตือนเวลา')
            .addChannelOption(o => o.setName('source_channel').setDescription('ห้องที่อนุญาตให้บอทสแกนรูป (เว้นว่าง = ทุกห้อง)').addChannelTypes(ChannelType.GuildText))
            .addChannelOption(o => o.setName('alert_channel').setDescription('ห้องที่ต้องการให้บอทส่งแจ้งเตือนนับถอยหลัง (เว้นว่าง = ห้องที่ส่งรูป)').addChannelTypes(ChannelType.GuildText))
            .addBooleanOption(o => o.setName('enabled').setDescription('เปิด (True) / ปิด (False) ระบบจับเวลาภาพ')))
        .addSubcommand(s => s.setName('status').setDescription('แสดงสถานะการตั้งค่าระบบจับเวลาภาพปัจจุบัน'))
].map(c => c.toJSON());

client.once('ready', async () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('✅ Slash commands registered.');
    } catch (err) { console.error('❌ Slash command registration error:', err); }

    setInterval(checkAutoBattles, 5 * 60 * 1000);
    setTimeout(checkAutoBattles, 10000);
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

    if (commandName === 'guild') {
        const name = interaction.options.getString('name');
        await interaction.deferReply();
        try {
            const search = await axios.get(`https://gameinfo.albiononline.com/api/gameinfo/search?q=${encodeURIComponent(name)}`, { timeout: 15000 });
            const guild = search.data.guilds?.find(g => String(g.Name).toLowerCase() === name.toLowerCase());
            if (!guild) return interaction.editReply(`❌ ไม่พบกิลด์ **${name}**`);
            const res = await axios.get(`https://gameinfo.albiononline.com/api/gameinfo/guilds/${guild.Id}`, { timeout: 15000 });
            const g = res.data;
            const embed = new EmbedBuilder().setColor(0xe74c3c).setTitle(`🛡️ Guild Info: ${g.Name}`).addFields(
                { name: '👑 Alliance', value: g.AllianceTag ? `[${g.AllianceTag}] ${g.AllianceName || ''}` : 'None', inline: true },
                { name: '👥 Members', value: String(g.memberCount || 0), inline: true },
                { name: '⚔️ Kill Fame', value: formatFame(g.killFame), inline: true },
                { name: '💀 Death Fame', value: formatFame(g.DeathFame), inline: true }
            ).setTimestamp();
            return interaction.editReply({ embeds: [embed] });
        } catch (err) { return interaction.editReply(`❌ เกิดข้อผิดพลาด: ${err.message}`); }
    }

    if (commandName === 'mvp') {
        await interaction.deferReply();
        try {
            const matchId = extractMatchId(interaction.options.getString('link_or_id'));
            const html = await fetchAlbionBBPage(matchId);
            if (!html) return interaction.editReply('❌ ไม่สามารถเข้าถึงข้อมูล AlbionBB ได้');
            const parsed = parseDataFromHTML(html);
            if (!parsed.players.length) return interaction.editReply('❌ ไม่พบสถิติผู้เล่นในไฟต์นี้');
            const mvp = [...parsed.players].sort((a, b) => (b.damage + b.healing) - (a.damage + a.healing))[0];
            const executioner = [...parsed.players].sort((a, b) => b.kills - a.kills)[0];
            const feeder = [...parsed.players].sort((a, b) => b.deaths - a.deaths)[0];
            const embed = new EmbedBuilder().setColor(0xf1c40f).setTitle(`🏆 Battle Awards - ${matchId}`).addFields(
                { name: '👑 MVP', value: `**${mvp.name}**\nDamage: ${formatFame(mvp.damage)} | Heal: ${formatFame(mvp.healing)}`, inline: false },
                { name: '🎯 Executioner', value: `**${executioner.name}**\nKills: ${executioner.kills} | Fame: ${formatFame(executioner.fame)}`, inline: true },
                { name: '💀 Feeder', value: `**${feeder.name}**\nDeaths: ${feeder.deaths}`, inline: true }
            ).setTimestamp();
            return interaction.editReply({ embeds: [embed] });
        } catch (err) { return interaction.editReply(`❌ เกิดข้อผิดพลาดในการวิเคราะห์ MVP: ${err.message}`); }
    }

    if (commandName === 'ราคา') {
        let rawName = interaction.options.getString('name').trim().toUpperCase();
        const city = interaction.options.getString('city') || 'BlackMarket';
        const tier = interaction.options.getInteger('tier');
        const enhancement = interaction.options.getInteger('enhancement');
        rawName = rawName.replace(/^(NOVICE'S|JOURNEYMAN'S|ADEPT'S|EXPERT'S|MASTER'S|GRANDMASTER'S|ELDER'S)\s+/i, '');
        const aliases = { 'SATCHEL OF INSIGHT': 'BAG_TALISMAN', SATCHEL: 'BAG_TALISMAN', 'MAIN SWORD': 'MAIN_SWORD', SWORD: 'MAIN_SWORD' };
        rawName = aliases[rawName] || rawName;
        let itemId = rawName.replace(/\s+/g, '_');
        if (tier && !/^T\d_/i.test(itemId)) itemId = `T${tier}_${itemId}`;
        if (enhancement !== null && enhancement !== undefined && enhancement > 0) itemId = `${itemId.split('@')[0]}@${enhancement}`;
        await interaction.deferReply();
        return checkMarketPrice(itemId, city, interaction);
    }

    if (commandName === 'add') {
        const sub = interaction.options.getSubcommand(), name = interaction.options.getString('name').trim();
        if (sub === 'guild') {
            if (targetGuilds.some(x => x.toLowerCase() === name.toLowerCase())) return interaction.reply({ content: `⚠️ กิลด์ **${name}** มีอยู่แล้ว`, ephemeral: true });
            targetGuilds.push(name); saveData(); return interaction.reply(`🛡️ เพิ่มกิลด์ **${name}** แล้ว`);
        }
        if (sub === 'player') {
            if (targetPlayers.some(x => x.toLowerCase() === name.toLowerCase())) return interaction.reply({ content: `⚠️ ผู้เล่น **${name}** มีอยู่แล้ว`, ephemeral: true });
            targetPlayers.push(name); saveData(); return interaction.reply(`✅ เพิ่มผู้เล่น **${name}** แล้ว`);
        }
    }

    if (commandName === 'remove') {
        const sub = interaction.options.getSubcommand(), name = interaction.options.getString('name').trim();
        if (sub === 'guild') {
            const before = targetGuilds.length; targetGuilds = targetGuilds.filter(x => x.toLowerCase() !== name.toLowerCase());
            if (before === targetGuilds.length) return interaction.reply({ content: `❌ ไม่พบกิลด์ **${name}**`, ephemeral: true });
            saveData(); return interaction.reply(`🗑️ ลบกิลด์ **${name}** แล้ว`);
        }
        if (sub === 'player') {
            const before = targetPlayers.length; targetPlayers = targetPlayers.filter(x => x.toLowerCase() !== name.toLowerCase());
            if (before === targetPlayers.length) return interaction.reply({ content: `❌ ไม่พบผู้เล่น **${name}**`, ephemeral: true });
            saveData(); return interaction.reply(`🗑️ ลบผู้เล่น **${name}** แล้ว`);
        }
    }

    if (commandName === 'autobattle') {
        const sub = interaction.options.getSubcommand();
        if (sub === 'config') {
            const channel = interaction.options.getChannel('channel');
            const minFame = interaction.options.getInteger('min_fame');
            const guild = interaction.options.getString('guild');
            const enabled = interaction.options.getBoolean('enabled');

            if (channel) autoBattleConfig.channelId = channel.id;
            if (minFame !== null) autoBattleConfig.minFame = minFame;
            if (enabled !== null) autoBattleConfig.enabled = enabled;
            if (guild) {
                if (!autoBattleConfig.guilds.some(g => g.toLowerCase() === guild.toLowerCase())) {
                    autoBattleConfig.guilds.push(guild);
                }
            }
            saveData();

            const statusText = autoBattleConfig.enabled ? '🟢 เปิดใช้งาน' : '🔴 ปิดใช้งาน';
            const channelMention = autoBattleConfig.channelId ? `<#${autoBattleConfig.channelId}>` : 'ยังไม่ได้ตั้งค่า';
            const embed = new EmbedBuilder().setColor(0x2ecc71).setTitle('⚙️ อัปเดต Auto Battle Notification')
                .addFields(
                    { name: '📌 สถานะ', value: statusText, inline: true },
                    { name: '📢 ห้องแจ้งเตือน', value: channelMention, inline: true },
                    { name: '🌟 Fame ขั้นต่ำ', value: `\`${formatFame(autoBattleConfig.minFame)}\``, inline: true }
                ).setTimestamp();
            return interaction.reply({ embeds: [embed] });
        }
        if (sub === 'status') {
            const statusText = autoBattleConfig.enabled ? '🟢 เปิดใช้งาน' : '🔴 ปิดใช้งาน';
            const channelMention = autoBattleConfig.channelId ? `<#${autoBattleConfig.channelId}>` : 'ยังไม่ได้ตั้งค่า';
            const embed = new EmbedBuilder().setColor(0x3498db).setTitle('📊 สถานะ Auto Battle Notification')
                .addFields(
                    { name: '📌 สถานะ', value: statusText, inline: true },
                    { name: '📢 ห้องแจ้งเตือน', value: channelMention, inline: true }
                ).setTimestamp();
            return interaction.reply({ embeds: [embed] });
        }
    }

    if (commandName === 'timer') {
        const sub = interaction.options.getSubcommand();
        if (sub === 'config') {
            const sourceChannel = interaction.options.getChannel('source_channel');
            const alertChannel = interaction.options.getChannel('alert_channel');
            const enabled = interaction.options.getBoolean('enabled');

            if (sourceChannel !== undefined) imageTimerConfig.sourceChannelId = sourceChannel ? sourceChannel.id : null;
            if (alertChannel !== undefined) imageTimerConfig.alertChannelId = alertChannel ? alertChannel.id : null;
            if (enabled !== null) imageTimerConfig.enabled = enabled;

            saveData();

            const statusText = imageTimerConfig.enabled ? '🟢 เปิดใช้งาน' : '🔴 ปิดใช้งาน';
            const sourceMention = imageTimerConfig.sourceChannelId ? `<#${imageTimerConfig.sourceChannelId}>` : 'ทุกห้อง (All Channels)';
            const alertMention = imageTimerConfig.alertChannelId ? `<#${imageTimerConfig.alertChannelId}>` : 'ห้องที่ส่งรูปมา (Same Channel)';

            const embed = new EmbedBuilder()
                .setColor(0xf39c12)
                .setTitle('⚙️ อัปเดตการตั้งค่า Image OCR Timer')
                .addFields(
                    { name: '📌 สถานะระบบ', value: statusText, inline: true },
                    { name: '📥 ห้องสแกนรูป (Source)', value: sourceMention, inline: false },
                    { name: '📢 ห้องแจ้งเตือน (Alert)', value: alertMention, inline: false }
                )
                .setTimestamp();

            return interaction.reply({ embeds: [embed] });
        }

        if (sub === 'status') {
            const statusText = imageTimerConfig.enabled ? '🟢 เปิดใช้งาน' : '🔴 ปิดใช้งาน';
            const sourceMention = imageTimerConfig.sourceChannelId ? `<#${imageTimerConfig.sourceChannelId}>` : 'ทุกห้อง (All Channels)';
            const alertMention = imageTimerConfig.alertChannelId ? `<#${imageTimerConfig.alertChannelId}>` : 'ห้องที่ส่งรูปมา (Same Channel)';

            const embed = new EmbedBuilder()
                .setColor(0x3498db)
                .setTitle('📊 สถานะระบบ Image OCR Timer')
                .addFields(
                    { name: '📌 สถานะระบบ', value: statusText, inline: true },
                    { name: '📥 ห้องสแกนรูป (Source)', value: sourceMention, inline: false },
                    { name: '📢 ห้องแจ้งเตือน (Alert)', value: alertMention, inline: false }
                )
                .setTimestamp();

            return interaction.reply({ embeds: [embed] });
        }
    }
});

client.on('messageCreate', async message => {
    if (message.author.bot) return;

    if (message.attachments.size > 0 && imageTimerConfig.enabled) {
        if (imageTimerConfig.sourceChannelId && message.channel.id !== imageTimerConfig.sourceChannelId) {
            return;
        }

        const attachment = message.attachments.first();
        if (attachment.contentType && attachment.contentType.startsWith('image/')) {
            await handleImageTimer(message, attachment.url);
            return;
        }
    }

    const match = message.content.match(/https?:\/\/east\.albionbb\.com\/battles\/[^\s]+/i);
    if (match) {
        try {
            const status = await message.reply('⏳ กำลังดึงสถิติจาก AlbionBB...');
            await processBattleReport(match[0], status, true);
        } catch (err) { console.error('❌ messageCreate error:', err); }
    }
});

client.on('error', err => console.error('❌ Discord client error:', err));
process.on('unhandledRejection', err => console.error('❌ Unhandled rejection:', err));
process.on('uncaughtException', err => console.error('❌ Uncaught exception:', err));

client.login(BOT_TOKEN);