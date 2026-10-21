'use strict';

const {
    SlashCommandBuilder, EmbedBuilder, AttachmentBuilder, ActionRowBuilder,
    ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ModalBuilder,
    TextInputBuilder, TextInputStyle, MessageFlags
} = require('discord.js');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');

const WEAPONS = {
    Caller: ['Mace','Golem','HOJ','MorningStar','Dreadstorm','Incubus','Witchwork','GA','Perma','Soulscythe'],
    Tank: ['Mace','Golem','HOJ','MorningStar','Dreadstorm','Incubus','Bedrock','HeavyMace','Hammer','Polehammer','Grovekeeper','GA','BlackMonk','Soulscythe','StaffofBalance'],
    DPS: ['Realmbreaker','Longbow','EnergyShaper','Siegebow','Rotcaller','Demonfang','BridledFury','Bloodletter','Dawnsong','Blazing','Brimstone','Perma','Spiked','BattleBracers','Hellfire','Ravenstrike','Ursine','Lightcaller','RiftGlaive','Spirithunter','HeronSpear','InfinityBlade','Galatine','Carving','Kingmaker','ClarentBlade','Mistpiercer'],
    Support: ['Lifecurse','Shadowcaller','Damnation','Rotcaller','Locus','Occult','Oathkeepers','Rootbound','Enigmatic'],
    Heal: ['Hallowfall','Fallen','Exalted','Blight','WildStaff','Rampant','Forgebark']
};
const ROLE_ORDER = ['Tank', 'DPS', 'Support', 'Heal'];
const ROLE_LABELS = { Caller: '📣 Caller', Tank: '🛡️ Tank', DPS: '⚔️ DPS', Support: '🔮 Support', Heal: '💚 Heal' };
const ROLE_LABELS_SHORT = { Caller: 'CALLER', Tank: 'TANK', DPS: 'DPS', Support: 'SUPPORT', Heal: 'HEALER' };

const PRESETS = {
    small: { label: 'Small Scale', desc: '1-2-8-2-2 = 15 คน', counts: { Tank: 2, DPS: 8, Support: 2, Heal: 2 } },
    zvz: { label: 'ZvZ', desc: '1-4-10-3-2 = 19 คน', counts: { Tank: 4, DPS: 10, Support: 3, Heal: 2 } },
    gank: { label: 'Gank', desc: '1-1-3-1-1 = 7 คน', counts: { Tank: 1, DPS: 3, Support: 1, Heal: 1 } },
    ava: { label: 'AVA', desc: '1-3-12-3-3 = 22 คน', counts: { Tank: 3, DPS: 12, Support: 3, Heal: 3 } },
};

const sessions = new Map();
const MAX_TEMPLATES = 25;
const MAX_EVENTS = 20;
const WEAPON_DIR = path.join(__dirname, 'weapon');
const WEAPON_CDN_BASE = 'https://cdn.jsdelivr.net/gh/ledcbr888-code/albion-discord-bot@main/weapon';
const WEAPON_RAW_BASE = 'https://raw.githubusercontent.com/ledcbr888-code/albion-discord-bot/main/weapon';

// ===== PERFORMANCE CACHES =====
const weaponIconPathCache = new Map(); // name -> path or null
const weaponImageCache = new Map(); // name -> loaded Image (canvas)
const gridCache = new Map(); // key -> Buffer
const rosterCache = new Map(); // eventId+hash -> Buffer

const commandBuilders = [
    new SlashCommandBuilder()
        .setName('cta')
        .setDescription('สร้าง CTA พร้อมกำหนดตำแหน่งและอาวุธ')
        .addStringOption(o => o.setName('title').setDescription('ชื่อ CTA').setRequired(true).setMaxLength(80))
        .addStringOption(o => o.setName('time_utc').setDescription('เลือกเวลา UTC รายชั่วโมง ไม่ต้องใส่วันที่').setRequired(true).addChoices(...Array.from({ length: 24 }, (_, hour) => {
            const value = String(hour).padStart(2, '0') + ':00';
            return { name: value + ' UTC', value };
        })))
        .addIntegerOption(o => o.setName('max_players').setDescription('จำนวนผู้เล่นสูงสุดรวม Caller (1-20)').setRequired(true).setMinValue(1).setMaxValue(20)),
    new SlashCommandBuilder().setName('ctaup').setDescription('เรียกใช้ชุดแผน CTA ที่บันทึกไว้')
];

function token() { return crypto.randomBytes(4).toString('hex'); }
function eventId() { return crypto.randomBytes(5).toString('hex'); }
function safeText(value, max = 80) { return String(value || '').replace(/[\r\n\x60@]/g, ' ').trim().slice(0, max); }
function displayWeapon(name) { return String(name || '').replace(/ClarentBlade/g, 'Clarent Blade').replace(/BattleBracers/g, 'Battle Bracers'); }
function parseUtc(value) {
    const input = String(value || '').trim();
    if (!/^(?:[01]\d|2[0-3]):00$/.test(input)) return null;
    const [hour] = input.split(':').map(Number);
    const now = new Date();
    let timestamp = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, 0, 0, 0);
    if (timestamp <= Date.now()) timestamp += 24 * 60 * 60 * 1000;
    return timestamp;
}
function getConfig(guildId, deps) {
    const cfg = deps.getGuildConfig(guildId, true);
    if (!Array.isArray(cfg.ctaTemplates)) cfg.ctaTemplates = [];
    if (!Array.isArray(cfg.ctaEvents)) cfg.ctaEvents = [];
    return cfg;
}
function weaponFileName(name) { return name === 'Clarent Blade' ? 'ClarentBlade' : name; }

// OPTIMIZED: no existsSync loop every time, cache result
function weaponIconPath(name) {
    if (!name) return null;
    if (weaponIconPathCache.has(name)) return weaponIconPathCache.get(name);
    const clean = weaponFileName(name);
    const candidates = [
        path.join(WEAPON_DIR, clean + '.png'),
        path.join(WEAPON_DIR, clean + '.jpg'),
        path.join(WEAPON_DIR, clean + '.webp'),
        path.join(__dirname, 'weapon', clean + '.png'),
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) {
            weaponIconPathCache.set(name, p);
            return p;
        }
    }
    weaponIconPathCache.set(name, null);
    return null;
}

function getWeaponCdnUrl(name) {
    if (!name) return null;
    const clean = weaponFileName(name);
    // ใช้ jsDelivr CDN เป็นหลัก - ไฟล์ทั้งหมดอยู่ที่ https://github.com/ledcbr888-code/albion-discord-bot/tree/main/weapon
    return `${WEAPON_CDN_BASE}/${encodeURIComponent(clean)}.png`;
}

