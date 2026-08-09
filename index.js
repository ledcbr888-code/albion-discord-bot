const {
    Client,
    GatewayIntentBits,
    SlashCommandBuilder,
    REST,
    Routes,
    EmbedBuilder,
    AttachmentBuilder
} = require('discord.js');

const cloudscraper = require('cloudscraper');
const axios = require('axios');
const cheerio = require('cheerio');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const fs = require('fs');
const path = require('path');
const express = require('express');

// ============================================================
// CONFIG
// ============================================================
const app = express();
const PORT = Number(process.env.PORT) || 3000;
const BOT_TOKEN = String(process.env.BOT_TOKEN || '').trim();
const GUILD_ID = String(process.env.DISCORD_GUILD_ID || '').trim();
const DATA_FILE = path.join(__dirname, 'tracking.json');

app.get('/', (_, res) => res.status(200).send('BOSSBOT is online and running!'));
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Web server listening on port ${PORT}`);
});

if (!BOT_TOKEN) {
    console.error('❌ BOT_TOKEN is missing. Set it in Render Environment Variables.');
    process.exit(1);
}

// IMPORTANT:
// Only non-privileged intents are enabled here so the Gateway can connect
// even when Message Content / Server Members intents are not enabled in the
// Discord Developer Portal. Slash commands do not require either privileged intent.
// If automatic URL scanning in messageCreate is needed later, enable
// Message Content Intent in the Discord Developer Portal and add it back.
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages
    ],
    failIfNotExists: false
});

let targetPlayers = [];
let targetGuilds = [];

function loadData() {
    try {
        if (!fs.existsSync(DATA_FILE)) {
            saveData();
            return;
        }
        const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        targetPlayers = Array.isArray(data.players) ? data.players : [];
        targetGuilds = Array.isArray(data.guilds) ? data.guilds : [];
    } catch (err) {
        console.error('❌ tracking.json load error:', err.message);
        targetPlayers = [];
        targetGuilds = [];
    }
}

function saveData() {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify({ players: targetPlayers, guilds: targetGuilds }, null, 2), 'utf8');
    } catch (err) {
        console.error('❌ tracking.json save error:', err.message);
    }
}

loadData();

// ============================================================
// HELPERS
// ============================================================
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
        timeZone: 'Asia/Bangkok',
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit', hour12: false
    }).format(date);
    return `${formatted.replace(',', '')} +07`;
}

function normalizeAlbionItemId(raw) {
    if (!raw) return '';
    let value = '';
    if (typeof raw === 'object') {
        value = raw.itemId ?? raw.ItemId ?? raw.itemID ?? raw.ItemID ?? raw.type ?? raw.Type ??
            raw.id ?? raw.Id ?? raw.itemType ?? raw.ItemType ?? raw.uniqueName ?? raw.UniqueName ??
            raw.name ?? raw.Name ?? '';
    } else value = String(raw);
    value = String(value).trim();
    if (!value) return '';
    const match = value.match(/\/items\/([^/?#]+)/i) || value.match(/\/v1\/item\/([^/?#]+)/i);
    if (match) {
        try { value = decodeURIComponent(match[1]); } catch (_) {}
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

function extractMainHandFromObject(obj) {
    if (!obj || typeof obj !== 'object') return '';
    const candidates = [
        obj.MainHand, obj.mainHand, obj.MAINHAND, obj.mainhand, obj.Mainhand,
        obj.Equipment?.MainHand, obj.equipment?.MainHand, obj.Equipment?.mainHand, obj.equipment?.mainHand,
        obj.weapon, obj.Weapon, obj.weaponId, obj.WeaponId, obj.mainHandItem, obj.MainHandItem
    ];
    for (const candidate of candidates) {
        const id = normalizeAlbionItemId(candidate);
        if (id && isWeaponItemId(id)) return id;
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
        for (const raw of attrs) {
            const id = normalizeAlbionItemId(raw);
            if (!id || !isWeaponItemId(id)) continue;
            const context = [
                $el.attr('alt'), $el.attr('title'), $el.attr('class'), $el.attr('data-slot'),
                $el.attr('data-equipment-slot'), $el.parent().text(), $el.parent().attr('class')
            ].filter(Boolean).join(' ').toLowerCase();
            let score = 10 - Math.min(index, 20) * 0.1;
            if (/main[\s_-]?hand/.test(context)) score += 100;
            if (/weapon/.test(context)) score += 25;
            if (/off[\s_-]?hand|shield|torch|tome|book|orb|horn/.test(context)) score -= 100;
            candidates.push({ id, score });
            break;
        }
    });
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0]?.id || '';
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

// ============================================================
// ALBION DATA
// ============================================================
async function fetchAlbionBBPage(matchId) {
    const url = `https://east.albionbb.com/battles/${encodeURIComponent(matchId)}`;
    try {
        return await cloudscraper.get({
            url,
            timeout: 20000,
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

function objectToPlayer(obj) {
    if (!obj || typeof obj !== 'object') return null;
    const name = obj.name ?? obj.Name ?? obj.playerName ?? obj.PlayerName;
    if (!name || typeof name !== 'string') return null;
    const guild = obj.guildName ?? obj.GuildName ?? obj.guild ?? obj.Guild ?? '';
    return {
        name: String(name),
        guild: typeof guild === 'string' ? guild : '',
        kills: Number(obj.kills ?? obj.Kills ?? obj.kill ?? obj.Kill ?? 0) || 0,
        deaths: Number(obj.deaths ?? obj.Deaths ?? obj.death ?? obj.Death ?? 0) || 0,
        fame: parseFameValue(obj.killFame ?? obj.killfame ?? obj.fame ?? obj.Fame ?? obj.KillFame ?? 0),
        damage: parseFameValue(obj.damage ?? obj.Damage ?? obj.totalDamage ?? obj.TotalDamage ?? 0),
        healing: parseFameValue(obj.healing ?? obj.Healing ?? obj.totalHealing ?? obj.TotalHealing ?? 0),
        weapon: extractMainHandFromObject(obj)
    };
}

function parseDataFromHTML(html) {
    const $ = cheerio.load(html);
    const players = [];
    const battleTime = $('time[datetime]').attr('datetime') || $('time').first().text().trim() || $('.battle-time').first().text().trim() || null;

    $('table').each((_, table) => {
        const headers = [];
        $(table).find('thead tr').first().find('th,td').each((__, cell) => {
            headers.push($(cell).text().replace(/\s+/g, ' ').trim().toLowerCase());
        });
        if (!headers.length) return;
        const indexOf = (...names) => {
            for (const name of names) {
                const i = headers.indexOf(name);
                if (i !== -1) return i;
            }
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
            if (!name) return;
            const p = {
                name,
                guild: guildIndex >= 0 ? cells[guildIndex] : '',
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
    return { players, battleTime };
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
        for (const item of obj) {
            const found = findTimeInNextData(item);
            if (found) return found;
        }
        return null;
    }
    for (const [key, value] of Object.entries(obj)) {
        if (keys.includes(key) && value) return value;
        if (value && typeof value === 'object') {
            const found = findTimeInNextData(value);
            if (found) return found;
        }
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
        for (const child of Object.values(value)) walk(child);
    }
    walk(obj);
    return found;
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
        } catch (err) {
            console.log(`⚠️ Official API failed: ${err.message}`);
        }
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
            if (!old) {
                map.set(key, { ...p });
                continue;
            }
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
        const p = players[i];
        const y = padding + i * (cardHeight + gap);
        const cardX = padding;
        const cardWidth = width - padding * 2;
        ctx.fillStyle = '#a28c78';
        ctx.fillRect(cardX, y, cardWidth, cardHeight);

        const percent = Math.max(0, Math.min(100, Number(p.percent) || 0));
        const barWidth = cardWidth * percent / 100;
        if (barWidth > 0) {
            ctx.fillStyle = p.type === 'heal' ? '#21b293' : '#ff4d6d';
            ctx.fillRect(cardX, y, barWidth, cardHeight);
        }

        const weaponId = normalizeAlbionItemId(p.weapon);
        if (weaponId && isWeaponItemId(weaponId)) {
            try {
                const img = await loadImage(`https://render.albiononline.com/v1/item/${encodeURIComponent(weaponId)}.png`);
                ctx.drawImage(img, cardX + 12, y + 12, 60, 60);
            } catch (err) {
                console.error(`⚠️ Weapon image failed: ${weaponId}: ${err.message}`);
            }
        }

        let name = p.name;
        if (name.length > 25) name = `${name.slice(0, 22)}...`;
        ctx.fillStyle = '#000';
        ctx.font = 'bold 22px sans-serif';
        ctx.fillText(name, cardX + 88, y + 36);
        ctx.fillStyle = '#111';
        ctx.font = 'bold 16px sans-serif';
        ctx.fillText(`${p.type === 'heal' ? '💚 HEAL' : '⚔️ DMG'}  ${Number(p.value || 0).toLocaleString()}  (${percent}%)`, cardX + 88, y + 62);
    }
    return new AttachmentBuilder(canvas.toBuffer('image/png'), { name: 'top-performance.png' });
}

// ============================================================
// BATTLE REPORT
// ============================================================
async function processBattleReport(input, targetContext, isMessage = false) {
    try {
        const matchId = extractMatchId(input);
        const html = await fetchAlbionBBPage(matchId);
        let htmlData = { players: [], battleTime: null };
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
            if (!old) reportStats.set(key, {
                displayName: p.name, guild: p.guild || '', kills: Number(p.kills) || 0,
                deaths: Number(p.deaths) || 0, fame: Number(p.fame) || 0,
                damage: Number(p.damage) || 0, healing: Number(p.healing) || 0, weapon: p.weapon || ''
            });
            else {
                old.kills = Math.max(old.kills, p.kills);
                old.deaths = Math.max(old.deaths, p.deaths);
                old.fame = Math.max(old.fame, p.fame);
                old.damage = Math.max(old.damage, p.damage);
                old.healing = Math.max(old.healing, p.healing);
                if (!old.weapon && p.weapon) old.weapon = p.weapon;
                if (!old.guild && p.guild) old.guild = p.guild;
            }
        }

        const allSortedRows = [...reportStats.values()].sort((a, b) => b.fame - a.fame || b.kills - a.kills || b.damage - a.damage);
        const rows = allSortedRows.filter(p => {
            if (!targetGuilds.length && !targetPlayers.length) return true;
            const explicitPlayer = targetPlayers.some(x => x.trim().toLowerCase() === p.displayName.trim().toLowerCase());
            const guildMatch = p.guild && targetGuilds.some(x => x.trim().toLowerCase() === p.guild.trim().toLowerCase());
            return explicitPlayer || guildMatch;
        });

        const selected = rows.length ? rows : (targetGuilds.length || targetPlayers.length ? [] : allSortedRows);
        const totalKills = selected.reduce((n, p) => n + p.kills, 0);
        const totalDeaths = selected.reduce((n, p) => n + p.deaths, 0);
        const totalFame = selected.reduce((n, p) => n + p.fame, 0);

        const widths = { name: 20, kills: 8, deaths: 8, fame: 10 };
        const divider = '='.repeat(46);
        const subDivider = '-'.repeat(46);
        let report = '```ansi\n';
        report += `\x1b[1;36m⚔️ ALBIONBB BATTLE REPORT\x1b[0m | \x1b[1;33m🆔 ${matchId}\x1b[0m\n`;
        report += `\x1b[1;33m🕒 Time:\x1b[0m \x1b[1;37m${formatUTCTime(battleTime)}\x1b[0m\n`;
        report += `\x1b[30m${divider}\x1b[0m\n`;
        report += `\x1b[1;37m${'Name'.padEnd(widths.name)}${'Kills'.padStart(7)}${'Deaths'.padStart(8)}${'Fame'.padStart(10)}\x1b[0m\n`;
        report += `\x1b[30m${subDivider}\x1b[0m\n`;

        if (!selected.length) {
            report += '\x1b[30m(ไม่พบกิลด์หรือผู้เล่นที่ติดตามในไฟต์นี้)\x1b[0m\n';
        } else {
            for (const p of selected) {
                const name = p.displayName.slice(0, 19).padEnd(20);
                report += `\x1b[1;37m${name}\x1b[0m`;
                report += p.kills ? `\x1b[32m${String(p.kills).padStart(7)}\x1b[0m` : `\x1b[30m${String(p.kills).padStart(7)}\x1b[0m`;
                report += p.deaths ? `\x1b[31m${String(p.deaths).padStart(8)}\x1b[0m` : `\x1b[30m${String(p.deaths).padStart(8)}\x1b[0m`;
                report += p.fame ? `\x1b[33m${formatFame(p.fame).padStart(10)}\x1b[0m` : `\x1b[30m${'0'.padStart(10)}\x1b[0m`;
                report += '\n';
                if (report.length > 1850) {
                    report += `\x1b[30m... +${Math.max(0, selected.length - selected.indexOf(p) - 1)} more players\x1b[0m\n`;
                    break;
                }
            }
        }

        report += `\x1b[30m${subDivider}\x1b[0m\n`;
        report += `\x1b[1;37m${'TOTAL'.padEnd(20)}\x1b[32m${String(totalKills).padStart(7)}\x1b[31m${String(totalDeaths).padStart(8)}\x1b[33m${formatFame(totalFame).padStart(10)}\x1b[0m\n`;

        const awardCandidates = selected.length ? selected : allSortedRows;
        const mvp = awardCandidates[0] ? [...awardCandidates].sort((a, b) => (b.damage + b.healing) - (a.damage + a.healing))[0] : null;
        const executioner = awardCandidates[0] ? [...awardCandidates].sort((a, b) => b.kills - a.kills)[0] : null;
        const feeder = awardCandidates[0] ? [...awardCandidates].sort((a, b) => b.deaths - a.deaths)[0] : null;
        report += `\x1b[30m${subDivider}\x1b[0m\n\x1b[1;35m🏆 BATTLE AWARDS\x1b[0m\n`;
        if (mvp && (mvp.damage || mvp.healing)) report += `\x1b[1;33m👑 MVP        :\x1b[0m ${mvp.displayName} (${mvp.healing > mvp.damage ? `Heal: ${formatFame(mvp.healing)}` : `DMG: ${formatFame(mvp.damage)}`})\n`;
        if (executioner?.kills) report += `\x1b[1;32m🎯 Executioner :\x1b[0m ${executioner.displayName} (${executioner.kills} Kills)\n`;
        if (feeder?.deaths) report += `\x1b[1;31m💀 Feeder      :\x1b[0m ${feeder.displayName} (${feeder.deaths} Deaths)\n`;
        report += '```';

        const performancePlayers = selected.filter(p => p.damage > 0 || p.healing > 0).sort((a, b) => (b.damage + b.healing) - (a.damage + a.healing)).slice(0, 5);
        let imageAttachment = null;
        if (performancePlayers.length) {
            const maxDamage = Math.max(1, ...performancePlayers.map(p => p.damage));
            const maxHealing = Math.max(1, ...performancePlayers.map(p => p.healing));
            const top = performancePlayers.map(p => {
                const heal = p.healing > p.damage;
                const value = heal ? p.healing : p.damage;
                const max = heal ? maxHealing : maxDamage;
                return { name: p.displayName, weapon: p.weapon, value, percent: Math.round(value / max * 100), type: heal ? 'heal' : 'damage' };
            });
            imageAttachment = await generateTopPerformanceImage(top);
        }

        const payload = { content: report, files: imageAttachment ? [imageAttachment] : [] };
        if (isMessage) await targetContext.edit(payload);
        else await targetContext.editReply(payload);
    } catch (err) {
        console.error('❌ Process battle report error:', err);
        const msg = `❌ เกิดข้อผิดพลาดในการประมวลผลไฟต์: \`${err.message}\``;
        if (isMessage) await targetContext.edit(msg);
        else await targetContext.editReply(msg);
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
        const embed = new EmbedBuilder()
            .setColor(0x9b59b6)
            .setTitle(`🏷️ Price Check: ${city} (Asia Server)`)
            .setDescription(`**Item ID:** \`${itemId}\``)
            .setThumbnail(`https://render.albiononline.com/v1/item/${encoded}.png`)
            .addFields(
                { name: '💰 Buy Order สูงสุด', value: `\`${Number(price.buy_price_max || 0).toLocaleString()}\` Silver`, inline: true },
                { name: '🏷️ Sell Order ต่ำสุด', value: `\`${Number(price.sell_price_min || 0).toLocaleString()}\` Silver`, inline: true },
                { name: '📊 ยอดขายล่าสุด 24 ชม.', value: `\`${Number(volume).toLocaleString()}\` ชิ้น`, inline: false },
                { name: '🕒 อัปเดต Buy Order', value: price.buy_price_max_date ? formatUTCTime(price.buy_price_max_date) : 'N/A', inline: false }
            )
            .setFooter({ text: 'ข้อมูลจาก Albion Online Data Project' })
            .setTimestamp();
        await interaction.editReply({ embeds: [embed] });
    } catch (err) {
        console.error('❌ Price error:', err);
        await interaction.editReply(`❌ เกิดข้อผิดพลาดในการดึงราคา: \`${err.message}\``);
    }
}

// ============================================================
// SLASH COMMANDS
// ============================================================
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
        .addIntegerOption(o => o.setName('tier').setDescription('Tier 1-8').addChoices(...[1,2,3,4,5,6,7,8].map(v => ({ name: `Tier ${v}`, value: v }))))
        .addIntegerOption(o => o.setName('enhancement').setDescription('Enhancement 0-4').addChoices(...[0,1,2,3,4].map(v => ({ name: `.${v}`, value: v })))),
    new SlashCommandBuilder().setName('add').setDescription('เพิ่มรายการติดตาม')
        .addSubcommand(s => s.setName('guild').setDescription('เพิ่มกิลด์').addStringOption(o => o.setName('name').setDescription('ชื่อกิลด์').setRequired(true)))
        .addSubcommand(s => s.setName('player').setDescription('เพิ่มผู้เล่น').addStringOption(o => o.setName('name').setDescription('ชื่อผู้เล่น').setRequired(true))),
    new SlashCommandBuilder().setName('remove').setDescription('ลบรายการติดตาม')
        .addSubcommand(s => s.setName('guild').setDescription('ลบกิลด์').addStringOption(o => o.setName('name').setDescription('ชื่อกิลด์').setRequired(true)))
        .addSubcommand(s => s.setName('player').setDescription('ลบผู้เล่น').addStringOption(o => o.setName('name').setDescription('ชื่อผู้เล่น').setRequired(true)))
].map(c => c.toJSON());

// ============================================================
// READY / COMMAND REGISTRATION
// ============================================================
let commandsRegistered = false;

client.once('ready', async () => {
    console.log(`🟢 BOT ONLINE: ${client.user.tag}`);
    console.log(`🆔 Bot ID: ${client.user.id}`);
    console.log(`🏠 Servers: ${client.guilds.cache.size}`);

    if (commandsRegistered) return;
    commandsRegistered = true;

    try {
        if (GUILD_ID) {
            console.log(`📌 Registering slash commands to guild ${GUILD_ID}...`);
            await client.application.commands.set(commands, GUILD_ID);
            console.log('✅ Guild slash commands registered.');
        } else {
            console.log('🌐 DISCORD_GUILD_ID not set; registering global slash commands once...');
            await client.application.commands.set(commands);
            console.log('✅ Global slash commands registered.');
        }
    } catch (err) {
        commandsRegistered = false;
        console.error('❌ Slash command registration failed:', err.message);
        console.error('ℹ️ Bot will stay online. Try again after Discord rate limit clears.');
    }
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    const { commandName } = interaction;

    try {
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
        }

        if (commandName === 'mvp') {
            await interaction.deferReply();
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

        if (commandName === 'add' || commandName === 'remove') {
            const sub = interaction.options.getSubcommand();
            const name = interaction.options.getString('name').trim();
            const isAdd = commandName === 'add';
            const list = sub === 'guild' ? targetGuilds : targetPlayers;
            const exists = list.some(x => x.toLowerCase() === name.toLowerCase());
            if (isAdd) {
                if (exists) return interaction.reply({ content: `⚠️ ${sub === 'guild' ? 'กิลด์' : 'ผู้เล่น'} **${name}** มีอยู่แล้ว`, ephemeral: true });
                list.push(name);
                saveData();
                return interaction.reply(`${sub === 'guild' ? '🛡️ เพิ่มกิลด์' : '✅ เพิ่มผู้เล่น'} **${name}** แล้ว`);
            }
            if (!exists) return interaction.reply({ content: `❌ ไม่พบ${sub === 'guild' ? 'กิลด์' : 'ผู้เล่น'} **${name}**`, ephemeral: true });
            if (sub === 'guild') targetGuilds = targetGuilds.filter(x => x.toLowerCase() !== name.toLowerCase());
            else targetPlayers = targetPlayers.filter(x => x.toLowerCase() !== name.toLowerCase());
            saveData();
            return interaction.reply(`🗑️ ลบ${sub === 'guild' ? 'กิลด์' : 'ผู้เล่น'} **${name}** แล้ว`);
        }
    } catch (err) {
        console.error('❌ Interaction error:', err);
        const text = `❌ เกิดข้อผิดพลาด: \`${err.message}\``;
        if (interaction.deferred || interaction.replied) await interaction.editReply(text).catch(() => {});
        else await interaction.reply({ content: text, ephemeral: true }).catch(() => {});
    }
});

// Automatic URL scanning requires Message Content Intent. It is intentionally
// disabled for now so the bot can connect without privileged intents.
// Use /check battles with an AlbionBB URL or Match ID instead.

client.on('error', err => console.error('❌ Discord client error:', err));
client.on('warn', info => console.warn('⚠️ Discord warning:', info));
client.on('shardError', error => console.error('❌ Gateway shard error:', error));
client.on('shardDisconnect', (event, shardId) => console.error(`❌ Gateway shard ${shardId} disconnected:`, event?.code, event?.reason || 'no reason'));
client.on('shardReconnecting', shardId => console.log(`🔄 Gateway shard ${shardId} reconnecting...`));
client.on('shardReady', (id, unavailableGuilds) => console.log(`🟢 Gateway shard ${id} READY. Unavailable guilds: ${unavailableGuilds?.size ?? 0}`));
process.on('unhandledRejection', err => console.error('❌ Unhandled rejection:', err));
process.on('uncaughtException', err => console.error('❌ Uncaught exception:', err));

// ============================================================
// LOGIN
// ============================================================
console.log('🔄 Attempting to login to Discord...');
console.log(`🔑 BOT_TOKEN loaded: ${BOT_TOKEN ? 'YES' : 'NO'}`);
console.log(`🔑 BOT_TOKEN length: ${BOT_TOKEN.length}`);
console.log(`📌 DISCORD_GUILD_ID: ${GUILD_ID ? GUILD_ID : 'not set (global commands)'}`);
console.log('🛡️ Gateway intents: Guilds=ON, GuildMessages=ON, MessageContent=OFF, GuildMembers=OFF');
console.log('🌐 Starting Discord Gateway login (non-privileged intents only)...');

client.login(BOT_TOKEN).then(() => {
    console.log('🌐 Discord Gateway login request accepted. Waiting for READY...');
}).catch(error => {
    console.error('❌ Discord login failed!');
    console.error('Error name:', error?.name || 'Unknown');
    console.error('Error message:', error?.message || String(error));
    console.error(error);
});