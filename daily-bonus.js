// Daily Bonus automation - isolated from index.js
// Reads only Discord Channel Following webhook posts in the configured inbox.
// All schedule boundaries use Asia/Bangkok (UTC+7).

const {
    SlashCommandBuilder,
    ChannelType,
    PermissionFlagsBits,
    PermissionsBitField,
    EmbedBuilder
} = require('discord.js');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const fs = require('fs');
const path = require('path');

const DAILY_BONUS_INBOX_GUILD_ID = '1165745441120452638';
const DAILY_BONUS_INBOX_CHANNEL_ID = '1508107671662886964';
const DAILY_BONUS_TIME_ZONE = 'Asia/Bangkok';
const DAILY_BONUS_START_MINUTE = 6 * 60;
const DAILY_BONUS_END_MINUTE = 7 * 60 + 10;
const DAILY_BONUS_SCAN_LIMIT = 50;
const DAILY_BONUS_MAX_PROCESSED_IDS = 100;
const DAILY_BONUS_MAX_RETRIES = 3;
const DAILY_BONUS_RETRY_INTERVAL_MS = 30 * 1000;
const DAILY_ASSET_DIR = path.join(__dirname, 'daily');

let windowTimer = null;
let closeTimer = null;
let retryTimer = null;
let scanRunning = false;
const processingMessageIds = new Set();

const commandBuilders = [
    new SlashCommandBuilder()
        .setName('dailybonus')
        .setDescription('Set up the daily Albion bonus report')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand(sub => sub
            .setName('setup')
            .setDescription('Choose where daily bonus reports are posted')
            .addChannelOption(option => option
                .setName('channel')
                .setDescription('Channel for the daily bonus report')
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                .setRequired(true)))
        .addSubcommand(sub => sub
            .setName('remove')
            .setDescription('Disable daily bonus reports in this server'))
        .toJSON()
];

function getBangkokParts(value = Date.now()) {
    const date = new Date(value);
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: DAILY_BONUS_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23'
    }).formatToParts(date);
    const output = {};
    for (const part of parts) {
        if (part.type !== 'literal') output[part.type] = Number(part.value);
    }
    return output;
}

function getBangkokDayKey(value = Date.now()) {
    const p = getBangkokParts(value);
    return String(p.year).padStart(4, '0') + '-' +
        String(p.month).padStart(2, '0') + '-' +
        String(p.day).padStart(2, '0');
}

function getBangkokMinuteOfDay(value = Date.now()) {
    const p = getBangkokParts(value);
    return p.hour * 60 + p.minute;
}

function isInsideDailyWindow(value = Date.now()) {
    const minute = getBangkokMinuteOfDay(value);
    return minute >= DAILY_BONUS_START_MINUTE && minute < DAILY_BONUS_END_MINUTE;
}

function getBangkokBoundaryTimestamp(hour, minute, value = Date.now()) {
    const p = getBangkokParts(value);
    // Asia/Bangkok is UTC+7 and does not observe daylight-saving time.
    return Date.UTC(p.year, p.month - 1, p.day, hour - 7, minute, 0, 0);
}

function getNextWindowStartTimestamp(value = Date.now()) {
    const now = Number(value);
    let target = getBangkokBoundaryTimestamp(6, 0, now);
    if (target <= now) target += 24 * 60 * 60 * 1000;
    return target;
}