function tryLoadCanvas() {
    try { return require('canvas'); } catch {}
    try { return require('@napi-rs/canvas'); } catch {}
    return null;
}

// ===== FUZZY SEARCH =====
function fuzzyScore(target, query) {
    if (!query) return 0;
    const t = target.toLowerCase().replace(/\s+/g, '');
    const q = query.toLowerCase().replace(/\s+/g, '');
    if (!q) return 0;
    if (t.includes(q)) return q.length * 100 - t.indexOf(q);
    let ti = 0, qi = 0, matched = 0, lastPos = -1, gaps = 0;
    while (ti < t.length && qi < q.length) {
        if (t[ti] === q[qi]) {
            if (lastPos !== -1) gaps += ti - lastPos - 1;
            lastPos = ti;
            qi++; matched++;
        }
        ti++;
    }
    if (matched === q.length) return matched * 10 - gaps;
    return null;
}

function weaponOptions(role, page, search) {
    const all = WEAPONS[role] || [];
    if (!search) {
        const currentPage = Math.max(0, page);
        const start = currentPage * 25;
        return { filtered: all, page: currentPage, totalPages: Math.max(1, Math.ceil(all.length / 25)), options: all.slice(start, start + 25).map(name => ({ label: displayWeapon(name), value: name, description: 'เลือก ' + displayWeapon(name) })) };
    }
    let filtered = [];
    try {
        const Fuse = require('fuse.js');
        const fuse = new Fuse(all.map(n => ({ name: n, display: displayWeapon(n) })), { keys: ['name', 'display'], threshold: 0.4, includeScore: true });
        const results = fuse.search(search);
        filtered = results.map(r => r.item.name);
    } catch {
        const scored = [];
        for (const name of all) {
            const disp = displayWeapon(name);
            const score1 = fuzzyScore(name, search);
            const score2 = fuzzyScore(disp, search);
            const best = Math.max(score1 ?? -9999, score2 ?? -9999);
            if (best !== null && best > -9999) scored.push({ name, score: best });
        }
        scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
        filtered = scored.map(s => s.name);
    }
    const currentPage = Math.max(0, page);
    const start = currentPage * 25;
    return { filtered, page: currentPage, totalPages: Math.max(1, Math.ceil(filtered.length / 25)), options: filtered.slice(start, start + 25).map(name => ({ label: displayWeapon(name), value: name, description: 'เลือก ' + displayWeapon(name) })) };
}

// ---------- Count Panel ----------
function makeRoleCountOptions(max) {
    const options = [];
    for (let i = 0; i <= max; i++) options.push({ label: String(i), value: String(i), description: i === 0 ? 'ไม่ใช้ตำแหน่งนี้' : 'จำนวน ' + i + ' คน' });
    return options;
}
function buildCountRows(session) {
    return ROLE_ORDER.map(role => {
        const current = Number(session.counts[role]) || 0;
        const placeholder = current > 0 ? (ROLE_LABELS[role] + ' — จำนวน ' + current + ' คน') : (ROLE_LABELS[role] + ' — จำนวนคน');
        const menu = new StringSelectMenuBuilder()
            .setCustomId('cta:count:' + session.id + ':' + role)
            .setPlaceholder(placeholder)
            .setMinValues(1).setMaxValues(1)
            .addOptions(makeRoleCountOptions(Math.max(0, session.maxPlayers - 1)));
        return new ActionRowBuilder().addComponents(menu);
    });
}
function buildPresetRows(sessionId) {
    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('cta:preset:' + sessionId + ':small').setLabel('⚔️ Small Scale (1-2-8-2-2)').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('cta:preset:' + sessionId + ':zvz').setLabel('🛡️ ZvZ (1-4-10-3-2)').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('cta:preset:' + sessionId + ':gank').setLabel('🗡️ Gank (1-1-3-1-1)').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('cta:preset:' + sessionId + ':ava').setLabel('🏰 AVA').setStyle(ButtonStyle.Secondary)
    );
    return [row1];
}
function getMetaWarnings(counts, total, maxPlayers) {
    const warnings = [];
    const tank = Number(counts.Tank) || 0;
    const dps = Number(counts.DPS) || 0;
    const sup = Number(counts.Support) || 0;
    const heal = Number(counts.Heal) || 0;
    const isSmall = maxPlayers <= 7 || total <= 3;
    if (!isSmall) {
        if (tank === 0) warnings.push('⚠️ **ยังไม่มี Tank** — อาจโดนล้วง Caller ง่าย');
        else if (tank === 1 && total > 7) warnings.push('ℹ️ Tank มีแค่ 1 คน — แนะนำ 2+ สำหรับ ZvZ');
        if (dps === 0) warnings.push('⚠️ **ยังไม่มี DPS** — ไม่มีดาเมจหลัก');
        else if (dps < 3) warnings.push('⚠️ **DPS น้อยกว่า 3 คน** — ดาเมจอาจไม่พอปิดคิล');
        else if (dps < 5 && total >= 10) warnings.push('ℹ️ DPS น้อยกว่า 5 คน — แนะนำ 5+ สำหรับไฟต์ใหญ่');
        if (sup === 0) warnings.push('⚠️ **ไม่มี Support** — ขาด Curse / Locus / Occult');
    }
    if (heal === 0) warnings.push('⚠️ **ไม่มี Heal** — ไม่มีฮีลเลย');
    else if (heal === 1 && total >= 12) warnings.push('ℹ️ Heal มีแค่ 1 คน — แนะนำ 2+');
    if (total <= 1) warnings.push('⚠️ มีแค่ Caller คนเดียว');
    if (total < maxPlayers * 0.5) warnings.push('ℹ️ ใช้ช่องแค่ ' + total + '/' + maxPlayers + ' คน — ยังว่างเยอะ');
    if (!isSmall) {
        if (tank > dps) warnings.push('ℹ️ Tank เยอะกว่า DPS — อาจดาเมจขาด');
        if (heal > tank + 1) warnings.push('ℹ️ Heal เยอะกว่า Tank');
    }
    if (warnings.length === 0) warnings.push('✅ คอมพ์ดูสมดุลดี');
    return warnings;
}
function countPanel(session) {
    const total = 1 + ROLE_ORDER.reduce((sum, role) => sum + (Number(session.counts[role]) || 0), 0);
    const countRows = buildCountRows(session);
    const actionRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('cta:countnext:' + session.id).setLabel('ยืนยันตำแหน่งและเลือกอาวุธ').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('cta:presetmenu:' + session.id).setLabel('เลือก Preset').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('cta:preset:' + session.id + ':clear').setLabel('ล้างจำนวน').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('cta:cancel:' + session.id).setLabel('ยกเลิก').setStyle(ButtonStyle.Danger)
    );
    const detail = ['Caller', ...ROLE_ORDER].map(role => {
        const c = role === 'Caller' ? 1 : (Number(session.counts[role]) || 0);
        const label = ROLE_LABELS[role] || '📣 Caller';
        return (c > 0 ? '✅ ' : '▫️ ') + label + ': ' + c + ' คน';
    }).join('\n');
    const warnings = getMetaWarnings(session.counts, total, session.maxPlayers);
    const warningText = warnings.join('\n');
    return {
        content: '⚔️ **ตั้งค่า CTA: ' + session.title + '**\n🕒 เวลา UTC: **' + new Date(session.startAt).toISOString().slice(0, 16).replace('T', ' ') + ' UTC** (นับถอยหลัง <t:' + Math.floor(session.startAt / 1000) + ':R>)\n👥 Party 1 สูงสุด **' + session.maxPlayers + '** คน โดย Caller ใช้ 1 ช่องเสมอ\n\n' + detail + '\n\n**🔍 เช็คคอมพ์:**\n' + warningText,
        components: [...countRows, actionRow].slice(0, 5)
    };
}

