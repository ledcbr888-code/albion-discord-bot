'use strict';

const {
    SlashCommandBuilder, EmbedBuilder, AttachmentBuilder, ActionRowBuilder,
    ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ModalBuilder,
    TextInputBuilder, TextInputStyle, MessageFlags
} = require('discord.js');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
function weaponIconPath(name) {
    if (!name) return null;
    const clean = weaponFileName(name);
    const candidates = [
        path.join(WEAPON_DIR, clean + '.png'),
        path.join(WEAPON_DIR, clean + '.jpg'),
        path.join(WEAPON_DIR, clean + '.webp'),
        path.join(__dirname, 'weapon', clean + '.png'),
    ];
    for (const p of candidates) if (fs.existsSync(p)) return p;
    return null;
}
function tryLoadCanvas() {
    try { return require('canvas'); } catch {}
    try { return require('@napi-rs/canvas'); } catch {}
    return null;
}

// ===== FUZZY SEARCH (Fuse.js style without dependency) =====
function fuzzyScore(target, query) {
    if (!query) return 0;
    const t = target.toLowerCase().replace(/\s+/g, '');
    const q = query.toLowerCase().replace(/\s+/g, '');
    if (!q) return 0;
    // Exact substring = best
    if (t.includes(q)) return q.length * 100 - t.indexOf(q); // longer query + earlier position = better
    // Subsequence check: b-l-a-z in blazing
    let ti = 0, qi = 0, matched = 0, lastPos = -1, gaps = 0;
    while (ti < t.length && qi < q.length) {
        if (t[ti] === q[qi]) {
            if (lastPos !== -1) gaps += ti - lastPos - 1;
            lastPos = ti;
            qi++; matched++;
        }
        ti++;
    }
    if (matched === q.length) {
        // All chars found in order
        return matched * 10 - gaps;
    }
    return null; // no match
}