function normalizeText(value) {
    return String(value || '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/\u00a0/g, ' ')
        .replace(/[\u200b-\u200f\uFEFF]/g, '')
        .replace(/\r/g, '\n')
        .replace(/\*\*/g, '')
        .replace(/__/g, '')
        .replace(/~~/g, '')
        .replace(new RegExp(String.fromCharCode(96), 'g'), '')
        .trim();
}

function collectMessageText(message) {
    const chunks = [];
    if (message?.content) chunks.push(message.content);
    for (const embed of (message?.embeds || [])) {
        if (embed.title) chunks.push(embed.title);
        if (embed.description) chunks.push(embed.description);
        if (embed.author?.name) chunks.push(embed.author.name);
        for (const field of (embed.fields || [])) {
            if (field.name) chunks.push(field.name);
            if (field.value) chunks.push(field.value);
        }
        if (embed.footer?.text) chunks.push(embed.footer.text);
    }
    return normalizeText(chunks.join('\n'));
}

function getSectionMarker(line) {
    const text = String(line || '').trim();
    if (/^seasonal\s+events\b/i.test(text)) return { key: 'seasonal', remainder: text.replace(/^seasonal\s+events\b/i, '').trim() };
    if (/^activities\b/i.test(text)) return { key: 'activities', remainder: text.replace(/^activities\b/i, '').trim() };
    const gathering = text.match(/^gathering\s+bonus\s*:?\s*(.*)$/i);
    if (gathering) return { key: 'gathering', remainder: gathering[1].trim() };
    if (/^production\s+bonuses\b/i.test(text)) return { key: 'production', remainder: text.replace(/^production\s+bonuses\b/i, '').trim() };
    return null;
}

function parseCountdown(line, baseTimestamp) {
    const text = String(line || '');
    const absolute = text.match(/<t:(\d{9,13})(?::[tTdDfFR])?>/);
    const direction = /\b(starts?|begin(?:s|ning)?|opens?)\b|เริ่ม/i.test(text) ? 'Starts' : 'Ends';
    if (absolute) {
        const raw = Number(absolute[1]);
        const timestamp = raw > 9999999999 ? raw : raw * 1000;
        return Number.isFinite(timestamp) ? { direction, timestamp } : null;
    }

    const durationPattern = /(\d+(?:\.\d+)?)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s|วัน|ชั่วโมง|นาที|วินาที)/gi;
    let match;
    let totalMs = 0;
    while ((match = durationPattern.exec(text)) !== null) {
        const amount = Number(match[1]);
        const unit = String(match[2]).toLowerCase();
        if (!Number.isFinite(amount)) continue;
        if (/^(d|day)/.test(unit) || unit === 'วัน') totalMs += amount * 24 * 60 * 60 * 1000;
        else if (/^(h|hr|hour)/.test(unit) || unit === 'ชั่วโมง') totalMs += amount * 60 * 60 * 1000;
        else if (/^(m|min|minute)/.test(unit) || unit === 'นาที') totalMs += amount * 60 * 1000;
        else totalMs += amount * 1000;
    }
    if (!totalMs) return null;
    return { direction, timestamp: Number(baseTimestamp) + totalMs };
}

function getOriginalMessageTimestamp(message) {
    const originalId = String(message?.reference?.messageId || message?.id || '');
    if (/^\d{17,20}$/.test(originalId)) {
        try {
            return Number((BigInt(originalId) >> 22n) + 1420070400000n);
        } catch (_) {}
    }
    return Number(message?.createdTimestamp) || Date.now();
}

function makeGenericEntries(lines, baseTimestamp, fallbackTitle) {
    const entries = [];
    let current = null;
    for (const rawLine of lines) {
        const line = String(rawLine || '').trim();
        if (!line) continue;
        const countdown = parseCountdown(line, baseTimestamp);
        if (countdown) {
            if (!current) current = { title: fallbackTitle, detail: '', countdown: null };
            current.countdown = countdown;
            continue;
        }
        if (!current || current.countdown) {
            current = { title: line, detail: '', countdown: null };
            entries.push(current);
            continue;
        }
        if (!current.detail) current.detail = line;
        else current.detail += ' ' + line;
    }
    if (current && !entries.includes(current)) entries.push(current);
    return entries.filter(entry => entry.title || entry.detail);
}

function makeProductionEntries(lines, baseTimestamp) {
    const entries = [];
    let current = null;
    for (const rawLine of lines) {
        const line = String(rawLine || '').trim();
        if (!line) continue;
        const item = line.match(/^(.+?)\s*\(\s*([+-]?\d+(?:\.\d+)?\s*%)\s*\)(.*)$/);
        if (item) {
            current = {
                title: item[1].trim(),
                bonus: item[2].replace(/\s+/g, ''),
                detail: '',
                countdown: parseCountdown(item[3], baseTimestamp)
            };
            entries.push(current);
            continue;
        }
        const countdown = parseCountdown(line, baseTimestamp);
        if (countdown) {
            if (!current) current = { title: line.replace(/\b(?:ends?|starts?)\b.*/i, '').trim() || 'Production Bonus', bonus: '', detail: '', countdown: null };
            current.countdown = countdown;
            if (!entries.includes(current)) entries.push(current);
            continue;
        }
        if (!current || current.countdown) {
            current = { title: line, bonus: '', detail: '', countdown: null };
            entries.push(current);
        } else if (!current.bonus && /[+-]?\d+(?:\.\d+)?\s*%/.test(line)) {
            current.bonus = (line.match(/[+-]?\d+(?:\.\d+)?\s*%/) || [''])[0].replace(/\s+/g, '');
        } else {
            current.detail = current.detail ? current.detail + ' ' + line : line;
        }
    }
    return entries.filter(entry => entry.title && entry.bonus);
}