// ===== OPTIMIZED GRID - SMALLER, CACHED, PARALLEL LOAD =====
async function loadWeaponImageCached(name, loadImage) {
    if (weaponImageCache.has(name)) return weaponImageCache.get(name);
    const iconPath = weaponIconPath(name);
    if (iconPath) {
        try {
            const img = await loadImage(iconPath);
            weaponImageCache.set(name, img);
            return img;
        } catch {}
    }
    // Fallback: try GitHub CDN (if local not found)
    try {
        const cdnUrl = getWeaponCdnUrl(name);
        const res = await axios.get(cdnUrl, { responseType: 'arraybuffer', timeout: 3000, validateStatus: s => s >= 200 && s < 300 });
        const buffer = Buffer.from(res.data);
        const img = await loadImage(buffer);
        weaponImageCache.set(name, img);
        return img;
    } catch {}
    return null;
}

async function buildWeaponGridImage(weapons, usedMap, currentRole) {
    const cacheKey = `${currentRole}:${weapons.join(',')}:${Array.from(usedMap.entries()).join(';')}`;
    if (gridCache.has(cacheKey)) return gridCache.get(cacheKey);

    const canvasLib = tryLoadCanvas();
    if (!canvasLib) return null;
    const { createCanvas, loadImage } = canvasLib;
    
    // OPTIMIZED SIZE: จากเดิม 420x520 -> 200x240 (เล็กกว่า 4 เท่า = เร็วขึ้น 4 เท่า)
    const cols = 5;
    const cellW = 200;
    const cellH = 240;
    const padding = 12;
    const headerH = 60;
    const rows = Math.ceil(weapons.length / cols);
    const width = cols * cellW + (cols + 1) * padding;
    const height = headerH + rows * cellH + (rows + 1) * padding;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#232428'; ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#1e1f22'; ctx.fillRect(0, 0, width, headerH);
    ctx.fillStyle = '#ffffff'; ctx.font = 'bold 24px sans-serif';
    ctx.fillText((ROLE_LABELS_SHORT[currentRole] || currentRole) + ' - ' + weapons.length + ' WEAPONS', padding + 12, 38);

    // Parallel load all images
    const imagePromises = weapons.map(w => loadWeaponImageCached(w, loadImage));
    const loadedImages = await Promise.all(imagePromises);

    for (let idx = 0; idx < weapons.length; idx++) {
        const wName = weapons[idx];
        const col = idx % cols;
        const row = Math.floor(idx / cols);
        const x = padding + col * (cellW + padding);
        const y = headerH + padding + row * (cellH + padding);
        const isUsed = usedMap.has(wName);

        ctx.fillStyle = isUsed ? '#3d3520' : '#2b2d31';
        ctx.fillRect(x, y, cellW, cellH);
        ctx.strokeStyle = isUsed ? '#f0c35a' : '#3f4147';
        ctx.lineWidth = isUsed ? 2 : 1;
        ctx.strokeRect(x, y, cellW, cellH);

        const loadedImg = loadedImages[idx];
        const iconSize = 140;
        if (loadedImg) {
            const ix = x + (cellW - iconSize) / 2;
            const iy = y + 10;
            try { ctx.drawImage(loadedImg, ix, iy, iconSize, iconSize); } catch {}
        } else {
            ctx.fillStyle = '#2b2d31'; ctx.fillRect(x + (cellW-80)/2, y + 30, 80, 80);
            ctx.fillStyle = '#ffffff'; ctx.font = 'bold 28px sans-serif'; ctx.textAlign='center';
            ctx.fillText('⚔️', x + cellW/2, y + 80); ctx.textAlign='left';
        }
        // Name under image - FIXED: smaller font, proper truncation, no overflow
        ctx.fillStyle = '#1a1b1e'; ctx.fillRect(x, y + 165, cellW, 50);
        ctx.fillStyle = isUsed ? '#f0c35a' : '#ffffff';
        ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'center';
        // Truncate properly: 18 chars max
        const displayName = displayWeapon(wName);
        const shortName = displayName.length > 16 ? displayName.slice(0, 14) + '..' : displayName;
        ctx.fillText(shortName, x + cellW / 2, y + 184, cellW - 10);
        ctx.font = '10px sans-serif'; ctx.fillStyle = isUsed ? '#f0c35a' : '#9ca0a6';
        ctx.fillText(isUsed ? 'PICKED x' + usedMap.get(wName) : 'AVAILABLE', x + cellW / 2, y + 200);
        ctx.textAlign = 'left';
    }
    const buffer = canvas.toBuffer('image/png');
    gridCache.set(cacheKey, buffer);
    if (gridCache.size > 50) gridCache.delete(gridCache.keys().next().value);
    return buffer;
}