function weaponOptions(role, page, search) {
    const all = WEAPONS[role] || [];
    if (!search) {
        const currentPage = Math.max(0, page);
        const start = currentPage * 25;
        return { filtered: all, page: currentPage, totalPages: Math.max(1, Math.ceil(all.length / 25)), options: all.slice(start, start + 25).map(name => ({ label: displayWeapon(name), value: name, description: 'เลือก ' + displayWeapon(name) })) };
    }
    // Try Fuse.js if available
    let filtered = [];
    try {
        const Fuse = require('fuse.js');
        const fuse = new Fuse(all.map(n => ({ name: n, display: displayWeapon(n) })), { keys: ['name', 'display'], threshold: 0.4, includeScore: true });
        const results = fuse.search(search);
        filtered = results.map(r => r.item.name);
    } catch {
        // Fallback fuzzy
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

// ---------- Count Panel WITH META WARNINGS ----------
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

    // Small party (gank/small scale) - don't spam missing role warnings
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

    // Balance check only for larger comps
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

// Grid 5 per row - BIGGER separate image (2x size as requested)
async function buildWeaponGridImage(weapons, usedMap, currentRole) {
    const canvasLib = tryLoadCanvas();
    if (!canvasLib) return null;
    const { createCanvas, loadImage } = canvasLib;
    const cols = 5;
    const cellW = 420; // bigger as requested - was 380
    const cellH = 520; // bigger - was 440, to fit name under image
    const padding = 20;
    const headerH = 90;
    const rows = Math.ceil(weapons.length / cols);
    const width = cols * cellW + (cols + 1) * padding;
    const height = headerH + rows * cellH + (rows + 1) * padding;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#232428'; ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#1e1f22'; ctx.fillRect(0, 0, width, headerH);
    ctx.fillStyle = '#ffffff'; ctx.font = 'bold 36px sans-serif';
    ctx.fillText((ROLE_LABELS_SHORT[currentRole] || currentRole) + ' - ' + weapons.length + ' WEAPONS', padding + 12, 58);
    for (let i = 0; i < weapons.length; i++) {
        const col = i % cols; const row = Math.floor(i / cols);
        const x = padding + col * (cellW + padding); const y = headerH + padding + row * (cellH + padding);
        const wName = weapons[i]; const isUsed = usedMap.has(wName);
        ctx.fillStyle = isUsed ? '#3b2f1a' : '#2b2d31'; ctx.fillRect(x, y, cellW, cellH);
        ctx.strokeStyle = isUsed ? '#d9a94a' : '#3f4147'; ctx.lineWidth = isUsed ? 2.4 : 1; ctx.strokeRect(x, y, cellW, cellH);
        if (isUsed) { ctx.fillStyle = 'rgba(217,169,74,0.20)'; ctx.fillRect(x, y, cellW, 26); }
        const iconPath = weaponIconPath(wName);
        const iconSize = 380; // bigger as requested - was 300, now 380
        if (iconPath) {
            try { const img = await loadImage(iconPath); const ix = x + (cellW - iconSize) / 2; const iy = y + 16; ctx.drawImage(img, ix, iy, iconSize, iconSize); } catch { 
                ctx.fillStyle = '#3a3c41'; ctx.fillRect(x + (cellW-200)/2, y + 16, 200, 200);
                ctx.fillStyle = '#ffffff'; ctx.font = 'bold 48px sans-serif'; ctx.textAlign='center'; ctx.fillText('⚔️', x + cellW/2, y + 130); ctx.textAlign='left';
            }
        } else { 
            ctx.fillStyle = '#2b2d31'; ctx.fillRect(x + (cellW-200)/2, y + 16, 200, 200);
            ctx.fillStyle = '#ffffff'; ctx.font = 'bold 48px sans-serif'; ctx.textAlign='center'; ctx.fillText(ROLE_EMOJIS[currentRole] || '⚔️', x + cellW/2, y + 130); ctx.textAlign='left';
        }
        // Draw weapon name UNDER image - bigger and visible with dark bg
        ctx.fillStyle = '#1a1b1e'; ctx.fillRect(x, y + 410, cellW, 70);
        ctx.fillStyle = isUsed ? '#f0c35a' : '#ffffff'; ctx.font = 'bold 22px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText(displayWeapon(wName).slice(0, 20), x + cellW / 2, y + 436, cellW - 14);
        ctx.font = '16px sans-serif'; ctx.fillStyle = isUsed ? '#f0c35a' : '#9ca0a6';
        ctx.fillText(isUsed ? 'PICKED x' + usedMap.get(wName) : 'AVAILABLE', x + cellW / 2, y + 460);
        ctx.textAlign = 'left';
    }
    return canvas.toBuffer('image/png');
}

async function buildRosterSmallIconImage(event) {
    const canvasLib = tryLoadCanvas();
    if (!canvasLib) return null;
    const { createCanvas, loadImage } = canvasLib;
    const slots = event.slots; 
    const rowH = 170; // bigger as requested - was 150
    const width = 1200; // wider for bigger icons - was 1100
    const height = slots.length * rowH + 24;
    const canvas = createCanvas(width, height); const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#2b2d31'; ctx.fillRect(0, 0, width, height);
    for (let i = 0; i < slots.length; i++) {
        const s = slots[i]; const y = i * rowH;
        ctx.fillStyle = i % 2 === 0 ? '#313338' : '#2b2d31'; ctx.fillRect(0, y, width, rowH);
        if (i === 0) { ctx.fillStyle = '#00b0f4'; ctx.fillRect(0, 0, 8, height); }
        const iconX = 18, iconY = y + 14, iconS = 142; // bigger as requested - was 122
        ctx.fillStyle = '#1e1f22'; ctx.fillRect(iconX, iconY, iconS, iconS);
        ctx.strokeStyle = '#3f4147'; ctx.lineWidth = 2; ctx.strokeRect(iconX, iconY, iconS, iconS);
        const iconPath = weaponIconPath(s.weapon);
        if (iconPath) { try { const img = await loadImage(iconPath); ctx.drawImage(img, iconX + 3, iconY + 3, iconS - 6, iconS - 6); } catch { 
            // Fallback to emoji text if image fails
            ctx.fillStyle = '#ffffff'; ctx.font = 'bold 32px sans-serif'; ctx.textAlign='center'; 
            ctx.fillText(ROLE_EMOJIS[s.role] || '⚔️', iconX + iconS/2, iconY + iconS/2 + 10); ctx.textAlign='left';
        } }
        else { 
            // No icon file - use role emoji instead of green square
            ctx.fillStyle = '#2b2d31'; ctx.fillRect(iconX, iconY, iconS, iconS);
            ctx.fillStyle = '#ffffff'; ctx.font = 'bold 36px sans-serif'; ctx.textAlign='center';
            ctx.fillText(ROLE_EMOJIS[s.role] || '⚔️', iconX + iconS/2, iconY + iconS/2 + 12); ctx.textAlign='left';
        }
        if (s.userId) {
            ctx.fillStyle = '#23a559'; ctx.beginPath(); ctx.arc(iconX + iconS + 14, iconY + iconS / 2, 10, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = '#ffffff'; ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('✓', iconX + iconS + 14, iconY + iconS / 2 + 4); ctx.textAlign = 'left';
        }
        ctx.fillStyle = '#f2f3f5'; ctx.font = 'bold 20px sans-serif';
        const roleText = (i + 1) + '. ' + (ROLE_LABELS_SHORT[s.role] || s.role).toUpperCase() + (s.weapon ? ' - ' + displayWeapon(s.weapon) : '');
        ctx.fillText(roleText.slice(0, 60), 110, y + 36);
        if (s.userId) { ctx.fillStyle = '#949ba4'; ctx.font = '15px sans-serif'; ctx.fillText('@' + (s.userName || 'Joined').slice(0, 32), 110, y + 62); }
        else { ctx.fillStyle = '#6d6f78'; ctx.font = '15px sans-serif'; ctx.fillText('Vacant', 110, y + 62); }
    }
    return canvas.toBuffer('image/png');
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
    if (gridBuffer) { const attName = 'weapon-grid-' + session.id + '.png'; files.push(new AttachmentBuilder(gridBuffer, { name: attName })); const gridEmbed = new EmbedBuilder().setColor(0x232428).setTitle((ROLE_LABELS_SHORT[slot.role] || slot.role) + ' - ' + data.filtered.length + ' WEAPONS').setImage('attachment://' + attName).setFooter({ text: 'แยกส่วนรูปออกมาแล้ว - รูปใหญ่ขึ้น | แถวละ 5 รูป' }); return { ...panel, embeds: [infoEmbed, gridEmbed], files, attachments: [] }; }
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
async function publishEvent(session, deps) {
    const channel = await deps.client.channels.fetch(session.channelId).catch(() => null);
    if (!channel || !channel.isTextBased() || !channel.send) throw new Error('ไม่พบห้องข้อความที่ใช้สร้าง CTA');
    const event = {
        id: eventId(), guildId: session.guildId, channelId: session.channelId,
        ownerId: session.userId, title: session.title, startAt: session.startAt,
        maxPlayers: session.slots.length,
        slots: session.slots.map(s => ({ role: s.role, weapon: s.weapon, userId: null, userName: null })),
        createdAt: new Date().toISOString(), messageId: null
    };
    const cfg = getConfig(session.guildId, deps);
    cfg.ctaEvents.push(event); cfg.ctaEvents = cfg.ctaEvents.slice(-MAX_EVENTS); deps.saveData();
    const message = await channel.send({ embeds: [eventEmbed(event)], components: eventButtons(event) });
    event.messageId = message.id; event.rosterMessageIds = [];
    const rosterBatches = await renderRosterBatches(event, deps);
    for (const batch of rosterBatches) event.rosterMessageIds.push((await channel.send(batch)).id);
    deps.saveData(); sessions.delete(session.id); return event;
}
async function refreshEvent(event, deps) {
    const channel = await deps.client.channels.fetch(event.channelId).catch(() => null);
    const message = channel && channel.messages ? await channel.messages.fetch(event.messageId).catch(() => null) : null;
    if (!message) return false;
    await message.edit({ embeds: [eventEmbed(event)], components: eventButtons(event) });
    const batches = await renderRosterBatches(event, deps);
    if (!Array.isArray(event.rosterMessageIds)) event.rosterMessageIds = [];
    for (let i = 0; i < batches.length; i++) {
        const rosterId = event.rosterMessageIds[i];
        const rosterMessage = rosterId && channel.messages ? await channel.messages.fetch(rosterId).catch(() => null) : null;
        if (rosterMessage) await rosterMessage.edit(batches[i]);
        else event.rosterMessageIds[i] = (await channel.send(batches[i])).id;
    }
    for (let i = batches.length; i < event.rosterMessageIds.length; i++) {
        const stale = await channel.messages.fetch(event.rosterMessageIds[i]).catch(() => null);
        if (stale) await stale.delete().catch(() => null);
    }
    event.rosterMessageIds = event.rosterMessageIds.slice(0, batches.length);
    deps.saveData(); return true;
}
function getEvent(guildId, id, deps) { return getConfig(guildId, deps).ctaEvents.find(e => String(e.id) === String(id)); }
function ownerOnly(interaction, session) { return session && String(session.userId) === String(interaction.user.id); }
function searchModal(sessionId, index) {
    const modal = new ModalBuilder().setCustomId('cta:searchsubmit:' + sessionId + ':' + index).setTitle('ค้นหาอาวุธแบบ Fuzzy');
    modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('query').setLabel('พิมพ์เช่น blaz, bracer, carv, blood, clarent').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(40).setPlaceholder('พิมพ์สั้นๆก็เจอ เช่น blaz → Blazing')));
    return modal;
}
function saveModal(sessionId) {
    const modal = new ModalBuilder().setCustomId('cta:savesubmit:' + sessionId).setTitle('บันทึกชุดแผน CTA');
    modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('name').setLabel('ชื่อชุดแผนที่ต้องการบันทึก').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(60)));
    return modal;
}
function reuseModal(sessionId) {
    const modal = new ModalBuilder().setCustomId('cta:upsubmit:' + sessionId).setTitle('สร้าง CTA จากแผนที่บันทึก');
    modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('title').setLabel('ชื่อ CTA รอบนี้').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80)));
    return modal;
}
function utcHourOptions() {
    return Array.from({ length: 24 }, (_, hour) => {
        const value = String(hour).padStart(2, '0') + ':00';
        return { label: value + ' UTC', value, description: 'เวลาเริ่ม UTC' };
    });
}
async function handleInteraction(interaction, deps) {
    const isCommand = interaction.isChatInputCommand && interaction.isChatInputCommand();
    if (isCommand && ['cta', 'ctaup'].includes(interaction.commandName)) {
        if (!interaction.guildId) { await interaction.reply({ content: '❌ ใช้ได้เฉพาะในเซิร์ฟเวอร์', flags: MessageFlags.Ephemeral }); return true; }
        const cfg = getConfig(interaction.guildId, deps);
        if (interaction.commandName === 'cta') {
            const title = safeText(interaction.options.getString('title'), 80);
            const startAt = parseUtc(interaction.options.getString('time_utc'));
            const maxPlayers = interaction.options.getInteger('max_players');
            if (!title || !startAt || startAt <= Date.now()) { await interaction.reply({ content: '❌ ชื่อหรือเวลาไม่ถูกต้อง', flags: MessageFlags.Ephemeral }); return true; }
            const id = token();
            const session = { id, guildId: interaction.guildId, userId: interaction.user.id, channelId: interaction.channelId, title, startAt, maxPlayers, counts: { Tank: 0, DPS: 0, Support: 0, Heal: 0 }, slots: [], slotIndex: 0, page: 0, search: '' };
            sessions.set(id, session);
            await interaction.reply({ ...countPanel(session), flags: MessageFlags.Ephemeral });
            return true;
        }
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
    if (action === 'presetback') {
        await interaction.update(countPanel(session));
        return true;
    }
    if (action === 'preset') {
        const presetKey = parts[3];
        if (presetKey === 'clear') {
            session.counts = { Tank: 0, DPS: 0, Support: 0, Heal: 0 };
            await interaction.update(countPanel(session));
            return true;
        }
        const preset = PRESETS[presetKey];
        if (!preset) { await interaction.reply({ content: 'ไม่พบ Preset', flags: MessageFlags.Ephemeral }); return true; }
        session.counts = { ...preset.counts };
        const total = 1 + ROLE_ORDER.reduce((sum, role) => sum + (Number(session.counts[role]) || 0), 0);
        if (total > session.maxPlayers) {
            await interaction.reply({ content: '⚠️ Preset **' + preset.label + '** รวม Caller = ' + total + ' คน แต่ Party ที่ตั้งไว้สูงสุด ' + session.maxPlayers + ' คน — ระบบจะปรับจำนวน DPS ลงให้พอดี', flags: MessageFlags.Ephemeral });
            const excess = total - session.maxPlayers;
            session.counts.DPS = Math.max(0, (session.counts.DPS || 0) - excess);
        }
        await interaction.update(countPanel(session));
        return true;
    }

    if (action === 'count') {
        const role = parts[3];
        session.counts[role] = Number(interaction.values[0]) || 0;
        await interaction.update(countPanel(session));
        return true;
    }
    if (action === 'countnext') {
        const total = 1 + ROLE_ORDER.reduce((sum, role) => sum + (Number(session.counts[role]) || 0), 0);
        if (total > session.maxPlayers) { await interaction.reply({ content: '❌ เกิน ' + session.maxPlayers, flags: MessageFlags.Ephemeral }); return true; }
        if (total <= 1) { await interaction.reply({ content: '❌ ต้องมีอย่างน้อย 1 ตำแหน่งนอกจาก Caller', flags: MessageFlags.Ephemeral }); return true; }
        session.slots = [{ role: 'Caller', weapon: null }];
        for (const role of ROLE_ORDER) for (let i = 0; i < (Number(session.counts[role]) || 0); i++) session.slots.push({ role, weapon: null });
        session.slotIndex = 0; session.page = 0; session.search = '';
        await interaction.update(await weaponPanelPayload(session));
        return true;
    }
    if (action === 'weapon') {
        const index = Number(parts[3]), slot = session.slots[index];
        if (!slot || index !== session.slotIndex) { await interaction.reply({ content: 'ช่องไม่ตรง', flags: MessageFlags.Ephemeral }); return true; }
        const selected = interaction.values[0];
        slot.weapon = selected; session.slotIndex++; session.page = 0; session.search = '';
        const nextPayload = session.slotIndex >= session.slots.length ? savePrompt(session) : await weaponPanelPayload(session);
        await interaction.update(nextPayload);
        return true;
    }
    if (action === 'search') { await interaction.showModal(searchModal(id, Number(parts[3]))); return true; }
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