function parseDailyBonusMessage(message) {
    const rawText = collectMessageText(message);
    if (!rawText) return { complete: false, reason: 'Message has no readable content or embeds.' };

    const prepared = rawText
        .replace(/(Seasonal\s+Events|Activities|Gathering\s+Bonus\s*:?\s*[^ \n]+|Gathering\s+Bonus|Production\s+Bonuses)/gi, '\n$1\n')
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);

    const sections = { seasonal: [], activities: [], gathering: [], production: [] };
    let activeSection = null;
    for (const line of prepared) {
        const marker = getSectionMarker(line);
        if (marker) {
            activeSection = marker.key;
            if (marker.remainder) sections[activeSection].push(marker.remainder);
            continue;
        }
        if (activeSection) sections[activeSection].push(line);
    }

    const baseTimestamp = getOriginalMessageTimestamp(message);
    const parsed = {
        seasonal: makeGenericEntries(sections.seasonal, baseTimestamp, 'Seasonal Event'),
        activities: makeGenericEntries(sections.activities, baseTimestamp, 'Activity'),
        gathering: makeGenericEntries(sections.gathering, baseTimestamp, 'Gathering Bonus'),
        production: makeProductionEntries(sections.production, baseTimestamp)
    };
    const missing = ['seasonal', 'activities', 'gathering', 'production'].filter(key =>
        !prepared.some(line => getSectionMarker(line)?.key === key)
    );
    if (missing.length) {
        return { complete: false, reason: 'Missing sections: ' + missing.join(', '), rawText };
    }
    const hasAnyContent = parsed.seasonal.length || parsed.activities.length || parsed.gathering.length || parsed.production.length;
    if (!hasAnyContent) return { complete: false, reason: 'All bonus sections were empty.', rawText };
    const untimed = Object.entries(parsed).flatMap(([section, entries]) =>
        entries.filter(entry => !entry.countdown?.timestamp).map(entry => section + ': ' + (entry.title || 'unnamed entry'))
    );
    if (untimed.length) {
        return { complete: false, reason: 'Missing countdown values: ' + untimed.join('; '), rawText };
    }
    return { complete: true, parsed, rawText, baseTimestamp };
}

function escapeField(value) {
    return String(value || '')
        .replace(/@/g, '@\u200b')
        .replace(/[\\*_~|]/g, '\\$&')
        .replace(new RegExp(String.fromCharCode(96), 'g'), '\\' + String.fromCharCode(96))
        .replace(/\s+/g, ' ')
        .trim();
}

function formatEntry(entry) {
    const title = escapeField(entry.title || 'Bonus');
    const lines = ['**' + title + '**'];
    if (entry.bonus) lines[0] += ' — **' + escapeField(entry.bonus) + '**';
    if (entry.detail) lines.push(escapeField(entry.detail));
    if (entry.countdown?.timestamp && Number.isFinite(entry.countdown.timestamp)) {
        lines.push(entry.countdown.direction + ' <t:' + Math.floor(entry.countdown.timestamp / 1000) + ':R>');
    } else {
        lines.push('Timing not provided');
    }
    return lines.join('\n');
}

function formatSection(entries) {
    if (!entries?.length) return 'No active bonus listed.';
    return entries.map(formatEntry).join('\n\n').slice(0, 1000);
}