async function buildRosterSmallIconImage(event) {
    const cacheKey = event.id + ':' + event.slots.map(s => s.weapon + s.userId).join('|');
    if (rosterCache.has(cacheKey)) return rosterCache.get(cacheKey);

    const canvasLib = tryLoadCanvas();
    if (!canvasLib) return null;
    const { createCanvas, loadImage } = canvasLib;
    const slots = event.slots;
    const rowH = 90;
    const width = 900;
    const height = slots.length * rowH + 10;
    const canvas = createCanvas(width, height); const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#2b2d31'; ctx.fillRect(0, 0, width, height);
    
    const imagePromises = slots.map(s => loadWeaponImageCached(s.weapon, loadImage));
    const loadedImages = await Promise.all(imagePromises);

    for (let i = 0; i < slots.length; i++) {
        const s = slots[i]; const y = i * rowH;
        ctx.fillStyle = i % 2 === 0 ? '#313338' : '#2b2d31'; ctx.fillRect(0, y, width, rowH);
        if (i === 0) { ctx.fillStyle = '#00b0f4'; ctx.fillRect(0, 0, 6, height); }
        const iconX = 10, iconY = y + 8, iconS = 74;
        ctx.fillStyle = '#1e1f22'; ctx.fillRect(iconX, iconY, iconS, iconS);
        ctx.strokeStyle = '#3f4147'; ctx.lineWidth = 1; ctx.strokeRect(iconX, iconY, iconS, iconS);
        const loadedImg = loadedImages[i];
        if (loadedImg) {
            try { ctx.drawImage(loadedImg, iconX + 2, iconY + 2, iconS - 4, iconS - 4); } catch {}
        } else {
            ctx.fillStyle = '#ffffff'; ctx.font = 'bold 20px sans-serif'; ctx.textAlign='center';
            ctx.fillText(ROLE_EMOJIS[s.role] || '⚔️', iconX + iconS/2, iconY + iconS/2 + 6); ctx.textAlign='left';
        }
        if (s.userId) {
            ctx.fillStyle = '#23a559'; ctx.beginPath(); ctx.arc(iconX + iconS + 10, iconY + iconS / 2, 7, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = '#ffffff'; ctx.font = 'bold 10px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('✓', iconX + iconS + 10, iconY + iconS / 2 + 3); ctx.textAlign = 'left';
        }
        ctx.fillStyle = '#f2f3f5'; ctx.font = 'bold 15px sans-serif';
        const roleText = (i + 1) + '. ' + (ROLE_LABELS_SHORT[s.role] || s.role).toUpperCase() + (s.weapon ? ' - ' + displayWeapon(s.weapon) : '');
        ctx.fillText(roleText.slice(0, 50), 105, y + 32);
        if (s.userId) { ctx.fillStyle = '#949ba4'; ctx.font = '12px sans-serif'; ctx.fillText('@' + (s.userName || 'Joined').slice(0, 28), 105, y + 52); }
        else { ctx.fillStyle = '#6d6f78'; ctx.font = '12px sans-serif'; ctx.fillText('Vacant', 105, y + 52); }
    }
    const buffer = canvas.toBuffer('image/png');
    rosterCache.set(cacheKey, buffer);
    if (rosterCache.size > 30) rosterCache.delete(rosterCache.keys().next().value);
    return buffer;
}

function weaponPanel(session) {
    const slot = session.slots[session.slotIndex];
    const pageData = weaponOptions(slot.role, session.page || 0, session.search || '');
    const select = new StringSelectMenuBuilder()
        .setCustomId('cta:weapon:' + session.id + ':' + session.slotIndex + ':' + pageData.page)
        .setPlaceholder('พิมพ์ชื่ออาวุธเพื่อค้นหา... | ' + (pageData.filtered.length ? pageData.filtered.length + ' ชิ้นเจอ' : 'พิมพ์เช่น blaz, bracer, clarent'))
        .setMinValues(1).setMaxValues(1);
    if (pageData.options.length) select.addOptions(pageData.options);
    const rows = [];
    if (pageData.options.length) rows.push(new ActionRowBuilder().addComponents(select));
    const controls = [
        new ButtonBuilder().setCustomId('cta:search:' + session.id + ':' + session.slotIndex).setLabel('🔎 พิมพ์ค้นหา (Fuzzy)').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('cta:prev:' + session.id).setLabel('ย้อนกลับ').setStyle(ButtonStyle.Secondary).setDisabled(session.slotIndex === 0),
        new ButtonBuilder().setCustomId('cta:cancel:' + session.id).setLabel('ยกเลิก').setStyle(ButtonStyle.Danger)
    ];
    if (pageData.totalPages > 1) {
        controls.unshift(new ButtonBuilder().setCustomId('cta:page:' + session.id + ':' + (pageData.page > 0 ? pageData.page - 1 : pageData.page + 1)).setLabel(pageData.page > 0 ? 'หน้าก่อน' : 'หน้าถัดไป (' + (pageData.page + 1) + '/' + pageData.totalPages + ')').setStyle(ButtonStyle.Primary));
    }
    rows.push(new ActionRowBuilder().addComponents(controls));
    const searchInfo = session.search ? ' | ค้นหา: **' + session.search + '** (' + pageData.filtered.length + ' ผลลัพธ์)' : '';
    return {
        content: '🗡️ **กำหนดอาวุธ: ช่อง ' + (session.slotIndex + 1) + '/' + session.slots.length + '**\nตำแหน่ง: **' + (ROLE_LABELS[slot.role] || slot.role) + '** | หน้า ' + (pageData.page + 1) + '/' + pageData.totalPages + searchInfo + '\n💡 **Fuzzy Search:** พิมพ์ `blaz` → Blazing, `bracer` → Battle Bracers, `carv` → Carving, `blood` → Bloodletter ได้เลย',
        components: rows
    };
}
function savePrompt(session) {
    return {
        content: '✅ กำหนดอาวุธครบทุกช่องแล้ว\nต้องการบันทึกชุดตำแหน่งและอาวุธไว้ใช้ซ้ำหรือไม่?',
        embeds: [], attachments: [],
        components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('cta:saveno:' + session.id).setLabel('ไม่ — เผยแพร่ CTA').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('cta:saveyes:' + session.id).setLabel('ใช่ — บันทึกแผน').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('cta:cancel:' + session.id).setLabel('ยกเลิก').setStyle(ButtonStyle.Danger)
        )]
    };
}
const ROLE_COLORS = { Caller: 0xf0c35a, Tank: 0x4aa3ff, DPS: 0xf05252, Support: 0xf59e0b, Heal: 0x35c979 };
const ROLE_EMOJIS = { Caller: '📣', Tank: '🛡️', DPS: '⚔️', Support: '🔮', Heal: '💚' };

