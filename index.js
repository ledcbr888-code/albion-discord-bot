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

// ======================================================
// 1. WEB SERVER FOR KEEP-ALIVE (RENDER)
// ======================================================
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('Bot is running online 24/7!');
});

app.listen(PORT, () => {
    console.log(`🌐 Keep-alive server is running on port ${PORT}`);
});

// ======================================================
// 2. CONFIG & TRACKING LISTS (WITH PERSISTENT STORAGE)
// ======================================================
const BOT_TOKEN = (process.env.BOT_TOKEN || '').trim();
const OWNER_ID = (process.env.OWNER_ID || '').trim();

if (!BOT_TOKEN) {
    console.error('❌ ไม่พบ BOT_TOKEN กรุณาตั้งค่า Environment Variable ให้ถูกต้อง');
    process.exit(1);
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ]
});

const DATA_FILE = path.join(__dirname, 'tracking.json');
let targetPlayers = [];
let targetGuilds = [];

function loadData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const rawData = fs.readFileSync(DATA_FILE, 'utf8');
            const data = JSON.parse(rawData);
            targetPlayers = data.players || [];
            targetGuilds = data.guilds || [];
            console.log(`📁 โหลดข้อมูลสำเร็จ: พบ ${targetGuilds.length} กิลด์ และ ${targetPlayers.length} ผู้เล่น`);
        } else {
            console.log('📁 ไม่พบไฟล์ tracking.json กำลังสร้างไฟล์ใหม่...');
            saveData();
        }
    } catch (error) {
        console.error('❌ เกิดข้อผิดพลาดในการโหลดข้อมูล:', error.message);
    }
}

function saveData() {
    try {
        const data = {
            players: targetPlayers,
            guilds: targetGuilds
        };
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
        console.log('💾 บันทึกข้อมูลเรียบร้อยแล้ว!');
    } catch (error) {
        console.error('❌ เกิดข้อผิดพลาดในการบันทึกข้อมูล:', error.message);
    }
}

loadData();

// ======================================================
// 3. HELPER FUNCTIONS
// ======================================================

function parseFameValue(val) {
    if (val === null || val === undefined) return 0;
    if (typeof val === 'number') return val;

    let str = String(val).trim().toLowerCase();
    if (!str) return 0;

    let multiplier = 1;

    if (str.endsWith('b')) {
        multiplier = 1000000000;
        str = str.slice(0, -1);
    } else if (str.endsWith('m')) {
        multiplier = 1000000;
        str = str.slice(0, -1);
    } else if (str.endsWith('k')) {
        multiplier = 1000;
        str = str.slice(0, -1);
    }

    str = str.replace(/,/g, '').replace(/[^\d.-]/g, '');
    const parsed = parseFloat(str);

    return isNaN(parsed) ? 0 : Math.round(parsed * multiplier);
}

function formatFame(num) {
    if (!num || isNaN(num)) return '0';
    if (num >= 1000000000) return (num / 1000000000).toFixed(1) + 'B';
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num.toLocaleString();
}

function centerString(str, width) {
    str = String(str);
    if (str.length >= width) return str.substring(0, width);
    const totalPadding = width - str.length;
    const padLeft = Math.floor(totalPadding / 2);
    const padRight = totalPadding - padLeft;
    return ' '.repeat(padLeft) + str + ' '.repeat(padRight);
}

function formatUTCTime(dateInput) {
    if (!dateInput) return 'N/A';
    let d;
    if (typeof dateInput === 'number' || (!isNaN(dateInput) && !isNaN(parseFloat(dateInput)))) {
        let num = Number(dateInput);
        if (num < 10000000000) num *= 1000;
        d = new Date(num);
    } else {
        d = new Date(dateInput);
    }

    if (isNaN(d.getTime())) return 'N/A';

    const options = {
        timeZone: 'Asia/Bangkok',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    };

    const formatted = new Intl.DateTimeFormat('en-GB', options).format(d);
    return `${formatted.replace(',', '')} +07`;
}

// ======================================================
// 4. ALBION ITEM / WEAPON HELPERS
// ======================================================