function roundedRect(ctx, x, y, width, height, radius, fill, stroke) {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + width - radius, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    ctx.lineTo(x + width, y + height - radius);
    ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    ctx.lineTo(x + radius, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    if (stroke) {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 2;
        ctx.stroke();
    }
}

function findDailyItemImage(itemName) {
    if (!fs.existsSync(DAILY_ASSET_DIR)) return null;
    const target = String(itemName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!target) return null;
    const files = fs.readdirSync(DAILY_ASSET_DIR).filter(file => /\.png$/i.test(file));
    const exact = files.find(file => file.replace(/\.png$/i, '').toLowerCase().replace(/[^a-z0-9]/g, '') === target);
    if (exact) return path.join(DAILY_ASSET_DIR, exact);
    const partial = files.find(file => {
        const name = file.replace(/\.png$/i, '').toLowerCase().replace(/[^a-z0-9]/g, '');
        return name === target || name.startsWith(target) || target.startsWith(name);
    });
    return partial ? path.join(DAILY_ASSET_DIR, partial) : null;
}

async function buildProductionImage(entries) {
    if (!entries?.length) return null;
    const width = 1100;
    const cardWidth = 490;
    const cardHeight = 220;
    const gapX = 24;
    const gapY = 22;
    const rows = Math.ceil(entries.length / 2);
    const height = 150 + rows * cardHeight + (rows - 1) * gapY + 45;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#151b26';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#d7ad62';
    ctx.font = 'bold 24px Arial';
    ctx.fillText('ALBION ONLINE', 42, 42);
    ctx.fillStyle = '#f1f4f8';
    ctx.font = 'bold 38px Arial';
    ctx.fillText('PRODUCTION BONUSES', 42, 91);
    ctx.fillStyle = '#9ca9ba';
    ctx.font = '18px Arial';
    ctx.fillText('Current crafting bonuses', 44, 124);

    for (let index = 0; index < entries.length; index++) {
        const entry = entries[index];
        const column = index % 2;
        const row = Math.floor(index / 2);
        const x = 42 + column * (cardWidth + gapX);
        const y = 155 + row * (cardHeight + gapY);
        roundedRect(ctx, x, y, cardWidth, cardHeight, 20, '#242d3a', '#4c5b70');
        roundedRect(ctx, x + 18, y + 20, 150, 150, 16, '#303c4d', '#66768d');

        const imagePath = findDailyItemImage(entry.title);
        if (imagePath) {
            try {
                const icon = await loadImage(imagePath);
                const scale = Math.min(118 / icon.width, 118 / icon.height);
                const drawWidth = icon.width * scale;
                const drawHeight = icon.height * scale;
                ctx.drawImage(icon, x + 93 - drawWidth / 2, y + 95 - drawHeight / 2, drawWidth, drawHeight);
            } catch (err) {
                console.warn('⚠️ Daily Bonus item image load failed for ' + entry.title + ': ' + err.message);
            }
        } else {
            ctx.fillStyle = '#b8c3d1';
            ctx.font = 'bold 44px Arial';
            ctx.textAlign = 'center';
            ctx.fillText(String(entry.title || '?').slice(0, 2).toUpperCase(), x + 93, y + 105);
            ctx.textAlign = 'left';
            console.warn('⚠️ Daily Bonus image not found in daily/: ' + entry.title);
        }

        ctx.fillStyle = '#f1f4f8';
        ctx.font = 'bold 31px Arial';
        ctx.fillText(String(entry.title || 'Bonus').slice(0, 22), x + 190, y + 63, 275);
        ctx.fillStyle = '#71d39a';
        ctx.font = 'bold 48px Arial';
        ctx.fillText(String(entry.bonus || 'BONUS'), x + 190, y + 123, 270);
        ctx.fillStyle = '#aab6c6';
        ctx.font = 'bold 13px Arial';
        ctx.fillText('PRODUCTION BONUS', x + 192, y + 157);
    }
    ctx.fillStyle = '#8896a9';
    ctx.font = '16px Arial';
    ctx.textAlign = 'center';
    ctx.fillText('Daily bonuses • Albion Online Asia', width / 2, height - 20);
    return canvas.toBuffer('image/png');
}

async function buildReportPayload(parsed, dayKey, sourceMessageId) {
    const embed = new EmbedBuilder()
        .setColor(0xC9A45C)
        .setTitle('ALBION ONLINE • DAILY BONUS')
        .setDescription('Daily events and bonuses for the Asia server.')
        .addFields(
            { name: 'SEASONAL EVENTS', value: formatSection(parsed.seasonal), inline: false },
            { name: 'ACTIVITIES', value: formatSection(parsed.activities), inline: false },
            { name: 'GATHERING BONUS', value: formatSection(parsed.gathering), inline: false },
            { name: 'PRODUCTION BONUSES', value: formatSection(parsed.production), inline: false }
        )
        .setFooter({ text: 'ASIA SERVER • ' + dayKey + ' ICT • Source message ' + sourceMessageId })
        .setTimestamp(new Date());

    const imageBuffer = await buildProductionImage(parsed.production);
    const files = [];
    if (imageBuffer) {
        embed.setImage('attachment://daily-production-bonuses.png');
        files.push({ attachment: imageBuffer, name: 'daily-production-bonuses.png' });
    }
    return { embeds: [embed], files, allowedMentions: { parse: [] } };
}

function getDailyState(deps) {
    const inboxConfig = deps.getGuildConfig(DAILY_BONUS_INBOX_GUILD_ID, true);
    if (!inboxConfig.dailyBonusState || typeof inboxConfig.dailyBonusState !== 'object') {
        inboxConfig.dailyBonusState = { completedDate: null, processedSourceMessageIds: [], days: {} };
    }
    if (!Array.isArray(inboxConfig.dailyBonusState.processedSourceMessageIds)) {
        inboxConfig.dailyBonusState.processedSourceMessageIds = [];
    }
    if (!inboxConfig.dailyBonusState.days || typeof inboxConfig.dailyBonusState.days !== 'object') {
        inboxConfig.dailyBonusState.days = {};
    }
    return inboxConfig.dailyBonusState;
}

function pruneDailyState(state) {
    const keys = Object.keys(state.days || {}).sort();
    for (const key of keys.slice(0, Math.max(0, keys.length - 14))) delete state.days[key];
    state.processedSourceMessageIds = state.processedSourceMessageIds.slice(-DAILY_BONUS_MAX_PROCESSED_IDS);
}

function getConfiguredDestinations(deps) {
    return deps.getAllGuildConfigs()
        .filter(item => item?.config?.dailyBonusReportChannelId)
        .map(item => ({
            guildId: String(item.guildId),
            channelId: String(item.config.dailyBonusReportChannelId),
            config: item.config
        }));
}

function addOldReportReference(config, channelId, messageId) {
    if (!channelId || !messageId) return;
    if (!Array.isArray(config.dailyBonusOldReports)) config.dailyBonusOldReports = [];
    const key = String(channelId) + ':' + String(messageId);
    if (!config.dailyBonusOldReports.some(item => String(item.channelId) + ':' + String(item.messageId) === key)) {
        config.dailyBonusOldReports.push({ channelId: String(channelId), messageId: String(messageId) });
    }
}

async function deleteOldReports(config, client, deps, guildId) {
    const pending = Array.isArray(config.dailyBonusOldReports) ? [...config.dailyBonusOldReports] : [];
    const remaining = [];
    for (const item of pending) {
        try {
            const channel = await client.channels.fetch(String(item.channelId)).catch(() => null);
            if (!channel?.messages?.delete) {
                remaining.push(item);
                continue;
            }
            await channel.messages.delete(String(item.messageId));
        } catch (err) {
            if (Number(err?.code) === 10008 || Number(err?.status) === 404) continue;
            remaining.push(item);
            console.warn('⚠️ Daily Bonus could not delete previous report in guild ' + guildId + ': ' + err.message);
        }
    }
    config.dailyBonusOldReports = remaining;
    deps.saveData();
}

async function sendToDestination(destination, payload, client, deps, dayState) {
    const { guildId, channelId, config } = destination;
    if (!dayState.sentByGuild || typeof dayState.sentByGuild !== 'object') dayState.sentByGuild = {};
    if (dayState.sentByGuild[guildId]?.messageId) return true;

    const attempts = Number(dayState.deliveryAttemptsByGuild?.[guildId]) || 0;
    if (attempts >= DAILY_BONUS_MAX_RETRIES) {
        console.warn('⚠️ Daily Bonus delivery retry limit reached for guild ' + guildId);
        return false;
    }
    if (!dayState.deliveryAttemptsByGuild || typeof dayState.deliveryAttemptsByGuild !== 'object') dayState.deliveryAttemptsByGuild = {};
    dayState.deliveryAttemptsByGuild[guildId] = attempts + 1;
    deps.saveData();

    try {
        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (!channel?.isTextBased?.() || String(channel.guildId || '') !== guildId) {
            throw new Error('Configured report channel is unavailable or belongs to another server.');
        }
        const sent = await channel.send(payload);

        addOldReportReference(config, config.dailyBonusLastReportChannelId, config.dailyBonusLastReportMessageId);
        config.dailyBonusLastReportChannelId = channelId;
        config.dailyBonusLastReportMessageId = String(sent.id);
        dayState.sentByGuild[guildId] = {
            channelId,
            messageId: String(sent.id),
            sentAt: Date.now()
        };
        deps.saveData();
        await deleteOldReports(config, client, deps, guildId);
        console.log('✅ Daily Bonus report sent: guild=' + guildId + ' channel=' + channelId + ' message=' + sent.id);
        return true;
    } catch (err) {
        console.error('❌ Daily Bonus report delivery failed for guild ' + guildId + ': ' + err.message);
        return false;
    }
}

async function processSourceMessage(message, deps) {
    const dayKey = getBangkokDayKey();
    if (!isInsideDailyWindow()) return 'outside-window';
    const state = getDailyState(deps);
    if (state.completedDate === dayKey) return 'complete';
    const messageId = String(message?.id || '');
    if (!messageId || processingMessageIds.has(messageId)) return 'busy';
    const previousDayState = state.days[dayKey];
    if (previousDayState?.sourceMessageId && previousDayState.sourceMessageId !== messageId) {
        return previousDayState.status === 'complete' ? 'complete' : 'pending';
    }

    processingMessageIds.add(messageId);
    try {
        const result = parseDailyBonusMessage(message);
        if (!result.complete) {
            console.warn('⚠️ Daily Bonus source message is incomplete (' + messageId + '): ' + result.reason);
            return 'incomplete';
        }

        let dayState = state.days[dayKey];
        if (!dayState) {
            dayState = {
                sourceMessageId: messageId,
                status: 'processing',
                sentByGuild: {},
                deliveryAttemptsByGuild: {},
                updatedAt: Date.now()
            };
            state.days[dayKey] = dayState;
        }
        dayState.sourceMessageId = messageId;
        dayState.status = 'processing';
        dayState.updatedAt = Date.now();
        pruneDailyState(state);
        deps.saveData();

        const destinations = getConfiguredDestinations(deps);
        if (!destinations.length) {
            dayState.status = 'pending-no-destination';
            dayState.updatedAt = Date.now();
            deps.saveData();
            console.warn('⚠️ Daily Bonus received a valid announcement, but no server has run /dailybonus setup yet.');
            return 'pending';
        }

        const payload = await buildReportPayload(result.parsed, dayKey, messageId);
        let allDelivered = true;
        for (const destination of destinations) {
            if (dayState.sentByGuild?.[destination.guildId]?.messageId) continue;
            const sent = await sendToDestination(destination, payload, deps.client, deps, dayState);
            if (!sent) allDelivered = false;
        }

        if (allDelivered) {
            dayState.status = 'complete';
            dayState.updatedAt = Date.now();
            state.completedDate = dayKey;
            state.processedSourceMessageIds = [...new Set([
                ...(state.processedSourceMessageIds || []),
                messageId
            ])].slice(-DAILY_BONUS_MAX_PROCESSED_IDS);
            pruneDailyState(state);
            deps.saveData();
            console.log('✅ Daily Bonus daily cycle completed for ' + dayKey + ' (Asia/Bangkok).');
            return 'complete';
        }

        dayState.status = 'delivery-pending';
        dayState.updatedAt = Date.now();
        deps.saveData();
        scheduleDeliveryRetry(message, deps, dayKey);
        return 'pending';
    } catch (err) {
        console.error('❌ Daily Bonus processing error for message ' + messageId + ': ' + err.message);
        const dayState = state.days[dayKey];
        if (dayState) {
            dayState.status = 'processing-failed';
            dayState.updatedAt = Date.now();
            deps.saveData();
        }
        scheduleDeliveryRetry(message, deps, dayKey);
        return 'pending';
    } finally {
        processingMessageIds.delete(messageId);
    }
}

function scheduleDeliveryRetry(message, deps, dayKey) {
    if (retryTimer || !isInsideDailyWindow()) return;
    const dayState = getDailyState(deps).days[dayKey];
    if (!dayState) return;
    const retryCount = Number(dayState.processingRetryCount) || 0;
    if (retryCount >= DAILY_BONUS_MAX_RETRIES) {
        console.warn('⚠️ Daily Bonus processing retry limit reached for ' + dayKey);
        return;
    }
    dayState.processingRetryCount = retryCount + 1;
    deps.saveData();
    retryTimer = setTimeout(async () => {
        retryTimer = null;
        if (!isInsideDailyWindow() || getBangkokDayKey() !== dayKey) return;
        await processSourceMessage(message, deps);
    }, DAILY_BONUS_RETRY_INTERVAL_MS);
    retryTimer.unref?.();
}

async function scanInboxOnce(deps) {
    if (scanRunning || !isInsideDailyWindow()) return;
    scanRunning = true;
    try {
        const channel = await deps.client.channels.fetch(DAILY_BONUS_INBOX_CHANNEL_ID).catch(() => null);
        if (!channel?.messages?.fetch) {
            console.warn('⚠️ Daily Bonus inbox unavailable: ' + DAILY_BONUS_INBOX_CHANNEL_ID);
            return;
        }
        const me = channel.guild?.members?.me || await channel.guild?.members?.fetchMe?.().catch(() => null);
        const permissions = channel.permissionsFor?.(me || deps.client.user);
        const missing = permissions
            ? permissions.missing([PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory])
            : [];
        if (missing.length) {
            console.warn('⚠️ Daily Bonus inbox missing permissions: ' + missing.join(', '));
            return;
        }

        const fetched = await channel.messages.fetch({ limit: DAILY_BONUS_SCAN_LIMIT, cache: false });
        const today = getBangkokDayKey();
        const candidates = [...fetched.values()]
            .filter(message =>
                String(message.channelId) === DAILY_BONUS_INBOX_CHANNEL_ID &&
                Boolean(message.webhookId) &&
                getBangkokDayKey(message.createdTimestamp || Date.now()) === today
            )
            .sort((a, b) => Number(a.createdTimestamp || 0) - Number(b.createdTimestamp || 0));

        for (const message of candidates) {
            const result = await processSourceMessage(message, deps);
            if (result === 'complete' || result === 'pending' || result === 'busy') break;
        }
    } catch (err) {
        console.error('❌ Daily Bonus one-time inbox scan failed: ' + err.message);
    } finally {
        scanRunning = false;
    }
}

function scheduleNextDailyWindow(deps) {
    if (windowTimer) clearTimeout(windowTimer);
    if (closeTimer) clearTimeout(closeTimer);
    const now = Date.now();
    const minute = getBangkokMinuteOfDay(now);
    if (minute >= DAILY_BONUS_START_MINUTE && minute < DAILY_BONUS_END_MINUTE) {
        openDailyWindow(deps);
        const closeAt = getBangkokBoundaryTimestamp(7, 10, now);
        closeTimer = setTimeout(() => {
            console.log('🕖 Daily Bonus detection window closed at 07:10 Asia/Bangkok.');
            scheduleNextDailyWindow(deps);
        }, Math.max(1000, closeAt - now));
        closeTimer.unref?.();
        return;
    }
    const nextStart = getNextWindowStartTimestamp(now);
    windowTimer = setTimeout(() => {
        openDailyWindow(deps);
        const closeAt = getBangkokBoundaryTimestamp(7, 10, Date.now());
        closeTimer = setTimeout(() => {
            console.log('🕖 Daily Bonus detection window closed at 07:10 Asia/Bangkok.');
            scheduleNextDailyWindow(deps);
        }, Math.max(1000, closeAt - Date.now()));
        closeTimer.unref?.();
    }, Math.max(1000, nextStart - now));
    windowTimer.unref?.();
    console.log('⏰ Daily Bonus next detection window: 06:00–07:10 Asia/Bangkok.');
}

function openDailyWindow(deps) {
    if (!isInsideDailyWindow()) return;
    console.log('🟢 Daily Bonus detection window opened for ' + getBangkokDayKey() + ' (06:00–07:10 ICT).');
    scanInboxOnce(deps).catch(err => console.error('❌ Daily Bonus scan error: ' + err.message));
}

async function onReady(deps) {
    try {
        const channel = await deps.client.channels.fetch(DAILY_BONUS_INBOX_CHANNEL_ID).catch(() => null);
        if (!channel) {
            console.warn('⚠️ Daily Bonus inbox channel not found. Check the hard-coded channel ID and bot access.');
        } else if (String(channel.guildId || '') !== DAILY_BONUS_INBOX_GUILD_ID) {
            console.error('❌ Daily Bonus inbox guild mismatch. Expected ' + DAILY_BONUS_INBOX_GUILD_ID + ', got ' + String(channel.guildId || 'unknown'));
        } else {
            console.log('📥 Daily Bonus inbox ready: guild=' + DAILY_BONUS_INBOX_GUILD_ID + ' channel=' + DAILY_BONUS_INBOX_CHANNEL_ID);
        }
    } catch (err) {
        console.warn('⚠️ Daily Bonus inbox check failed: ' + err.message);
    }
    scheduleNextDailyWindow(deps);
}

async function handleMessage(message, deps) {
    if (String(message?.channelId || message?.channel?.id || '') !== DAILY_BONUS_INBOX_CHANNEL_ID) return false;
    if (String(message.guildId || message.guild?.id || '') !== DAILY_BONUS_INBOX_GUILD_ID) return true;
    if (!message.webhookId || String(message.author?.id || '') === String(deps.client.user?.id || '')) return true;
    if (!isInsideDailyWindow()) return true;
    if (getDailyState(deps).completedDate === getBangkokDayKey()) return true;
    await processSourceMessage(message, deps);
    return true;
}

async function handleInteraction(interaction, deps) {
    if (!interaction?.isChatInputCommand?.() || interaction.commandName !== 'dailybonus') return false;
    if (!interaction.guildId) {
        await interaction.reply({ content: '❌ This command can only be used in a server.', ephemeral: true });
        return true;
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        await interaction.reply({ content: '❌ You need the Manage Server permission to use this command.', ephemeral: true });
        return true;
    }

    const subcommand = interaction.options.getSubcommand();
    const config = deps.getGuildConfig(interaction.guildId, true);

    if (subcommand === 'setup') {
        const channel = interaction.options.getChannel('channel');
        if (!channel?.isTextBased?.() || !channel.guildId || String(channel.guildId) !== String(interaction.guildId)) {
            await interaction.reply({ content: '❌ Please choose a text channel in this server.', ephemeral: true });
            return true;
        }
        if (String(channel.id) === DAILY_BONUS_INBOX_CHANNEL_ID) {
            await interaction.reply({ content: '❌ The inbox channel cannot also be the report channel. Choose a separate channel.', ephemeral: true });
            return true;
        }
        const me = interaction.guild?.members?.me || await interaction.guild?.members?.fetchMe?.().catch(() => null);
        const permissions = channel.permissionsFor?.(me || deps.client.user);
        const required = [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.EmbedLinks,
            PermissionsBitField.Flags.AttachFiles
        ];
        const missing = permissions ? permissions.missing(required) : required;
        if (missing.length) {
            await interaction.reply({ content: '❌ The bot is missing permissions in <#' + channel.id + '>: ' + missing.join(', '), ephemeral: true });
            return true;
        }

        config.dailyBonusReportChannelId = String(channel.id);
        deps.saveData();
        await interaction.reply({
            content: '✅ Daily Bonus reporting is enabled. Reports will be posted in <#' + channel.id + '> during 06:00–07:10 Asia/Bangkok. The inbox channel is configured internally.',
            ephemeral: true
        });
        if (isInsideDailyWindow()) await scanInboxOnce(deps);
        return true;
    }

    if (subcommand === 'remove') {
        if (!config.dailyBonusReportChannelId) {
            await interaction.reply({ content: 'ℹ️ Daily Bonus reporting is not configured in this server.', ephemeral: true });
            return true;
        }
        delete config.dailyBonusReportChannelId;
        deps.saveData();
        await interaction.reply({ content: '🗑️ Daily Bonus reporting has been disabled in this server.', ephemeral: true });
        return true;
    }

    await interaction.reply({ content: '❌ Unknown Daily Bonus command.', ephemeral: true });
    return true;
}

module.exports = {
    commandBuilders,
    onReady,
    handleMessage,
    handleInteraction,
    _test: {
        getBangkokDayKey,
        getBangkokMinuteOfDay,
        isInsideDailyWindow,
        parseDailyBonusMessage,
        collectMessageText
    }
};