async function renderRosterBatches(event, deps) {
    const unix = Math.floor(event.startAt / 1000);
    const dateStr = new Date(event.startAt).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
    const timeUTCStr = new Date(event.startAt).toISOString().slice(11, 16);
    const localDate = new Date(event.startAt); localDate.setHours(localDate.getHours() + 7);
    const timeLocalStr = localDate.toISOString().slice(11, 16);
    let emojiMap = new Map();
    try {
        if (deps && deps.client) {
            const guild = await deps.client.guilds.fetch(event.guildId).catch(() => null);
            if (guild) { await guild.emojis.fetch().catch(() => {}); for (const [id, emoji] of guild.emojis.cache) { emojiMap.set(emoji.name.toLowerCase(), '<:' + emoji.name + ':' + id + '>'); } }
        }
    } catch {}
    function getWeaponEmoji(weaponName) {
        if (!weaponName) return '🟩';
        const key = weaponName.toLowerCase();
        if (emojiMap.has(key)) return emojiMap.get(key);
        const clean = key.replace(/[^a-z0-9]/g, '');
        if (emojiMap.has(clean)) return emojiMap.get(clean);
        return null;
    }
    const lines = event.slots.map((s, i) => {
        const customEmoji = getWeaponEmoji(s.weapon);
        const statusIcon = s.userId ? '✅' : (customEmoji || ROLE_EMOJIS[s.role] || '⚔️');
        const roleText = (ROLE_LABELS_SHORT[s.role] || s.role || '').toUpperCase();
        const weaponText = s.weapon ? displayWeapon(s.weapon) : '';
        const userPart = s.userId ? ' - <@' + s.userId + '> (' + (s.userName || '') + ')' : '';
        return statusIcon + ' ' + (i + 1) + '. ' + roleText + (weaponText ? ' - ' + weaponText : '') + userPart;
    });
    let rosterImg = null;
    try { rosterImg = await buildRosterSmallIconImage(event); } catch (e) { console.error('small roster img error', e.message); }
    const embed = new EmbedBuilder()
        .setColor(0x2b2d31)
        .setTitle(safeText(event.title, 80))
        .setDescription('Date: ' + dateStr + '\nTime (UTC): ' + timeUTCStr + '\nTime (Local): ' + timeLocalStr + ' (<t:' + unix + ':R>)\n\n⚔️ Party 1\n' + lines.join('\n') + '\n\nEvent ID: ' + event.id)
        .setFooter({ text: 'Albion Online • CTA Roster' });
    const files = [];
    if (rosterImg) { const attName = 'cta-party-' + event.id + '.png'; files.push(new AttachmentBuilder(rosterImg, { name: attName })); embed.setImage('attachment://' + attName); }
    return [{ content: null, embeds: [embed], files, attachments: [], allowedMentions: { parse: [], users: [] } }];
}

async function weaponPanelPayload(session) {
    const panel = weaponPanel(session);
    const slot = session.slots[session.slotIndex];
    const data = weaponOptions(slot.role, session.page || 0, session.search || '');
    const selected = session.slots.filter(s => s.weapon).length;
    const usedMap = new Map();
    for (const s of session.slots) if (s.weapon) usedMap.set(s.weapon, (usedMap.get(s.weapon) || 0) + 1);
    const roleSummary = ['Caller', 'Tank', 'DPS', 'Support', 'Heal'].map(role => {
        const roleSlots = session.slots.filter(s => s.role === role);
        if (!roleSlots.length) return null;
        const picked = roleSlots.filter(s => s.weapon).length;
        return ROLE_EMOJIS[role] + ' ' + role + ': ' + picked + '/' + roleSlots.length;
    }).filter(Boolean).join(' · ');
    const slotSummary = session.slots.map((entry, i) => {
        const weapon = entry.weapon ? displayWeapon(entry.weapon) : (i === session.slotIndex ? '➡️ กำลังเลือก...' : '▫️ ยังไม่เลือก');
        const marker = entry.weapon ? '✅' : (i === session.slotIndex ? '➡️' : '▫️');
        return marker + ' ' + String(i + 1).padStart(2, '0') + '. ' + (ROLE_LABELS[entry.role] || entry.role) + ' — ' + weapon;
    });
    const description = [
        '📍 **ตำแหน่ง:** ' + (ROLE_LABELS[slot.role] || slot.role),
        '🗡️ **ช่อง:** ' + (session.slotIndex + 1) + '/' + session.slots.length + ' | **เลือกแล้ว:** ' + selected + '/' + session.slots.length,
        roleSummary, '', '**สรุปช่อง**', ...slotSummary.slice(0, 20)
    ].filter(Boolean);
    const infoEmbed = new EmbedBuilder().setColor(0xd99a3d).setTitle('🗡️ กำหนดอาวุธ — ' + (ROLE_LABELS[slot.role] || slot.role)).setDescription(description.join('\n').slice(0, 4000)).setFooter({ text: 'Fuzzy Search: blaz → Blazing, bracer → Battle Bracers' });
    let gridBuffer = null;
    try { const weaponsOnPage = data.filtered.slice(data.page * 25, data.page * 25 + 25); gridBuffer = await buildWeaponGridImage(weaponsOnPage, usedMap, slot.role); } catch (e) { console.error('grid error', e.message); }
    const files = [];
    if (gridBuffer) { const attName = 'weapon-grid-' + session.id + '.png'; files.push(new AttachmentBuilder(gridBuffer, { name: attName })); const gridEmbed = new EmbedBuilder().setColor(0x232428).setTitle((ROLE_LABELS_SHORT[slot.role] || slot.role) + ' - ' + data.filtered.length + ' WEAPONS').setImage('attachment://' + attName).setFooter({ text: 'Optimized: 200x240 | Cache enabled | GitHub CDN fallback' }); return { ...panel, embeds: [infoEmbed, gridEmbed], files, attachments: [] }; }
    else { return { ...panel, embeds: [infoEmbed], files: [], attachments: [] }; }
}