function normalizeAlbionItemId(raw) {
    if (!raw) return '';
    let str = '';

    if (typeof raw === 'object') {
        str = raw.itemId ?? raw.ItemId ?? raw.itemID ?? raw.ItemID ?? raw.type ?? raw.Type ?? raw.id ?? raw.Id ?? raw.name ?? raw.Name ?? raw.itemType ?? raw.ItemType ?? '';
    } else {
        str = String(raw);
    }

    str = String(str).trim();
    if (!str) return '';

    const urlMatch = str.match(/\/items\/([^/?#]+)/i) || str.match(/\/v1\/item\/([^/?#]+)/i);
    if (urlMatch) str = decodeURIComponent(urlMatch[1]);

    str = str.replace(/\s+/g, '_').replace(/\.png$/i, '').trim();
    str = str.replace(/@(\d+)Q\d+/i, '@$1');

    return str;
}

function isWeaponItemId(itemId) {
    if (!itemId) return false;
    const id = normalizeAlbionItemId(itemId).toUpperCase();
    return (
        id.includes('_MAIN_') || id.includes('MAIN_') || id.startsWith('MAIN_') ||
        id.includes('2H_') || id.startsWith('2H_') || id.includes('_CROSSBOW') ||
        id.includes('_BOW') || id.includes('_STAFF') || id.includes('_SWORD') ||
        id.includes('_MACE') || id.includes('_AXE') || id.includes('_HAMMER') ||
        id.includes('_SPEAR') || id.includes('_DAGGER') || id.includes('_ARCANE') ||
        id.includes('_HOLY') || id.includes('_NATURE') || id.includes('_FIRE') ||
        id.includes('_FROST') || id.includes('_CURSED')
    );
}

function isBadEquipmentItem(itemId) {
    if (!itemId) return true;
    const id = normalizeAlbionItemId(itemId).toUpperCase();
    return (
        id.includes('BAG') || id.includes('CAPE') || id.includes('HEAD') ||
        id.includes('ARMOR') || id.includes('SHOES') || id.includes('OFF_') ||
        id.includes('FOOD') || id.includes('POTION') || id.includes('MOUNT')
    );
}

function extractMainHandFromObject(obj) {
    if (!obj || typeof obj !== 'object') return '';
    const directCandidates = [
        obj.MainHand, obj.mainHand, obj.MAINHAND, obj.mainhand, obj.Mainhand,
        obj.Equipment?.MainHand, obj.equipment?.MainHand, obj.Equipment?.mainHand,
        obj.equipment?.mainHand, obj.equipment?.mainhand, obj.Equipment?.mainhand,
        obj.weapon, obj.Weapon, obj.weaponId, obj.WeaponId
    ];

    for (const candidate of directCandidates) {
        const id = normalizeAlbionItemId(candidate);
        if (id && !isBadEquipmentItem(id)) return id;
    }
    return '';
}

function extractMainHandFromRow($, row) {
    let weaponCandidates = [];
    $(row).find('img').each((index, img) => {
        const $img = $(img);
        const src = $img.attr('src') || $img.attr('data-src') || $img.attr('data-original') || '';
        const alt = ($img.attr('alt') || '').toLowerCase();
        const title = ($img.attr('title') || '').toLowerCase();
        const parentText = ($img.parent().text() || '').toLowerCase();
        const parentHtml = ($img.parent().html() || '').toLowerCase();

        const itemId = normalizeAlbionItemId(src);
        if (!itemId) return;

        const combinedText = `${alt} ${title} ${parentText} ${parentHtml}`;
        if (combinedText.includes('mainhand') || combinedText.includes('main-hand') || combinedText.includes('main hand') || combinedText.includes('main_hand')) {
            weaponCandidates.push({ id: itemId, score: 100 });
            return;
        }

        const slot = ($img.attr('data-slot') || $img.attr('data-equipment-slot') || $img.parent().attr('data-slot') || $img.parent().attr('data-equipment-slot') || '').toLowerCase();
        const className = ($img.attr('class') || $img.parent().attr('class') || '').toLowerCase();

        if (slot.includes('mainhand') || slot.includes('main-hand') || slot.includes('main_hand') || className.includes('mainhand') || className.includes('main-hand') || className.includes('main_hand')) {
            weaponCandidates.push({ id: itemId, score: 90 });
            return;
        }

        if (isWeaponItemId(itemId)) {
            weaponCandidates.push({ id: itemId, score: 70 });
        }
    });

    if (weaponCandidates.length === 0) return '';
    weaponCandidates.sort((a, b) => b.score - a.score);
    return weaponCandidates[0].id || '';
}

// ======================================================
// 5. SCRAPING & API FETCHING FUNCTIONS
// ======================================================

async function fetchAlbionBBPage(matchId) {
    const url = `https://east.albionbb.com/battles/${encodeURIComponent(matchId)}`;
    try {
        const html = await cloudscraper.get({
            url,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            }
        });
        return html;
    } catch (error) {
        console.error('❌ AlbionBB fetch error:', error.message);
        return null;
    }
}

function parseDataFromHTML(html) {
    const $ = cheerio.load(html);
    const players = [];
    const guilds = [];
    let battleTime = null;

    const timeText = $('time').attr('datetime') || $('time').text() || $('.battle-time').text() || '';
    if (timeText) battleTime = timeText.trim();

    $('table').each((tableIndex, table) => {
        const headers = [];
        $(table).find('thead tr th').each((i, th) => {
            headers.push($(th).text().trim().toLowerCase());
        });

        const killIndex = headers.indexOf('kills');
        const deathIndex = headers.indexOf('deaths');
        const fameIndex = headers.indexOf('fame');
        const dmgIndex = headers.findIndex(h => h.includes('damage') || h.includes('dmg'));
        const healIndex = headers.findIndex(h => h.includes('heal') || h.includes('healing'));
        const nameIndex = headers.findIndex(h => h === 'name' || h === 'player');
        const guildIndex = headers.findIndex(h => h === 'guild' || h === 'alliance');

        $(table).find('tbody tr').each((i, row) => {
            const cells = [];
            $(row).find('td').each((j, td) => {
                cells.push($(td).text().replace(/\s+/g, ' ').trim());
            });

            const weapon = extractMainHandFromRow($, row);

            if (cells.length > Math.max(killIndex, deathIndex)) {
                const name = nameIndex !== -1 ? cells[nameIndex] : (cells[0] || '');
                const guildName = guildIndex !== -1 ? cells[guildIndex] : '';

                const kills = parseInt((cells[killIndex] || '0').replace(/[^\d-]/g, ''), 10) || 0;
                const deaths = parseInt((cells[deathIndex] || '0').replace(/[^\d-]/g, ''), 10) || 0;
                const damage = dmgIndex !== -1 ? parseFameValue(cells[dmgIndex]) : 0;
                const healing = healIndex !== -1 ? parseFameValue(cells[healIndex]) : 0;

                let fame = 0;
                if (fameIndex !== -1 && cells[fameIndex]) fame = parseFameValue(cells[fameIndex]);

                if (name && (killIndex !== -1 || deathIndex !== -1)) {
                    players.push({ name, guild: guildName, kills, deaths, fame, damage, healing, weapon });
                }

                if (guildName && nameIndex === -1) {
                    guilds.push({ name: guildName, kills, deaths, fame });
                }
            }
        });
    });

    return { players, guilds, battleTime };
}

function parseNextData(html) {
    const $ = cheerio.load(html);
    const script = $('script#__NEXT_DATA__').html();
    if (!script) return null;
    try { return JSON.parse(script); } catch (error) { return null; }
}

function extractStructuredDataFromNextData(nextData) {
    let players = [];
    let guilds = [];
    let battleTime = null;

    if (!nextData || !nextData.props || !nextData.props.pageProps) {
        return { players, guilds, battleTime };
    }

    const pageProps = nextData.props.pageProps;
    const battle = pageProps.battle || pageProps.initialBattleData || pageProps.data;

    if (battle) {
        battleTime = battle.startTime || battle.endTime || battle.time || battle.createdAt || battle.timestamp || null;

        if (battle.players && typeof battle.players === 'object') {
            const pList = Array.isArray(battle.players) ? battle.players : Object.values(battle.players);
            pList.forEach(p => {
                const name = p.name || p.Name || p.playerName;
                if (name) {
                    players.push({
                        name: name,
                        guild: p.guildName || p.GuildName || p.guild || p.Guild || '',
                        kills: Number(p.kills || p.Kills || 0),
                        deaths: Number(p.deaths || p.Deaths || 0),
                        fame: parseFameValue(p.killFame || p.killfame || p.fame || p.Fame || 0),
                        damage: parseFameValue(p.damage || p.Damage || p.totalDamage || 0),
                        healing: parseFameValue(p.healing || p.Healing || p.totalHealing || 0),
                        weapon: extractMainHandFromObject(p)
                    });
                }
            });
        }

        if (battle.guilds && typeof battle.guilds === 'object') {
            const gList = Array.isArray(battle.guilds) ? battle.guilds : Object.values(battle.guilds);
            gList.forEach(g => {
                const gName = g.name || g.Name || g.guildName;
                if (gName) {
                    guilds.push({
                        name: gName,
                        kills: Number(g.kills || g.Kills || 0),
                        deaths: Number(g.deaths || g.Deaths || 0),
                        fame: parseFameValue(g.killFame || g.fame || 0)
                    });
                }
            });
        }
    }

    return { players, guilds, battleTime };
}

async function fetchOfficialBattle(matchId) {
    const urls = [
        `https://gameinfo.albiononline.com/api/gameinfo/battles/${matchId}`,
        `https://gameinfo-sgp.albiononline.com/api/gameinfo/battles/${matchId}`
    ];

    for (const url of urls) {
        try {
            const response = await axios.get(url, { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } });
            if (response.data) return response.data;
        } catch (error) {
            console.log(`⚠️ API failed: ${error.message}`);
        }
    }
    return null;
}

// ======================================================
// 6. GENERATE TOP PERFORMANCE IMAGE
// ======================================================

async function generateTopPerformanceImage(players) {
    const cardHeight = 78;
    const cardGap = 10;
    const padding = 15;
    const width = 620;

    const height = padding * 2 + players.length * cardHeight + Math.max(0, players.length - 1) * cardGap;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#bda289';
    ctx.beginPath();
    ctx.roundRect(0, 0, width, height, 12);
    ctx.fill();

    for (let i = 0; i < players.length; i++) {
        const p = players[i];
        const y = padding + i * (cardHeight + cardGap);
        const cardWidth = width - padding * 2;

        ctx.fillStyle = '#a28c78';
        ctx.beginPath();
        ctx.roundRect(padding, y, cardWidth, cardHeight, 10);
        ctx.fill();

        const isHeal = p.type === 'heal';
        const barColor = isHeal ? '#21b293' : '#ff4d6d';
        const percent = Math.min(Math.max(Number(p.percent) || 0, 0), 100);

        if (percent > 0) {
            const currentBarWidth = Math.max((cardWidth * percent) / 100, 80);
            ctx.fillStyle = barColor;
            ctx.beginPath();
            ctx.roundRect(padding, y, Math.min(currentBarWidth, cardWidth), cardHeight, 10);
            ctx.fill();
        }

        const weaponId = normalizeAlbionItemId(p.weapon);
        const weaponSize = 60;
        const weaponX = padding + 9;
        const weaponY = y + (cardHeight - weaponSize) / 2;

        if (weaponId) {
            try {
                const imgUrl = `https://render.albiononline.com/v1/item/${encodeURIComponent(weaponId)}.png`;
                const weaponImg = await loadImage(imgUrl);
                ctx.drawImage(weaponImg, weaponX, weaponY, weaponSize, weaponSize);
            } catch (err) {
                console.error(`❌ Failed to load weapon image: ${weaponId}`, err.message);
            }
        }

        ctx.fillStyle = '#000000';
        ctx.font = 'bold 18px sans-serif';

        const guildTag = p.guild ? `[${p.guild}] ` : '';
        let displayName = `${guildTag}${p.name}`;
        if (displayName.length > 35) displayName = displayName.substring(0, 32) + '...';

        ctx.fillText(displayName, padding + 80, y + 32);

        const icon = isHeal ? 'HEAL' : 'DMG';
        const value = Number(p.value) || 0;
        const valueText = `${icon}  ${value.toLocaleString()} (${percent}%)`;

        ctx.font = 'bold 15px sans-serif';
        ctx.fillStyle = '#111111';
        ctx.fillText(valueText, padding + 80, y + 56);
    }

    const buffer = canvas.toBuffer('image/png');
    return new AttachmentBuilder(buffer, { name: 'top-performance.png' });
}

// ======================================================
// 7. PROCESS BATTLE REPORT
// ======================================================

async function processBattleReport(inputUrlOrId, targetContext, isMessage = false) {
    try {
        let matchId = '';
        const input = String(inputUrlOrId).trim();

        if (input.startsWith('http://') || input.startsWith('https://')) {
            const match = input.match(/\/battles\/([^/?#]+)/i);
            if (!match) throw new Error('ไม่สามารถอ่าน Match ID จากลิงก์ได้');
            matchId = match[1];
        } else {
            matchId = input;
        }

        if (!matchId) throw new Error('Match ID ว่าง');

        const playerMap = new Map();
        const targetPlayersSet = new Set(targetPlayers.map(p => p.toLowerCase()));
        const targetGuildsSet = new Set(targetGuilds.map(g => g.toLowerCase()));

        let allPlayersList = [];
        let rawBattleTime = null;

        const html = await fetchAlbionBBPage(matchId);

        if (html) {
            const nextData = parseNextData(html);
            if (nextData) {
                const structured = extractStructuredDataFromNextData(nextData);
                if (structured.battleTime) rawBattleTime = structured.battleTime;

                structured.players.forEach(p => {
                    allPlayersList.push(p);
                    const pKey = p.name.toLowerCase();
                    const gKey = p.guild ? p.guild.toLowerCase() : '';

                    if (targetPlayersSet.has(pKey) || (gKey && targetGuildsSet.has(gKey))) {
                        if (!playerMap.has(pKey)) {
                            playerMap.set(pKey, p);
                        } else {
                            const existing = playerMap.get(pKey);
                            existing.kills += p.kills;
                            existing.deaths += p.deaths;
                            existing.fame += p.fame;
                            existing.damage = Math.max(existing.damage, p.damage);
                            existing.healing = Math.max(existing.healing, p.healing);
                            if (p.weapon && !existing.weapon) existing.weapon = p.weapon;
                        }
                    }
                });
            }

            const parsedHTML = parseDataFromHTML(html);
            if (!rawBattleTime && parsedHTML.battleTime) rawBattleTime = parsedHTML.battleTime;

            parsedHTML.players.forEach(p => {
                const pKey = p.name.toLowerCase();
                const gKey = p.guild ? p.guild.toLowerCase() : '';

                if (targetPlayersSet.has(pKey) || (gKey && targetGuildsSet.has(gKey))) {
                    if (!playerMap.has(pKey)) {
                        playerMap.set(pKey, p);
                        allPlayersList.push(p);
                    }
                }
            });
        }

        if (playerMap.size === 0 && /^\d+$/.test(matchId)) {
            const apiData = await fetchOfficialBattle(matchId);
            if (apiData) {
                if (apiData.startTime || apiData.endTime) rawBattleTime = apiData.startTime || apiData.endTime;
                if (apiData.players) {
                    const pList = Array.isArray(apiData.players) ? apiData.players : Object.values(apiData.players);
                    for (const p of pList) {
                        const pName = String(p.name || p.Name || '');
                        const pGuild = String(p.guildName || p.guild || '');
                        const wp = extractMainHandFromObject(p);

                        const pObj = {
                            name: pName,
                            guild: pGuild,
                            kills: Number(p.kills || 0),
                            deaths: Number(p.deaths || 0),
                            fame: parseFameValue(p.killFame || p.fame || 0),
                            damage: parseFameValue(p.damage || 0),
                            healing: parseFameValue(p.healing || 0),
                            weapon: wp
                        };

                        allPlayersList.push(pObj);
                        const pKey = pName.toLowerCase();
                        const gKey = pGuild.toLowerCase();

                        if (targetPlayersSet.has(pKey) || (gKey && targetGuildsSet.has(gKey))) {
                            if (!playerMap.has(pKey)) playerMap.set(pKey, pObj);
                        }
                    }
                }
            }
        }

        const formattedBattleTime = formatUTCTime(rawBattleTime);

        let reportText = '```ansi\n';
        reportText += `\x1b[1;36m⚔️ ALBIONBB BATTLE REPORT\x1b[0m | \x1b[1;33mID:\x1b[0m ${matchId}\n`;
        reportText += `\x1b[1;33m🕒 Time:\x1b[0m \x1b[1;37m${formattedBattleTime}\x1b[0m\n`;
        reportText += `\x1b[30m==================================================\x1b[0m\n`;

        const colWidths = { name: 20, kills: 10, deaths: 10, fame: 10 };
        const headerName = 'Name'.padEnd(colWidths.name, ' ');
        const headerKills = centerString('Kills', colWidths.kills);
        const headerDeaths = centerString('Deaths', colWidths.deaths);
        const headerFame = centerString('Fame', colWidths.fame);

        reportText += `\x1b[1;37m${headerName}${headerKills}${headerDeaths}${headerFame}\x1b[0m\n`;
        reportText += `\x1b[30m--------------------------------------------------\x1b[0m\n`;

        let totalKills = 0;
        let totalDeaths = 0;
        let totalFame = 0;

        const sortedPlayerStats = Array.from(playerMap.values()).sort((a, b) => {
            if (b.fame !== a.fame) return b.fame - a.fame;
            return b.kills - a.kills;
        });

        if (sortedPlayerStats.length === 0) {
            reportText += `\x1b[1;30m${centerString('ไม่พบสมาชิกหรือกิลด์ที่ติดตามในไฟต์นี้', 50)}\x1b[0m\n`;
        } else {
            sortedPlayerStats.forEach(data => {
                const player = data.name;
                const kills = data.kills;
                const deaths = data.deaths;
                const fame = data.fame;

                totalKills += kills;
                totalDeaths += deaths;
                totalFame += fame;

                const paddedName = player.substring(0, colWidths.name - 1).padEnd(colWidths.name, ' ');
                const paddedKills = centerString(kills, colWidths.kills);
                const paddedDeaths = centerString(deaths, colWidths.deaths);
                const paddedFame = centerString(formatFame(fame), colWidths.fame);

                const killText = kills > 0 ? `\x1b[32m${paddedKills}\x1b[0m` : `\x1b[30m${paddedKills}\x1b[0m`;
                const deathText = deaths > 0 ? `\x1b[31m${paddedDeaths}\x1b[0m` : `\x1b[30m${paddedDeaths}\x1b[0m`;
                const fameText = fame > 0 ? `\x1b[33m${paddedFame}\x1b[0m` : `\x1b[30m${paddedFame}\x1b[0m`;

                reportText += `${paddedName}${killText}${deathText}${fameText}\n`;
            });
        }

        reportText += `\x1b[30m--------------------------------------------------\x1b[0m\n`;
        const totalPaddedName = 'TOTAL'.padEnd(colWidths.name, ' ');

        reportText += `\x1b[1;37m${totalPaddedName}` +
            `\x1b[32m${centerString(totalKills, colWidths.kills)}` +
            `\x1b[31m${centerString(totalDeaths, colWidths.deaths)}` +
            `\x1b[33m${centerString(formatFame(totalFame), colWidths.fame)}` +
            `\x1b[0m\n`;

        reportText += '```';

        let imageAttachment = null;
        const mergedPlayersMap = new Map();

        for (const p of allPlayersList) {
            if (!p.name) continue;
            const key = p.name.toLowerCase();
            const existing = mergedPlayersMap.get(key);

            if (!existing) {
                mergedPlayersMap.set(key, { ...p, weapon: normalizeAlbionItemId(p.weapon) });
            } else {
                existing.damage = Math.max(Number(existing.damage) || 0, Number(p.damage) || 0);
                existing.healing = Math.max(Number(existing.healing) || 0, Number(p.healing) || 0);

                const existingWeapon = normalizeAlbionItemId(existing.weapon);
                const newWeapon = normalizeAlbionItemId(p.weapon);

                if (newWeapon && isWeaponItemId(newWeapon)) {
                    if (!existingWeapon || !isWeaponItemId(existingWeapon)) existing.weapon = newWeapon;
                }
            }
        }

        const cleanPlayersList = Array.from(mergedPlayersMap.values());

        if (cleanPlayersList.length > 0) {
            const maxDamage = Math.max(...cleanPlayersList.map(p => Number(p.damage) || 0), 1);
            const maxHealing = Math.max(...cleanPlayersList.map(p => Number(p.healing) || 0), 1);

            const topPerformers = cleanPlayersList
                .filter(p => (Number(p.damage) > 0) || (Number(p.healing) > 0))
                .sort((a, b) => ((Number(b.damage) || 0) + (Number(b.healing) || 0)) - ((Number(a.damage) || 0) + (Number(a.healing) || 0)))
                .slice(0, 5)
                .map(p => {
                    const damage = Number(p.damage) || 0;
                    const healing = Number(p.healing) || 0;
                    const isHeal = healing > damage;
                    const value = isHeal ? healing : damage;
                    const maxValue = isHeal ? maxHealing : maxDamage;
                    const percent = maxValue > 0 ? Math.round((value / maxValue) * 100) : 0;

                    return {
                        name: p.name,
                        guild: p.guild,
                        weapon: normalizeAlbionItemId(p.weapon),
                        value,
                        percent,
                        type: isHeal ? 'heal' : 'damage'
                    };
                });

            if (topPerformers.length > 0) {
                imageAttachment = await generateTopPerformanceImage(topPerformers);
            }
        }

        const sendOptions = {
            content: reportText,
            files: imageAttachment ? [imageAttachment] : []
        };

        if (isMessage) {
            await targetContext.edit(sendOptions);
        } else {
            await targetContext.editReply(sendOptions);
        }

    } catch (error) {
        console.error('Process report error:', error);
        const errorMsg = `❌ เกิดข้อผิดพลาดในการประมวลผลไฟต์: \`${error.message}\``;
        if (isMessage) await targetContext.edit(errorMsg);
        else await targetContext.editReply(errorMsg);
    }
}

// ======================================================
// 8. MARKET PRICE CHECKER
// ======================================================

async function checkMarketPrice(itemId, city, interaction) {
    const priceApiUrl = `https://east.albion-online-data.com/api/v2/stats/prices/${encodeURIComponent(itemId)}.json?locations=${city}`;
    const historyApiUrl = `https://east.albion-online-data.com/api/v2/stats/history/${encodeURIComponent(itemId)}.json?locations=${city}&time-scale=24`;
    const imageUrl = `https://render.albiononline.com/v1/item/${encodeURIComponent(itemId)}.png`;

    try {
        const [priceRes, historyRes] = await Promise.all([
            axios.get(priceApiUrl).catch(() => null),
            axios.get(historyApiUrl).catch(() => null)
        ]);

        if (!priceRes || !priceRes.data || priceRes.data.length === 0) {
            return interaction.editReply(`❌ ไม่พบข้อมูลราคาของไอเทม: \`${itemId}\` ที่เมือง \`${city}\``);
        }

        const priceData = priceRes.data[0];
        const buyPriceMax = priceData.buy_price_max || 0;
        const sellPriceMin = priceData.sell_price_min || 0;
        const buyPriceDate = priceData.buy_price_max_date ? formatUTCTime(priceData.buy_price_max_date) : 'N/A';

        let totalVolume24h = 0;
        if (historyRes && historyRes.data && historyRes.data.length > 0) {
            const historyData = historyRes.data[0].data || [];
            if (historyData.length > 0) {
                totalVolume24h = historyData[historyData.length - 1].item_count || 0;
            }
        }

        const embed = {
            color: 0x9b59b6,
            title: `🏷️ Price Check: ${city} (Asia Server)`,
            description: `**Item ID:** \`${itemId}\``,
            thumbnail: { url: imageUrl },
            fields: [
                { name: '💰 ราคาเสนอซื้อสูงสุด (Buy Order)', value: `\`${buyPriceMax.toLocaleString()}\` Silver`, inline: true },
                { name: '🏷️ ราคาตั้งขายต่ำสุด (Sell Order)', value: `\`${sellPriceMin.toLocaleString()}\` Silver`, inline: true },
                { name: '📊 ยอดขายล่าสุด (24 ชม.)', value: `\`${totalVolume24h.toLocaleString()}\` ชิ้น`, inline: false },
                { name: '🕒 อัปเดตราคาล่าสุดเมื่อ', value: buyPriceDate, inline: false }
            ],
            footer: { text: 'ข้อมูลจาก Albion Online Data Project' },
            timestamp: new Date().toISOString()
        };

        await interaction.editReply({ embeds: [embed] });
    } catch (error) {
        console.error('Price check error:', error);
        await interaction.editReply(`❌ เกิดข้อผิดพลาดในการดึงข้อมูลราคา: \`${error.message}\``);
    }
}

// ======================================================
// 9. SLASH COMMANDS DEFINITION
// ======================================================

const commands = [
    new SlashCommandBuilder()
        .setName('check')
        .setDescription('ระบบตรวจสอบสถิติและรายชื่อ')
        .addSubcommand(sub =>
            sub
                .setName('battles')
                .setDescription('เช็กสถิติไฟต์จาก Match ID หรือ ลิงก์')
                .addStringOption(opt => opt.setName('link_or_id').setDescription('ใส่ Match ID หรือ ลิงก์ AlbionBB').setRequired(true))
        )
        .addSubcommand(sub => sub.setName('guilds').setDescription('แสดงรายชื่อกิลด์ทั้งหมดในระบบติดตาม'))
        .addSubcommand(sub => sub.setName('members').setDescription('แสดงรายชื่อผู้เล่นทั้งหมดในระบบติดตาม')),

    new SlashCommandBuilder()
        .setName('stat')
        .setDescription('ดึงข้อมูลและสถิติ PvP ของผู้เล่น')
        .addStringOption(opt => opt.setName('player').setDescription('ชื่อผู้เล่นในเกม').setRequired(true)),

    new SlashCommandBuilder()
        .setName('guild')
        .setDescription('ดึงข้อมูลสถิติของกิลด์')
        .addStringOption(opt => opt.setName('name').setDescription('ชื่อกิลด์ในเกม').setRequired(true)),

    new SlashCommandBuilder()
        .setName('mvp')
        .setDescription('วิเคราะห์เพื่อหา MVP, Executioner และ Feeder ในไฟต์')
        .addStringOption(opt => opt.setName('link_or_id').setDescription('ใส่ Match ID หรือ ลิงก์ AlbionBB').setRequired(true)),

    new SlashCommandBuilder()
        .setName('ราคา')
        .setDescription('เช็กราคาและสถิติการขายไอเทม (เซิร์ฟเวอร์ Asia)')
        .addStringOption(opt => opt.setName('name').setDescription('ชื่อหรือรหัสไอเทม').setRequired(true))
        .addStringOption(opt =>
            opt.setName('city')
                .setDescription('เลือกเมืองที่ต้องการเช็กราคา')
                .setRequired(false)
                .addChoices(
                    { name: 'Black Market', value: 'BlackMarket' },
                    { name: 'Martlock', value: 'Martlock' },
                    { name: 'Bridgewatch', value: 'Bridgewatch' },
                    { name: 'Caerleon', value: 'Caerleon' },
                    { name: 'Lymhurst', value: 'Lymhurst' },
                    { name: 'Fort Sterling', value: 'FortSterling' },
                    { name: 'Thetford', value: 'Thetford' }
                )
        )
        .addIntegerOption(opt =>
            opt.setName('tier')
                .setDescription('ระดับ Tier ของไอเทม (1 - 8)')
                .setRequired(false)
                .addChoices(
                    { name: 'Tier 1', value: 1 }, { name: 'Tier 2', value: 2 },
                    { name: 'Tier 3', value: 3 }, { name: 'Tier 4', value: 4 },
                    { name: 'Tier 5', value: 5 }, { name: 'Tier 6', value: 6 },
                    { name: 'Tier 7', value: 7 }, { name: 'Tier 8', value: 8 }
                )
        )
        .addIntegerOption(opt =>
            opt.setName('enhancement')
                .setDescription('ระดับจุด / Enhancement (0 - 4)')
                .setRequired(false)
                .addChoices(
                    { name: '.0 (ไม่มีจุด)', value: 0 }, { name: '.1 (จุด 1)', value: 1 },
                    { name: '.2 (จุด 2)', value: 2 }, { name: '.3 (จุด 3)', value: 3 },
                    { name: '.4 (จุด 4)', value: 4 }
                )
        ),

    new SlashCommandBuilder()
        .setName('regear')
        .setDescription('คำนวณราคาประเมินค่า Regear สำหรับผู้เล่นที่เสียชีวิตในไฟต์')
        .addStringOption(opt => opt.setName('link_or_id').setDescription('ใส่ Match ID หรือ ลิงก์ AlbionBB').setRequired(true))
        .addStringOption(opt => opt.setName('player').setDescription('ชื่อผู้เล่นที่ต้องการคิด Regear').setRequired(true)),

    new SlashCommandBuilder()
        .setName('add')
        .setDescription('ระบบเพิ่มรายการเข้าสู่ระบบติดตาม')
        .addSubcommand(sub => sub.setName('guild').setDescription('เพิ่มชื่อกิลด์เข้าสู่ระบบติดตาม').addStringOption(opt => opt.setName('name').setDescription('ชื่อกิลด์').setRequired(true)))
        .addSubcommand(sub => sub.setName('player').setDescription('เพิ่มชื่อผู้เล่นเข้าสู่ระบบติดตาม').addStringOption(opt => opt.setName('name').setDescription('ชื่อผู้เล่น').setRequired(true))),

    new SlashCommandBuilder()
        .setName('remove')
        .setDescription('ระบบลบรายการออกจากระบบติดตาม')
        .addSubcommand(sub => sub.setName('guild').setDescription('ลบชื่อกิลด์ออกจากระบบติดตาม').addStringOption(opt => opt.setName('name').setDescription('ชื่อกิลด์').setRequired(true)))
        .addSubcommand(sub => sub.setName('player').setDescription('ลบชื่อผู้เล่นออกจากระบบติดตาม').addStringOption(opt => opt.setName('name').setDescription('ชื่อผู้เล่น').setRequired(true))),

    new SlashCommandBuilder()
        .setName('shutdown')
        .setDescription('สั่งปิดการทำงานของบอท (เฉพาะเจ้าของเท่านั้น)')
].map(command => command.toJSON());

// ======================================================
// 10. BOT READY & EVENT HANDLERS
// ======================================================

client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}!`);
    const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);

    try {
        console.log('⏳ กำลังลงทะเบียน Slash Commands ใหม่...');
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('✅ ลงทะเบียน Slash Commands สำเร็จแล้ว!');
    } catch (error) {
        console.error('❌ เกิดข้อผิดพลาดในการลงทะเบียนคำสั่ง:', error);
    }
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;

    if (commandName === 'shutdown') {
        if (!OWNER_ID || interaction.user.id !== OWNER_ID) {
            return interaction.reply({ content: '❌ คุณไม่มีสิทธิ์ใช้งานคำสั่งนี้!', ephemeral: true });
        }
        await interaction.reply('👋 กำลังปิดระบบบอท...');
        setTimeout(() => process.exit(0), 1000);
        return;
    }

    if (commandName === 'stat') {
        const playerName = interaction.options.getString('player');
        await interaction.deferReply();
        try {
            const searchUrl = `https://gameinfo.albiononline.com/api/gameinfo/search?q=${encodeURIComponent(playerName)}`;
            const searchRes = await axios.get(searchUrl);
            const playerObj = searchRes.data.players?.find(p => p.Name.toLowerCase() === playerName.toLowerCase());

            if (!playerObj) {
                return interaction.editReply(`❌ ไม่พบผู้เล่นชื่อ **${playerName}** ในระบบ`);
            }

            const pUrl = `https://gameinfo.albiononline.com/api/gameinfo/players/${playerObj.Id}`;
            const pRes = await axios.get(pUrl);
            const pData = pRes.data;

            const embed = new EmbedBuilder()
                .setColor(0x3498db)
                .setTitle(`👤 Player Profile: ${pData.Name}`)
                .addFields(
                    { name: '🛡️ Guild', value: pData.GuildName ? `[${pData.GuildName}]` : 'None', inline: true },
                    { name: '⚔️ Alliance', value: pData.AllianceName || 'None', inline: true },
                    { name: '💀 Kill Fame', value: formatFame(pData.KillFame), inline: true },
                    { name: '⚰️ Death Fame', value: formatFame(pData.DeathFame), inline: true },
                    { name: '⚖️ K/D Ratio', value: (pData.FameRatio || 0).toFixed(2), inline: true },
                    { name: '🌾 PvE Fame', value: formatFame(pData.LifetimeStatistics?.PvE?.Total), inline: true }
                )
                .setTimestamp();

            await interaction.editReply({ embeds: [embed] });
        } catch (err) {
            await interaction.editReply(`❌ เกิดข้อผิดพลาดในการค้นหาข้อมูลผู้เล่น: ${err.message}`);
        }
        return;
    }

    if (commandName === 'guild') {
        const guildName = interaction.options.getString('name');
        await interaction.deferReply();
        try {
            const searchUrl = `https://gameinfo.albiononline.com/api/gameinfo/search?q=${encodeURIComponent(guildName)}`;
            const searchRes = await axios.get(searchUrl);
            const guildObj = searchRes.data.guilds?.find(g => g.Name.toLowerCase() === guildName.toLowerCase());

            if (!guildObj) {
                return interaction.editReply(`❌ ไม่พบกิลด์ชื่อ **${guildName}** ในระบบ`);
            }

            const gUrl = `https://gameinfo.albiononline.com/api/gameinfo/guilds/${guildObj.Id}`;
            const gRes = await axios.get(gUrl);
            const gData = gRes.data;

            const embed = new EmbedBuilder()
                .setColor(0xe74c3c)
                .setTitle(`🛡️ Guild Info: ${gData.Name}`)
                .addFields(
                    { name: '👑 Alliance', value: gData.AllianceTag ? `[${gData.AllianceTag}] ${gData.AllianceName}` : 'None', inline: true },
                    { name: '👥 Members', value: `${gData.memberCount || 0}`, inline: true },
                    { name: '⚔️ Kill Fame', value: formatFame(gData.killFame), inline: true },
                    { name: '💀 Death Fame', value: formatFame(gData.DeathFame), inline: true }
                )
                .setTimestamp();

            await interaction.editReply({ embeds: [embed] });
        } catch (err) {
            await interaction.editReply(`❌ เกิดข้อผิดพลาดในการดึงข้อมูลกิลด์: ${err.message}`);
        }
        return;
    }

    if (commandName === 'mvp') {
        const input = interaction.options.getString('link_or_id');
        await interaction.deferReply();
        try {
            const matchId = input.includes('/battles/') ? input.match(/\/battles\/([^/?#]+)/i)[1] : input;
            const html = await fetchAlbionBBPage(matchId);
            if (!html) return interaction.editReply('❌ ไม่สามารถเข้าถึงข้อมูลไฟต์ได้');

            const parsed = parseDataFromHTML(html);
            if (!parsed.players || parsed.players.length === 0) {
                return interaction.editReply('❌ ไม่พบสถิติผู้เล่นในไฟต์นี้');
            }

            const sortedDmgHeal = [...parsed.players].sort((a, b) => (b.damage + b.healing) - (a.damage + a.healing));
            const sortedKills = [...parsed.players].sort((a, b) => b.kills - a.kills);
            const sortedDeaths = [...parsed.players].sort((a, b) => b.deaths - a.deaths);

            const mvp = sortedDmgHeal[0];
            const executioner = sortedKills[0];
            const feeder = sortedDeaths[0];

            const embed = new EmbedBuilder()
                .setColor(0xf1c40f)
                .setTitle(`🏆 Battle Awards - Match ID: ${matchId}`)
                .addFields(
                    { name: '👑 MVP (Top Performance)', value: `**${mvp.name}**\nDamage: ${formatFame(mvp.damage)} | Heal: ${formatFame(mvp.healing)}`, inline: false },
                    { name: '🎯 Executioner (Most Kills)', value: `**${executioner.name}**\nKills: ${executioner.kills} | Fame: ${formatFame(executioner.fame)}`, inline: true },
                    { name: '💀 Feeder (Most Deaths)', value: `**${feeder.name}**\nDeaths: ${feeder.deaths}`, inline: true }
                )
                .setTimestamp();

            await interaction.editReply({ embeds: [embed] });
        } catch (err) {
            await interaction.editReply(`❌ เกิดข้อผิดพลาดในการวิเคราะห์ MVP: ${err.message}`);
        }
        return;
    }

    if (commandName === 'regear') {
        const input = interaction.options.getString('link_or_id');
        const targetPlayer = interaction.options.getString('player');
        await interaction.deferReply();

        try {
            const matchId = input.includes('/battles/') ? input.match(/\/battles\/([^/?#]+)/i)[1] : input;
            const apiData = await fetchOfficialBattle(matchId);

            if (!apiData || !apiData.players) {
                return interaction.editReply('❌ ไม่พบข้อมูลอย่างเป็นทางการของไฟต์นี้สำหรับคิด Regear');
            }

            const pList = Array.isArray(apiData.players) ? apiData.players : Object.values(apiData.players);
            const target = pList.find(p => p.name?.toLowerCase() === targetPlayer.toLowerCase());

            if (!target) {
                return interaction.editReply(`❌ ไม่พบผู้เล่นชื่อ **${targetPlayer}** ในไฟต์นี้`);
            }

            if (!target.deaths || target.deaths === 0) {
                return interaction.editReply(`✅ ผู้เล่น **${targetPlayer}** ไม่ได้เสียชีวิตในไฟต์นี้ (ไม่ต้อง Regear)`);
            }

            const embed = new EmbedBuilder()
                .setColor(0xe67e22)
                .setTitle(`📦 Regear Request: ${target.name}`)
                .setDescription(`รายการอุปกรณ์ที่เสียชีวิตใน Match ID: \`${matchId}\``)
                .addFields(
                    { name: '⚔️ Weapon', value: target.Equipment?.MainHand?.Type || 'None', inline: true },
                    { name: '🛡️ Armor', value: target.Equipment?.Armor?.Type || 'None', inline: true },
                    { name: '🪖 Head', value: target.Equipment?.Head?.Type || 'None', inline: true },
                    { name: '👟 Shoes', value: target.Equipment?.Shoes?.Type || 'None', inline: true },
                    { name: '🎒 Cape', value: target.Equipment?.Cape?.Type || 'None', inline: true },
                    { name: '💰 estimated Regear Value', value: 'กรุณาตรวจสอบราคาในตลาดผ่าน `/ราคา`', inline: false }
                )
                .setFooter({ text: 'กดอนุมัติการจ่ายชดเชยจากระบบ Regear ของกิลด์' })
                .setTimestamp();

            await interaction.editReply({ embeds: [embed] });
        } catch (err) {
            await interaction.editReply(`❌ เกิดข้อผิดพลาดในการคำนวณ Regear: ${err.message}`);
        }
        return;
    }

    if (commandName === 'ราคา') {
        let rawName = interaction.options.getString('name').toUpperCase().trim();
        const city = interaction.options.getString('city') || 'BlackMarket';
        const tier = interaction.options.getInteger('tier');
        const enhancement = interaction.options.getInteger('enhancement');

        rawName = rawName.replace(/^(NOVICE'S|JOURNEYMAN'S|ADEPT'S|EXPERT'S|MASTER'S|GRANDMASTER'S|ELDER'S)\s+/i, '');

        const itemAliasMap = {
            'SATCHEL OF INSIGHT': 'BAG_TALISMAN',
            'SATCHEL': 'BAG_TALISMAN',
            'BAG': 'BAG',
            'CAPE': 'CAPE',
            'MAIN SWORD': 'MAIN_SWORD',
            'SWORD': 'MAIN_SWORD'
        };

        if (itemAliasMap[rawName]) rawName = itemAliasMap[rawName];

        let itemId = rawName.replace(/\s+/g, '_');
        if (tier && !itemId.startsWith('T') && !/^T\d_/i.test(itemId)) itemId = `T${tier}_${itemId}`;
        if (enhancement !== null && enhancement !== undefined && enhancement > 0) {
            itemId = itemId.split('@')[0] + `@${enhancement}`;
        }

        await interaction.deferReply();
        await checkMarketPrice(itemId, city, interaction);
        return;
    }

    const subcommand = interaction.options.getSubcommand();

    if (commandName === 'check') {
        if (subcommand === 'battles') {
            const input = interaction.options.getString('link_or_id');
            await interaction.deferReply();
            await processBattleReport(input, interaction);
            return;
        }

        if (subcommand === 'guilds') {
            if (targetGuilds.length === 0) return interaction.reply('🛡️ ไม่มีกิลด์ในระบบติดตาม');
            const listText = targetGuilds.map((g, i) => `${i + 1}. ${g}`).join('\n');
            return interaction.reply(`🛡️ **รายชื่อกิลด์ในระบบติดตาม (${targetGuilds.length} กิลด์):**\n\`\`\`\n${listText}\n\`\`\``);
        }

        if (subcommand === 'members') {
            if (targetPlayers.length === 0) return interaction.reply('📋 ไม่มีผู้เล่นในระบบติดตาม');
            const listText = targetPlayers.map((p, i) => `${i + 1}. ${p}`).join('\n');
            return interaction.reply(`📋 **รายชื่อผู้เล่นในระบบติดตาม (${targetPlayers.length} คน):**\n\`\`\`\n${listText}\n\`\`\``);
        }
    }

    if (commandName === 'add') {
        if (subcommand === 'guild') {
            const name = interaction.options.getString('name');
            if (targetGuilds.some(g => g.toLowerCase() === name.toLowerCase())) {
                return interaction.reply({ content: `⚠️ มีกิลด์ **${name}** อยู่ในระบบแล้ว`, ephemeral: true });
            }
            targetGuilds.push(name);
            saveData();
            return interaction.reply(`🛡️ เพิ่มกิลด์ **${name}** เข้าสู่ระบบติดตามเรียบร้อยแล้ว!`);
        }

        if (subcommand === 'player') {
            const name = interaction.options.getString('name');
            if (targetPlayers.some(p => p.toLowerCase() === name.toLowerCase())) {
                return interaction.reply({ content: `⚠️ มีชื่อ **${name}** อยู่ในระบบแล้ว`, ephemeral: true });
            }
            targetPlayers.push(name);
            saveData();
            return interaction.reply(`✅ เพิ่มผู้เล่น **${name}** เข้าสู่ระบบติดตามเรียบร้อยแล้ว!`);
        }
    }

    if (commandName === 'remove') {
        if (subcommand === 'guild') {
            const name = interaction.options.getString('name');
            const initialLength = targetGuilds.length;
            targetGuilds = targetGuilds.filter(g => g.toLowerCase() !== name.toLowerCase());
            if (targetGuilds.length === initialLength) {
                return interaction.reply({ content: `❌ ไม่พบกิลด์ **${name}** ในระบบ`, ephemeral: true });
            }
            saveData();
            return interaction.reply(`🗑️ ลบกิลด์ **${name}** เรียบร้อยแล้ว!`);
        }

        if (subcommand === 'player') {
            const name = interaction.options.getString('name');
            const initialLength = targetPlayers.length;
            targetPlayers = targetPlayers.filter(p => p.toLowerCase() !== name.toLowerCase());
            if (targetPlayers.length === initialLength) {
                return interaction.reply({ content: `❌ ไม่พบชื่อ **${name}** ในระบบ`, ephemeral: true });
            }
            saveData();
            return interaction.reply(`🗑️ ลบผู้เล่น **${name}** เรียบร้อยแล้ว!`);
        }
    }
});

client.on('messageCreate', async message => {
    if (message.author.bot) return;

    const urlRegex = /https?:\/\/east\.albionbb\.com\/battles\/[^\s]+/i;
    const match = message.content.match(urlRegex);

    if (!match) return;

    try {
        const statusMsg = await message.reply('⏳ กำลังดึงสถิติจาก AlbionBB...');
        await processBattleReport(match[0], statusMsg, true);
    } catch (error) {
        console.error(error);
    }
});

// ======================================================
// 11. LOGIN
// ======================================================
client.login(BOT_TOKEN);