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
let targetKillTrackers = []; 
let targetDeathTrackers = []; 
let autoBattleConfigs = []; 
let processedBattles = new Set();
let processedEvents = new Set(); // ป้องกันการแจ้งเตือนเหตุการณ์ซ้ำ
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
        targetKillTrackers = Array.isArray(data.killTrackers) ? data.killTrackers : [];
        targetDeathTrackers = Array.isArray(data.deathTrackers) ? data.deathTrackers : [];
        autoBattleConfigs = Array.isArray(data.autoBattles) ? data.autoBattles : [];
        console.log(`📁 Tracking: ${targetGuilds.length} guilds, ${targetPlayers.length} players, ${targetKillTrackers.length} kill trackers, ${targetDeathTrackers.length} death trackers, ${autoBattleConfigs.length} auto-battle configs`);
    } catch (err) {
        console.error('❌ tracking.json load error:', err.message);
        targetPlayers = [];
        targetGuilds = [];
        targetKillTrackers = [];
        targetDeathTrackers = [];
        autoBattleConfigs = [];
    }
}

function saveData() {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify({
            players: targetPlayers,
            guilds: targetGuilds,
            killTrackers: targetKillTrackers,
            deathTrackers: targetDeathTrackers,
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

function getApiUrls(matchId) {
    return [
        `https://gameinfo.albiononline.com/api/gameinfo/battles/${encodeURIComponent(matchId)}`,
        `https://gameinfo-sgp.albiononline.com/api/gameinfo/battles/${encodeURIComponent(matchId)}`
    ];
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

function getApiPlayers(apiData) {
    if (!apiData?.players) return [];
    const list = Array.isArray(apiData.players) ? apiData.players : Object.values(apiData.players);
    return list.map(objectToPlayer).filter(Boolean);
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

async function buildBattleReportPayload(matchId, customTargetGuilds = []) {
    const apiData = /^\d+$/.test(matchId) ? await fetchOfficialBattle(matchId) : null;
    if (!apiData) throw new Error('ไม่พบข้อมูลไฟต์จาก Official Albion API');

    const battleTime = apiData.startTime || apiData.timestamp || null;

    const knownGuildNames = new Set([
        ...(apiData?.guilds ? Object.values(apiData.guilds).map(g => g.name?.trim().toLowerCase()).filter(Boolean) : []),
        ...(apiData?.alliances ? Object.values(apiData.alliances).map(a => a.name?.trim().toLowerCase()).filter(Boolean) : [])
    ]);

    let rawPlayers = getApiPlayers(apiData);
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

    const guildNamesList = customTargetGuilds.map(g => typeof g === 'string' ? g : g.name);

    const rows = allSortedRows.filter(p => {
        if (guildNamesList.length === 0 && targetPlayers.length === 0) return true;
        const isExplicitPlayer = targetPlayers.some(pl => pl.trim().toLowerCase() === p.displayName.trim().toLowerCase());
        const isGuildMatch = p.guild && guildNamesList.some(g => p.guild.trim().toLowerCase().includes(g.trim().toLowerCase()) || g.trim().toLowerCase().includes(p.guild.trim().toLowerCase()));
        return isGuildMatch || isExplicitPlayer || guildNamesList.length === 0;
    });

    let totalKills = 0, totalDeaths = 0, totalFame = 0;
    let guildTotalFrames = 0;
    const targetRowsToCalc = rows.length > 0 ? rows : allSortedRows;
    
    for (const p of targetRowsToCalc) {
        totalKills += p.kills;
        totalDeaths += p.deaths;
        totalFame += p.fame;

        if (guildNamesList.length > 0 && p.guild) {
            const isGuildMatch = guildNamesList.some(g => p.guild.trim().toLowerCase().includes(g.trim().toLowerCase()) || g.trim().toLowerCase().includes(p.guild.trim().toLowerCase()));
            if (isGuildMatch) {
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

    const battleUrl = `https://east.albionbb.com/battles/${matchId}`;
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
        guildTotalFrames,
        battleUrl,
        payload: { content: report, files: attachments }
    };
}

async function processBattleReport(input, targetContext, isMessage = false) {
    try {
        const matchId = extractMatchId(input);
        const { payload } = await buildBattleReportPayload(matchId, targetGuilds);
        if (isMessage) await targetContext.edit(payload); else await targetContext.editReply(payload);
    } catch (err) {
        console.error('❌ Process battle report error:', err);
        const message = `❌ เกิดข้อผิดพลาดในการประมวลผลไฟต์: \`${err.message}\``;
        if (isMessage) await targetContext.edit(message); else await targetContext.editReply(message);
    }
}

async function fetchGuildRecentBattles(guildName) {
    try {
        const searchUrl = `https://east.albionbb.com/search?q=${encodeURIComponent(guildName)}`;
        const searchRes = await cloudscraper.get(searchUrl).catch(() => null);
        if (!searchRes) return [];
        
        let guildPageUrl = '';
        if (searchRes.includes(`/guilds/`)) {
            const $ = cheerio.load(searchRes);
            const link = $(`a[href*="/guilds/"]`).attr('href');
            if (link) guildPageUrl = `https://east.albionbb.com${link}/battles`;
        }

        if (!guildPageUrl) return [];

        const html = await cloudscraper.get(guildPageUrl).catch(() => null);
        if (!html) return [];

        const $ = cheerio.load(html);
        const matchIds = [];
        $('a[href*="/battles/"]').each((_, el) => {
            const href = $(el).attr('href');
            const match = href ? href.match(/\/battles\/(\d+)/) : null;
            if (match && match[1]) {
                matchIds.push(match[1]);
            }
        });

        return [...new Set(matchIds)].slice(0, 10);
    } catch (err) {
        console.warn(`⚠️ Fetch guild battles error for ${guildName}:`, err.message);
        return [];
    }
}

async function fetchRecentEvents() {
    try {
        const searchUrl = 'https://east.albionbb.com/api/events?limit=50';
        const res = await cloudscraper.get(searchUrl, { json: true }).catch(() => null);
        if (res && Array.isArray(res)) return res;
    } catch (err) {
        console.warn('⚠️ Fetch AlbionBB events error:', err.message);
    }

    try {
        const url = 'https://gameinfo-sgp.albiononline.com/api/gameinfo/events?limit=50&offset=0';
        const res = await axios.get(url, { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (Array.isArray(res.data)) return res.data;
    } catch (_) {}

    return [];
}

async function checkKillDeathTrackers() {
    if (!targetKillTrackers.length && !targetDeathTrackers.length) return;
    
    const events = await fetchRecentEvents();
    if (!events.length) return;

    for (const ev of events) {
        const eventId = String(ev.EventId || ev.id || ev._id || '');
        if (!eventId || processedEvents.has(eventId)) continue;

        const killer = ev.Killer || ev.killer || {};
        const victim = ev.Victim || ev.victim || {};

        const killerName = String(killer.Name || killer.name || '').trim();
        const killerGuild = String(killer.GuildName || killer.guildName || killer.guild || '').trim();
        const victimName = String(victim.Name || victim.name || '').trim();
        const victimGuild = String(victim.GuildName || victim.guildName || victim.guild || '').trim();
        const totalFame = Number(ev.TotalKillFame || ev.totalKillFame || ev.fame || 0);
        const eventTime = new Date(ev.TimeStamp || ev.timeStamp || Date.now());

        // 1. ตรวจสอบ Kill Trackers
        for (const tracker of targetKillTrackers) {
            let isMatch = false;
            if (tracker.type === 'player') {
                isMatch = killerName.toLowerCase() === tracker.name.toLowerCase();
            } else if (tracker.type === 'guild') {
                isMatch = killerGuild.toLowerCase() === tracker.name.toLowerCase();
            }

            if (isMatch) {
                const channel = await client.channels.fetch(tracker.channelId).catch(() => null);
                if (channel) {
                    const embed = new EmbedBuilder()
                        .setColor(0x2ecc71)
                        .setTitle(`🎯 Kill Alert: ${killerName} (${killerGuild || 'No Guild'})`)
                        .setDescription(`⚔️ สังหาร **${victimName}** (${victimGuild || 'No Guild'})\n💰 Kill Fame: \`${totalFame.toLocaleString()}\``)
                        .setTimestamp(eventTime);
                    await channel.send({ embeds: [embed] }).catch(() => {});
                }
            }
        }

        // 2. ตรวจสอบ Death Trackers (อัปเดตสไตล์การ์ด/รายงานตามต้องการ)
        for (const tracker of targetDeathTrackers) {
            let isMatch = false;
            if (tracker.type === 'player') {
                isMatch = victimName.toLowerCase() === tracker.name.toLowerCase();
            } else if (tracker.type === 'guild') {
                isMatch = victimGuild.toLowerCase() === tracker.name.toLowerCase();
            }

            if (isMatch) {
                const channel = await client.channels.fetch(tracker.channelId).catch(() => null);
                if (channel) {
                    const embed = new EmbedBuilder()
                        .setColor(0xe74c3c)
                        .setTitle(`💀 Death Alert: ${victimName} (${victimGuild || 'No Guild'})`)
                        .addFields(
                            { name: '⚔️ ถูกสังหารโดย', value: `**${killerName}** (${killerGuild || 'No Guild'})`, inline: false },
                            { name: '💰 Lost Fame', value: `\`${totalFame.toLocaleString()}\``, inline: true },
                            { name: '🕒 เวลา', value: `<t:${Math.floor(eventTime.getTime() / 1000)}:R>`, inline: true }
                        )
                        .setTimestamp(eventTime);
                    
                    await channel.send({ embeds: [embed] }).catch(() => {});
                }
            }
        }

        processedEvents.add(eventId);
        if (processedEvents.size > 300) {
            const arr = [...processedEvents];
            processedEvents = new Set(arr.slice(150));
        }
    }
}

async function checkAutoBattles() {
    const guildsToCheck = new Map();
    
    autoBattleConfigs.forEach(c => {
        if (c.targetGuild) {
            guildsToCheck.set(c.targetGuild.toLowerCase(), {
                name: c.targetGuild,
                channelId: c.channelId,
                minFrames: c.minFrames || 0
            });
        }
    });

    targetGuilds.forEach(g => {
        if (g.name && !guildsToCheck.has(g.name.toLowerCase())) {
            guildsToCheck.set(g.name.toLowerCase(), {
                name: g.name,
                channelId: g.channelId,
                minFrames: 0 
            });
        }
    });

    targetKillTrackers.forEach(t => {
        if (t.type === 'guild' && t.name && !guildsToCheck.has(t.name.toLowerCase())) {
            guildsToCheck.set(t.name.toLowerCase(), { name: t.name, channelId: t.channelId, minFrames: 0 });
        }
    });
    targetDeathTrackers.forEach(t => {
        if (t.type === 'guild' && t.name && !guildsToCheck.has(t.name.toLowerCase())) {
            guildsToCheck.set(t.name.toLowerCase(), { name: t.name, channelId: t.channelId, minFrames: 0 });
        }
    });

    await checkKillDeathTrackers();

    if (guildsToCheck.size === 0) return;
    if (autoBattleCheckRunning) return;

    autoBattleCheckRunning = true;
    try {
        for (const [_, config] of guildsToCheck) {
            const recentMatches = await fetchGuildRecentBattles(config.name);

            for (const matchId of recentMatches) {
                if (processedBattles.has(matchId)) continue;
                
                try {
                    const result = await buildBattleReportPayload(matchId, [config.name]);
                    if (config.minFrames > 0 && result.guildTotalFrames < config.minFrames) {
                        processedBattles.add(matchId);
                        continue;
                    }

                    let targetChannelId = config.channelId;
                    if (!targetChannelId) {
                        for (const [, guild] of client.guilds.cache) {
                            const defaultChannel = guild.channels.cache.find(c => c.type === ChannelType.GuildText && c.permissionsFor(guild.members.me)?.has('SendMessages'));
                            if (defaultChannel) {
                                targetChannelId = defaultChannel.id;
                                break;
                            }
                        }
                    }

                    if (targetChannelId) {
                        const channel = await client.channels.fetch(targetChannelId).catch(() => null);
                        if (channel) {
                            await channel.send(`🚨 **Auto-Battle Alert!** ตรวจพบไฟต์ของกิลด์ **${config.name}**\n⚔️ รวม Kills + Deaths: \`${result.guildTotalFrames.toLocaleString()}\` เฟรม\n🔗 Link: <${result.battleUrl}>`);
                            await channel.send(result.payload);
                        }
                    }
                } catch (e) {}

                processedBattles.add(matchId);
                if (processedBattles.size > 300) {
                    const arr = [...processedBattles];
                    processedBattles = new Set(arr.slice(150));
                }
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
    
    new SlashCommandBuilder().setName('kill').setDescription('จัดการระบบติดตามการฆ่า (Kill Tracker)')
        .addSubcommand(s => s.setName('set').setDescription('ตั้งค่าติดตามการฆ่าของผู้เล่นหรือกิลด์ พร้อมเลือกห้องแจ้งเตือน')
            .addStringOption(o => o.setName('type').setDescription('ประเภทการติดตาม').setRequired(true).addChoices({ name: 'Player', value: 'player' }, { name: 'Guild', value: 'guild' }))
            .addStringOption(o => o.setName('name').setDescription('ชื่อผู้เล่นหรือชื่อ Guild ที่ต้องการติดตาม').setRequired(true))
            .addChannelOption(o => o.setName('channel').setDescription('ห้อง Discord ที่ต้องการให้ส่งรายงานแจ้งเตือน').addChannelTypes(ChannelType.GuildText).setRequired(true)))
        .addSubcommand(s => s.setName('list').setDescription('แสดงรายชื่อผู้เล่นและกิลด์ที่ตั้งค่า Kill Tracker ไว้'))
        .addSubcommand(s => s.setName('remove').setDescription('ลบการติดตามการฆ่าออก')
            .addStringOption(o => o.setName('type').setDescription('ประเภทการติดตาม').setRequired(true).addChoices({ name: 'Player', value: 'player' }, { name: 'Guild', value: 'guild' }))
            .addStringOption(o => o.setName('name').setDescription('ชื่อผู้เล่นหรือชื่อ Guild ที่ต้องการลบออก').setRequired(true))),

    new SlashCommandBuilder().setName('death').setDescription('จัดการระบบติดตามการตาย (Death Tracker)')
        .addSubcommand(s => s.setName('set').setDescription('ตั้งค่าติดตามการตายของผู้เล่นหรือกิลด์ พร้อมเลือกห้องแจ้งเตือน')
            .addStringOption(o => o.setName('type').setDescription('ประเภทการติดตาม').setRequired(true).addChoices({ name: 'Player', value: 'player' }, { name: 'Guild', value: 'guild' }))
            .addStringOption(o => o.setName('name').setDescription('ชื่อผู้เล่นหรือชื่อ Guild ที่ต้องการติดตาม').setRequired(true))
            .addChannelOption(o => o.setName('channel').setDescription('ห้อง Discord ที่ต้องการให้ส่งรายงานแจ้งเตือน').addChannelTypes(ChannelType.GuildText).setRequired(true)))
        .addSubcommand(s => s.setName('list').setDescription('แสดงรายชื่อผู้เล่นและกิลด์ที่ตั้งค่า Death Tracker ไว้'))
        .addSubcommand(s => s.setName('remove').setDescription('ลบการติดตามการตายออก')
            .addStringOption(o => o.setName('type').setDescription('ประเภทการติดตาม').setRequired(true).addChoices({ name: 'Player', value: 'player' }, { name: 'Guild', value: 'guild' }))
            .addStringOption(o => o.setName('name').setDescription('ชื่อผู้เล่นหรือชื่อ Guild ที่ต้องการลบออก').setRequired(true))),

    new SlashCommandBuilder().setName('autobattle').setDescription('จัดการระบบติดตามไฟต์อัตโนมัติ')
        .addSubcommand(s => s.setName('set').setDescription('ตั้งค่าระบบติดตามไฟต์อัตโนมัติ')
            .addChannelOption(o => o.setName('channel').setDescription('ห้องที่ต้องการให้แจ้งเตือน').addChannelTypes(ChannelType.GuildText).setRequired(true))
            .addStringOption(o => o.setName('guild').setDescription('ชื่อ Guild ที่ต้องการติดตาม').setRequired(true))
            .addStringOption(o => o.setName('min_frames').setDescription('จำนวนเฟรมขั้นต่ำ (Kills + Deaths) เช่น 300K, 1M').setRequired(true)))
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

    setTimeout(checkAutoBattles, 10000);
    setInterval(checkAutoBattles, 60 * 1000);
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

    if (commandName === 'kill') {
        const sub = interaction.options.getSubcommand();

        if (sub === 'set') {
            const type = interaction.options.getString('type');
            const name = interaction.options.getString('name').trim();
            const channel = interaction.options.getChannel('channel');

            const existing = targetKillTrackers.find(t => t.type === type && t.name.toLowerCase() === name.toLowerCase() && t.guildId === interaction.guildId);
            if (existing) {
                existing.channelId = channel.id;
                saveData();
                return interaction.reply(`🎯 อัปเดตห้องแจ้งเตือน Kill Tracker ของ **${name}** (${type.toUpperCase()}) เป็น <#${channel.id}> เรียบร้อย!`);
            }

            targetKillTrackers.push({ type, name, channelId: channel.id, guildId: interaction.guildId });
            saveData();
            return interaction.reply(`🎯 ตั้งค่าติดตามการฆ่า (**${type.toUpperCase()}**) ของ **${name}** สำเร็จ! ห้องแจ้งเตือน: <#${channel.id}>`);
        }

        if (sub === 'list') {
            const serverTrackers = targetKillTrackers.filter(t => t.guildId === interaction.guildId);
            if (!serverTrackers.length) return interaction.reply({ content: '🎯 เซิร์ฟเวอร์นี้ยังไม่มีการตั้งค่า Kill Tracker ใดๆ', flags: 64 });

            const listText = serverTrackers.map((t, i) => `${i + 1}. [**${t.type.toUpperCase()}**] **${t.name}** | ห้อง: <#${t.channelId}>`).join('\n');
            const embed = new EmbedBuilder()
                .setColor(0x2ecc71)
                .setTitle(`🎯 รายชื่อ Kill Trackers ในเซิร์ฟเวอร์นี้ (${serverTrackers.length})`)
                .setDescription(listText)
                .setTimestamp();
            return interaction.reply({ embeds: [embed] });
        }

        if (sub === 'remove') {
            const type = interaction.options.getString('type');
            const name = interaction.options.getString('name').trim();

            const beforeCount = targetKillTrackers.length;
            targetKillTrackers = targetKillTrackers.filter(t => !(t.guildId === interaction.guildId && t.type === type && t.name.toLowerCase() === name.toLowerCase()));

            if (beforeCount === targetKillTrackers.length) {
                return interaction.reply({ content: `❌ ไม่พบ **${name}** (${type.toUpperCase()}) ในระบบ Kill Tracker ของเซิร์ฟเวอร์นี้`, flags: 64 });
            }

            saveData();
            return interaction.reply(`🗑️ ลบการติดตามการฆ่าของ **${name}** (${type.toUpperCase()}) ออกเรียบร้อยแล้ว`);
        }
    }

    if (commandName === 'death') {
        const sub = interaction.options.getSubcommand();

        if (sub === 'set') {
            const type = interaction.options.getString('type');
            const name = interaction.options.getString('name').trim();
            const channel = interaction.options.getChannel('channel');

            const existing = targetDeathTrackers.find(t => t.type === type && t.name.toLowerCase() === name.toLowerCase() && t.guildId === interaction.guildId);
            if (existing) {
                existing.channelId = channel.id;
                saveData();
                return interaction.reply(`💀 อัปเดตห้องแจ้งเตือน Death Tracker ของ **${name}** (${type.toUpperCase()}) เป็น <#${channel.id}> เรียบร้อย!`);
            }

            targetDeathTrackers.push({ type, name, channelId: channel.id, guildId: interaction.guildId });
            saveData();
            return interaction.reply(`💀 ตั้งค่าติดตามการตาย (**${type.toUpperCase()}**) ของ **${name}** สำเร็จ! ห้องแจ้งเตือน: <#${channel.id}>`);
        }

        if (sub === 'list') {
            const serverTrackers = targetDeathTrackers.filter(t => t.guildId === interaction.guildId);
            if (!serverTrackers.length) return interaction.reply({ content: '💀 เซิร์ฟเวอร์นี้ยังไม่มีการตั้งค่า Death Tracker ใดๆ', flags: 64 });

            const correctedListText = serverTrackers.map((t, i) => `${i + 1}. [**${t.type.toUpperCase()}**] **${t.name}** | ห้อง: <#${t.channelId}>`).join('\n');
            
            const embed = new EmbedBuilder()
                .setColor(0xe74c3c)
                .setTitle(`💀 รายชื่อ Death Trackers ในเซิร์ฟเวอร์นี้ (${serverTrackers.length})`)
                .setDescription(correctedListText)
                .setTimestamp();
            return interaction.reply({ embeds: [embed] });
        }

        if (sub === 'remove') {
            const type = interaction.options.getString('type');
            const name = interaction.options.getString('name').trim();

            const beforeCount = targetDeathTrackers.length;
            targetDeathTrackers = targetDeathTrackers.filter(t => !(t.guildId === interaction.guildId && t.type === type && t.name.toLowerCase() === name.toLowerCase()));

            if (beforeCount === targetDeathTrackers.length) {
                return interaction.reply({ content: `❌ ไม่พบ **${name}** (${type.toUpperCase()}) ในระบบ Death Tracker ของเซิร์ฟเวอร์นี้`, flags: 64 });
            }

            saveData();
            return interaction.reply(`🗑️ ลบการติดตามการตายของ **${name}** (${type.toUpperCase()}) ออกเรียบร้อยแล้ว`);
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

            return interaction.editReply(`✅ ตั้งค่า **Auto-Battle Tracker** สำเร็จเรียบร้อย!\n- 📢 ห้องแจ้งเตือน: <#${channel.id}>\n- 🛡️ กิลด์ที่ติดตาม: **${guildName}**\n- ⚔️ ขั้นต่ำ Frames: **${minFrames.toLocaleString()}**`);
        }

        if (sub === 'list') {
            const serverConfigs = autoBattleConfigs.filter(c => c.guildId === interaction.guildId);
            if (!serverConfigs.length) return interaction.reply({ content: '🛡️ เซิร์ฟเวอร์นี้ยังไม่มีการตั้งค่า Auto-Battle สำหรับกิลด์ใดๆ', flags: 64 });

            let listText = serverConfigs.map((c, i) => `${i + 1}. กิลด์: **${c.targetGuild}** | ห้อง: <#${c.channelId}> | ขั้นต่ำ Frames: **${(c.minFrames || 0).toLocaleString()}**`).join('\n');
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
    if (targetGuilds.some(g => g.channelId) && !matchingGuildConfig) return; 

    try {
        const status = await message.reply('⏳ กำลังดึงสถิติจาก Official Albion API...');
        await processBattleReport(match[0], status, true);
    } catch (err) { console.error('❌ messageCreate error:', err); }
});

client.on('error', err => console.error('❌ Discord client error:', err));
process.on('unhandledRejection', err => console.error('❌ Unhandled rejection:', err));
process.on('uncaughtException', err => console.error('❌ Uncaught exception:', err));

client.login(BOT_TOKEN);