function eventEmbed(event) {
    const unix = Math.floor(event.startAt / 1000); const joined = event.slots.filter(s => s.userId).length;
    return new EmbedBuilder().setColor(0xd99a3d).setTitle('⚔️ CTA — ' + event.title).setDescription('🕒 เวลาเริ่ม: **' + new Date(event.startAt).toISOString().slice(11, 16) + ' UTC**\n⏳ นับถอยหลัง: <t:' + unix + ':R>\n👥 ผู้ลงชื่อ: **' + joined + '/' + event.maxPlayers + '** คน\n📌 หัวหน้า CTA: <@' + event.ownerId + '>').setFooter({ text: 'Albion Online • CTA Roster' });
}
function eventButtons(event) {
    return [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('cta:join:' + event.id).setLabel('Join').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('cta:leave:' + event.id).setLabel('Leave').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('cta:ping:' + event.id).setLabel('⚔️ Ping').setStyle(ButtonStyle.Danger)
    )];
}
function getEvent(guildId, eventId, deps) {
    const cfg = deps.getGuildConfig(guildId, false);
    if (!cfg) return null;
    return (cfg.ctaEvents || []).find(e => String(e.id) === String(eventId)) || null;
}
async function refreshEvent(event, deps) {
    try {
        const channel = await deps.client.channels.fetch(event.channelId).catch(() => null);
        if (!channel) return;
        const batches = await renderRosterBatches(event, deps);
        const msgId = event.messageId;
        if (!msgId) return;
        const message = await channel.messages.fetch(msgId).catch(() => null);
        if (!message) return;
        const payload = batches[0];
        await message.edit({ ...payload, components: eventButtons(event) }).catch(() => {});
    } catch (e) { console.error('refreshEvent error', e.message); }
}
async function publishEvent(session, deps) {
    const cfg = deps.getGuildConfig(session.guildId, true);
    const id = eventId();
    const event = { id, guildId: session.guildId, channelId: session.channelId, ownerId: session.userId, title: session.title, startAt: session.startAt, maxPlayers: session.maxPlayers, slots: session.slots.map((s, i) => ({ role: s.role, weapon: s.weapon, userId: i === 0 ? session.userId : null, userName: i === 0 ? 'Caller' : null })), messageId: null, createdAt: new Date().toISOString() };
    const batches = await renderRosterBatches(event, deps);
    const channel = await deps.client.channels.fetch(session.channelId).catch(() => null);
    if (!channel) throw new Error('ไม่พบห้อง');
    const sent = await channel.messages.fetch().catch(() => null);
    const payload = batches[0];
    const message = await channel.send({ ...payload, components: eventButtons(event) });
    event.messageId = message.id;
    cfg.ctaEvents.push(event);
    cfg.ctaEvents = cfg.ctaEvents.slice(-MAX_EVENTS);
    deps.saveData();
    return event;
}
function ownerOnly(interaction, session) { return String(interaction.user.id) === String(session.userId); }
function utcHourOptions() { return Array.from({ length: 24 }, (_, hour) => { const value = String(hour).padStart(2, '0') + ':00'; return { label: value + ' UTC', value }; }); }
function saveModal(id) {
    const modal = new ModalBuilder().setCustomId('cta:savesubmit:' + id).setTitle('บันทึกชุดแผน CTA');
    modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('name').setLabel('ชื่อชุดแผน').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(60)));
    return modal;
}
function searchModal(id, index) {
    const modal = new ModalBuilder().setCustomId('cta:searchsubmit:' + id + ':' + index).setTitle('ค้นหาอาวุธ (Fuzzy)');
    modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('query').setLabel('พิมพ์ชื่อ เช่น blaz, bracer, clarent').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(40)));
    return modal;
}
function reuseModal(id) {
    const modal = new ModalBuilder().setCustomId('cta:upsubmit:' + id).setTitle('ตั้งชื่อ CTA จากชุดแผน');
    modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('title').setLabel('ชื่อ CTA').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80)));
    return modal;
}
async function handleInteraction(interaction, deps) {
    if (interaction.isChatInputCommand && interaction.isChatInputCommand()) {
        const { commandName } = interaction;
        if (commandName === 'cta') {
            const title = safeText(interaction.options.getString('title'), 80);
            const timeUtc = interaction.options.getString('time_utc');
            const maxPlayers = interaction.options.getInteger('max_players');
            const startAt = parseUtc(timeUtc);
            if (!title) { await interaction.reply({ content: '❌ กรุณาระบุชื่อ CTA', flags: MessageFlags.Ephemeral }); return true; }
            if (!startAt) { await interaction.reply({ content: '❌ เวลา UTC ไม่ถูกต้อง', flags: MessageFlags.Ephemeral }); return true; }
            const id = token();
            const session = { id, guildId: interaction.guildId, userId: interaction.user.id, channelId: interaction.channelId, title, startAt, maxPlayers, counts: { Tank: 0, DPS: 0, Support: 0, Heal: 0 }, slots: [], slotIndex: 0, page: 0, search: '' };
            sessions.set(id, session);
            await interaction.reply({ ...countPanel(session), flags: MessageFlags.Ephemeral });
            return true;
        }
        if (commandName === 'ctaup') {
            const cfg = getConfig(interaction.guildId, deps);
            const templates = cfg.ctaTemplates.slice(0, MAX_TEMPLATES);
            if (!templates.length) { await interaction.reply({ content: 'ยังไม่มีชุดแผน', flags: MessageFlags.Ephemeral }); return true; }
            const id = token();
            sessions.set(id, { id, guildId: interaction.guildId, userId: interaction.user.id, channelId: interaction.channelId, mode: 'reuse' });
            const options = templates.map(t => ({ label: safeText(t.name, 100) || 'แผน CTA', value: String(t.id), description: 'Party 1 · ' + t.slots.length + ' ช่อง' }));
            await interaction.reply({ content: '📚 เลือกชุดแผน', components: [
                new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('cta:template:' + id).setPlaceholder('เลือกชุดแผน CTA').addOptions(options)),
                new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('cta:deletetemplates:' + id).setLabel('🗑️ ลบชุดแผน').setStyle(ButtonStyle.Danger))
            ], flags: MessageFlags.Ephemeral });
            return true;
        }
        return false;
    }
    if (!(interaction.isButton?.() || interaction.isStringSelectMenu?.() || interaction.isModalSubmit?.())) return false;
    const customId = String(interaction.customId || '');
    if (!customId.startsWith('cta:')) return false;
    const parts = customId.split(':');
    const action = parts[1], id = parts[2];
    if (action === 'ping') {
        const event = getEvent(interaction.guildId, id, deps);
        if (!event) { await interaction.reply({ content: '❌ ไม่พบ CTA', flags: MessageFlags.Ephemeral }); return true; }
        if (String(event.ownerId) !== String(interaction.user.id)) { await interaction.reply({ content: '🔒 เฉพาะหัวหน้า CTA', flags: MessageFlags.Ephemeral }); return true; }
        const joinedIds = [...new Set(event.slots.filter(slot => slot.userId).map(slot => String(slot.userId)))];
        if (!joinedIds.length) { await interaction.reply({ content: 'ยังไม่มีผู้ลงชื่อ', flags: MessageFlags.Ephemeral }); return true; }
        const channel = await deps.client.channels.fetch(event.channelId).catch(() => null);
        if (!channel) { await interaction.reply({ content: '❌ ไม่พบห้อง', flags: MessageFlags.Ephemeral }); return true; }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const mentions = joinedIds.map(uid => '<@' + uid + '>').join(' ');
        await channel.send({ content: mentions, embeds: [new EmbedBuilder().setColor(0xe32636).setTitle('⚔️ CTA mass start now ⚔️').setDescription('**เตรียมรวมกลุ่ม!**').setFooter({ text: event.title.slice(0, 80) })], allowedMentions: { users: joinedIds } });
        await interaction.editReply({ content: '✅ ส่ง Ping แล้ว ' + joinedIds.length + ' คน' });
        return true;
    }
    if (action === 'join' || action === 'leave') {
        const event = getEvent(interaction.guildId, id, deps);
        if (!event) { await interaction.reply({ content: '❌ ไม่พบ CTA', flags: MessageFlags.Ephemeral }); return true; }
        if (action === 'join') {
            const existing = event.slots.find(s => s.userId === interaction.user.id);
            if (existing) { await interaction.reply({ content: 'คุณลงชื่อแล้วช่อง ' + (event.slots.indexOf(existing) + 1), flags: MessageFlags.Ephemeral }); return true; }
            const open = event.slots.map((s, i) => ({ s, i })).filter(x => !x.s.userId);
            if (!open.length) { await interaction.reply({ content: '❌ เต็มแล้ว', flags: MessageFlags.Ephemeral }); return true; }
            await interaction.reply({
                content: 'เลือกช่อง - พิมพ์ชื่ออาวุธในช่องเลือกเพื่อกรองได้เลย',
                components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('cta:signup:' + id).setPlaceholder('พิมพ์ชื่ออาวุธเพื่อค้นหา...').addOptions(open.slice(0, 25).map(({ s, i }) => ({ label: (i + 1) + '. ' + s.role + ' — ' + displayWeapon(s.weapon), value: String(i), description: displayWeapon(s.weapon) }))))],
                flags: MessageFlags.Ephemeral
            });
            return true;
        }
        const existing = event.slots.find(s => s.userId === interaction.user.id);
        if (!existing) { await interaction.reply({ content: 'ยังไม่ได้ลงชื่อ', flags: MessageFlags.Ephemeral }); return true; }
        existing.userId = null; existing.userName = null; deps.saveData();
        await interaction.reply({ content: '✅ ถอนชื่อแล้ว', flags: MessageFlags.Ephemeral });
        await refreshEvent(event, deps).catch(() => {});
        return true;
    }
    if (action === 'signup') {
        const event = getEvent(interaction.guildId, id, deps);
        if (!event) { await interaction.reply({ content: '❌ ไม่พบ CTA', flags: MessageFlags.Ephemeral }); return true; }
        const index = Number(interaction.values[0]), slot = event.slots[index];
        if (!slot || slot.userId) { await interaction.reply({ content: 'ช่องนี้ถูกเลือกแล้ว', flags: MessageFlags.Ephemeral }); return true; }
        if (event.slots.some(s => s.userId === interaction.user.id)) { await interaction.reply({ content: 'คุณลงชื่อแล้ว', flags: MessageFlags.Ephemeral }); return true; }
        slot.userId = interaction.user.id;
        slot.userName = safeText(interaction.member?.displayName || interaction.user.globalName || interaction.user.username, 32);
        deps.saveData();
        await interaction.update({ content: '✅ ลงชื่อสำเร็จ: ช่อง ' + (index + 1) + ' · ' + slot.role + ' · ' + displayWeapon(slot.weapon), components: [], embeds: [], files: [] });
        await refreshEvent(event, deps).catch(() => {});
        return true;
    }
    const session = sessions.get(id);
    if (!session) { await interaction.reply({ content: '⏰ หมดอายุ', flags: MessageFlags.Ephemeral }); return true; }
    if (!ownerOnly(interaction, session)) { await interaction.reply({ content: '🔒 เฉพาะผู้สร้าง', flags: MessageFlags.Ephemeral }); return true; }
    if (action === 'presetmenu') {
        await interaction.update({
            content: '📌 **เลือก Preset สำหรับ CTA**\nเลือกชุดตำแหน่งที่ต้องการ หรือกลับไปปรับจำนวนเอง',
            components: [
                ...buildPresetRows(session.id),
                new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('cta:presetback:' + session.id).setLabel('กลับไปเลือกจำนวนเอง').setStyle(ButtonStyle.Secondary))
            ]
        });
        return true;
    }
    if (action === 'preset') {
        const presetKey = parts[3];
        if (presetKey === 'clear') { session.counts = { Tank: 0, DPS: 0, Support: 0, Heal: 0 }; await interaction.update(countPanel(session)); return true; }
        const preset = PRESETS[presetKey];
        if (!preset) { await interaction.reply({ content: '❌ ไม่พบ preset', flags: MessageFlags.Ephemeral }); return true; }
        session.counts = { ...preset.counts };
        await interaction.update(countPanel(session));
        return true;
    }
    if (action === 'presetback') { await interaction.update(countPanel(session)); return true; }
    if (action === 'count') {
        const role = parts[3]; const value = Number(interaction.values[0]);
        session.counts[role] = value;
        await interaction.update(countPanel(session));
        return true;
    }
    if (action === 'countnext') {
        const total = 1 + ROLE_ORDER.reduce((s, r) => s + (Number(session.counts[r]) || 0), 0);
        if (total <= 1) { await interaction.reply({ content: '❌ ต้องมีอย่างน้อย 2 คน (Caller + 1)', flags: MessageFlags.Ephemeral }); return true; }
        if (total > session.maxPlayers) { await interaction.reply({ content: '❌ เกินจำนวนสูงสุด ' + session.maxPlayers + ' คน', flags: MessageFlags.Ephemeral }); return true; }
        session.slots = [{ role: 'Caller', weapon: null }];
        for (const role of ROLE_ORDER) { const c = Number(session.counts[role]) || 0; for (let i = 0; i < c; i++) session.slots.push({ role, weapon: null }); }
        session.slotIndex = 0; session.page = 0; session.search = '';
        await interaction.update(await weaponPanelPayload(session));
        return true;
    }
    if (action === 'weapon') {
        const slotIndex = Number(parts[3]); const page = Number(parts[4]) || 0;
        const weapon = interaction.values[0];
        if (slotIndex !== session.slotIndex) { await interaction.reply({ content: 'ไม่ตรง', flags: MessageFlags.Ephemeral }); return true; }
        session.slots[slotIndex].weapon = weapon;
        session.slotIndex++;
        session.page = 0; session.search = '';
        if (session.slotIndex >= session.slots.length) { await interaction.update(savePrompt(session)); return true; }
        await interaction.update(await weaponPanelPayload(session));
        return true;
    }
    if (action === 'search') {
        const index = Number(parts[3]);
        if (index !== session.slotIndex) { await interaction.reply({ content: 'ไม่ตรง', flags: MessageFlags.Ephemeral }); return true; }
        await interaction.showModal(searchModal(id, index));
        return true;
    }
    if (action === 'searchsubmit') {
        const index = Number(parts[3]);
        if (index !== session.slotIndex) { await interaction.reply({ content: 'ไม่ตรง', flags: MessageFlags.Ephemeral }); return true; }
        session.search = safeText(interaction.fields.getTextInputValue('query'), 40); session.page = 0;
        await interaction.update(await weaponPanelPayload(session));
        return true;
    }
    if (action === 'page') { session.page = Number(parts[3]) || 0; await interaction.update(await weaponPanelPayload(session)); return true; }
    if (action === 'prev') { session.slotIndex = Math.max(0, session.slotIndex - 1); session.page = 0; session.search = ''; await interaction.update(await weaponPanelPayload(session)); return true; }
    if (action === 'cancel') { sessions.delete(id); await interaction.update({ content: 'ยกเลิกแล้ว', components: [], embeds: [], attachments: [] }); return true; }
    if (action === 'saveyes') { await interaction.showModal(saveModal(id)); return true; }
    if (action === 'saveno') {
        await interaction.deferUpdate();
        try { const event = await publishEvent(session, deps); await interaction.editReply({ content: '✅ เผยแพร่ CTA **' + event.title + '** แล้ว', components: [] }); } catch (err) { await interaction.followUp({ content: '❌ ' + err.message, flags: MessageFlags.Ephemeral }); }
        return true;
    }
    if (action === 'savesubmit') {
        const name = safeText(interaction.fields.getTextInputValue('name'), 60);
        if (!name) { await interaction.reply({ content: 'กรุณาระบุชื่อ', flags: MessageFlags.Ephemeral }); return true; }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const cfg = getConfig(session.guildId, deps);
        const template = { id: token(), name, maxPlayers: session.slots.length, slots: session.slots.map(s => ({ role: s.role, weapon: s.weapon })), createdAt: new Date().toISOString() };
        const duplicate = cfg.ctaTemplates.findIndex(t => String(t.name).toLowerCase() === name.toLowerCase());
        if (duplicate >= 0) cfg.ctaTemplates[duplicate] = template; else cfg.ctaTemplates.push(template);
        cfg.ctaTemplates = cfg.ctaTemplates.slice(-MAX_TEMPLATES); deps.saveData();
        try { const event = await publishEvent(session, deps); await interaction.editReply({ content: '✅ บันทึก **' + name + '** และเผยแพร่ CTA **' + event.title + '** แล้ว' }); } catch (err) { await interaction.editReply({ content: '⚠️ บันทึกแล้วแต่เผยแพร่ไม่สำเร็จ: ' + err.message }); }
        return true;
    }
    if (action === 'template') {
        const cfg = getConfig(session.guildId, deps);
        const template = cfg.ctaTemplates.find(t => String(t.id) === String(interaction.values[0]));
        if (!template) { await interaction.reply({ content: 'ไม่พบชุดแผน', flags: MessageFlags.Ephemeral }); return true; }
        session.template = template;
        await interaction.showModal(reuseModal(id));
        return true;
    }
    if (action === 'upsubmit') {
        const title = safeText(interaction.fields.getTextInputValue('title'), 80);
        if (!title) { await interaction.reply({ content: 'กรุณาระบุชื่อ CTA', flags: MessageFlags.Ephemeral }); return true; }
        if (!session.template) { await interaction.reply({ content: 'ไม่พบแผน', flags: MessageFlags.Ephemeral }); return true; }
        session.title = title; session.maxPlayers = session.template.maxPlayers;
        session.slots = session.template.slots.map(s => ({ role: s.role, weapon: s.weapon }));
        await interaction.reply({ content: '🕒 เลือกเวลาเริ่ม UTC', components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('cta:uptime:' + id).setPlaceholder('เลือกเวลา 00:00–23:00 UTC').addOptions(utcHourOptions()))], flags: MessageFlags.Ephemeral });
        return true;
    }
    if (action === 'uptime') {
        const startAt = parseUtc(interaction.values[0]);
        if (!startAt || !session.template || !session.title) { await interaction.reply({ content: '❌ ไม่ถูกต้อง', flags: MessageFlags.Ephemeral }); return true; }
        session.startAt = startAt;
        await interaction.deferUpdate();
        try { const event = await publishEvent(session, deps); await interaction.editReply({ content: '✅ เรียกใช้ชุดแผนแล้ว **' + event.title + '**', components: [] }); } catch (err) { await interaction.editReply({ content: '❌ ' + err.message, components: [] }); }
        return true;
    }
    if (action === 'deletetemplates') {
        const cfg = getConfig(session.guildId, deps), templates = cfg.ctaTemplates.slice(0, MAX_TEMPLATES);
        if (!templates.length) { await interaction.reply({ content: 'ไม่มีชุดแผน', flags: MessageFlags.Ephemeral }); return true; }
        await interaction.reply({
            content: '🗑️ เลือกชุดแผนที่ต้องการลบ',
            components: [
                new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('cta:deletetemplate:' + id).setPlaceholder('เลือกชุดแผนที่จะลบ').addOptions(templates.map(t => ({ label: safeText(t.name, 100) || 'แผน CTA', value: String(t.id), description: 'Party 1 · ' + t.slots.length + ' ช่อง' })))),
                new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('cta:cancel:' + id).setLabel('ยกเลิก').setStyle(ButtonStyle.Secondary))
            ],
            flags: MessageFlags.Ephemeral
        });
        return true;
    }
    if (action === 'deletetemplate') {
        const cfg = getConfig(session.guildId, deps), template = cfg.ctaTemplates.find(t => String(t.id) === String(interaction.values[0]));
        if (!template) { await interaction.reply({ content: 'ไม่พบ', flags: MessageFlags.Ephemeral }); return true; }
        session.pendingDeleteTemplateId = String(template.id);
        await interaction.update({ content: 'ยืนยันลบชุดแผน **' + safeText(template.name, 60) + '**?', components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('cta:confirmdelete:' + id).setLabel('ยืนยันลบ').setStyle(ButtonStyle.Danger), new ButtonBuilder().setCustomId('cta:cancel:' + id).setLabel('ยกเลิก').setStyle(ButtonStyle.Secondary))] });
        return true;
    }
    if (action === 'confirmdelete') {
        const cfg = getConfig(session.guildId, deps), before = cfg.ctaTemplates.length;
        cfg.ctaTemplates = cfg.ctaTemplates.filter(t => String(t.id) !== String(session.pendingDeleteTemplateId || ''));
        if (cfg.ctaTemplates.length === before) { await interaction.update({ content: 'ไม่พบแผนเดิม', components: [] }); return true; }
        deps.saveData(); await interaction.update({ content: '🗑️ ลบแล้ว', components: [] }); sessions.delete(id); return true;
    }
    return false;
}

module.exports = { commandBuilders, handleInteraction, WEAPONS, PRESETS };
