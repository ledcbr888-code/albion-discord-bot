'use strict';
const { createHash } = require('node:crypto');
const POLL_MS = 30000;
const TIMEOUT_MS = 8000;
const SNAPSHOT_SYNC_INTERVAL_MS = 5 * 60 * 1000;
const EVENT_POLL_SUCCESS_LOG_INTERVAL_MS = 5 * 60 * 1000;
const RETRY_BASE_MS = 30 * 1000;
const RETRY_MAX_MS = 5 * 60 * 1000;
const MAX_DELIVERIES = 2000;
const MAX_PENDING_EVENTS = 2000;
const MAX_PENDING_RETRIES_PER_TICK = 10;
const PENDING_EVENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
function normalizeName(value) {
  return String(value == null ? '' : value).normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}
function validDiscordServerId(value) {
  return /^\d{17,20}$/.test(String(value == null ? '' : value).trim());
}
function getEntityId(value) {
  if (!value || typeof value !== 'object') return null;
  const id = String(value.id ?? value.guildId ?? value.guild_id ?? value.entityId ?? value.entity_id ?? '').trim();
  return /^[A-Za-z0-9_-]{1,80}$/.test(id) ? id : null;
}
function buildTrackedItems(config = {}) {
  const items = new Map();
  const autoBattles = Array.isArray(config.autoBattles) ? config.autoBattles : [];
  for (const raw of (Array.isArray(config.guilds) ? config.guilds : [])) {
    const name = typeof raw === 'string' ? raw : raw && (raw.name ?? raw.guildName ?? raw.guild_name);
    const clean = String(name == null ? '' : name).trim().replace(/\s+/g, ' ');
    if (!clean) continue;
    const key = 'guild:' + normalizeName(clean);
    const matching = autoBattles.find(item => normalizeName(item && (item.targetGuild || item.targetGuildName)) === normalizeName(clean));
    const id = getEntityId(raw) || getEntityId({ id: matching && (matching.targetGuildId || matching.guildId) });
    items.set(key, { type: 'guild', name: clean, id: id || (items.get(key) && items.get(key).id) || null });
  }
  for (const raw of (Array.isArray(config.players) ? config.players : [])) {
    const name = typeof raw === 'string' ? raw : raw && (raw.name ?? raw.playerName ?? raw.player_name);
    const clean = String(name == null ? '' : name).trim().replace(/\s+/g, ' ');
    if (!clean) continue;
    const key = 'player:' + normalizeName(clean);
    items.set(key, { type: 'player', name: clean, id: getEntityId(raw) || (items.get(key) && items.get(key).id) || null });
  }
  return [...items.values()].sort((a, b) => a.type.localeCompare(b.type) || normalizeName(a.name).localeCompare(normalizeName(b.name)));
}
function getBattleGuilds(detail) {
  const source = detail && detail.guilds;
  if (!source || typeof source !== 'object') return [];
  const entries = Array.isArray(source) ? source.map((value, index) => [String(index), value]) : Object.entries(source);
  return entries.map(([key, guild]) => ({
    id: String((guild && (guild.id || guild.guildId || guild.guild_id)) || key),
    name: String((guild && (guild.name || guild.guildName)) || '').trim(),
  })).filter(guild => guild.name);
}
function targetGuildMatches(config, detail, event) {
  const targetId = String(config && (config.targetGuildId || config.guildId) || '').trim();
  const targetName = normalizeName(config && (config.targetGuild || config.targetGuildName));
  if (!targetId && !targetName) return true;
  const matches = Array.isArray(event && event.matches) ? event.matches : [];
  if (matches.some(match => match && match.type === 'guild' &&
    ((targetId && String(match.id || match.resolvedEntityId || '') === targetId) ||
     (targetName && normalizeName(match.name) === targetName)))) return true;
  return getBattleGuilds(detail).some(guild =>
    (targetId && guild.id === targetId) || (targetName && normalizeName(guild.name) === targetName));
}
function evaluateAutoBattleRoutes(routes, report, detail, event) {
  const trackedFame = Number(report && report.totalFame) || 0;
  const detailGuilds = getBattleGuilds(detail);
  const eventGuilds = (Array.isArray(event && event.matches) ? event.matches : [])
    .filter(match => match && match.type === 'guild')
    .map(match => ({
      id: String(match.id || match.resolvedEntityId || ''),
      name: String(match.name || '').trim(),
    }));
  const battleGuilds = [...detailGuilds, ...eventGuilds];

  return (Array.isArray(routes) ? routes : []).map(route => {
    const targetId = String(route && (route.targetGuildId || route.guildId) || '').trim();
    const targetName = String(route && (route.targetGuild || route.targetGuildName) || '').trim();
    const normalizedTargetName = normalizeName(targetName);
    const matchedGuild = battleGuilds.find(guild =>
      (targetId && String(guild.id || '') === targetId) ||
      (normalizedTargetName && normalizeName(guild.name) === normalizedTargetName)
    );
    const resolvedName = String(matchedGuild && matchedGuild.name || targetName).trim();
    const configuredThreshold = Number(route && route.minFrames);
    const minFame = Number.isFinite(configuredThreshold) ? Math.max(0, configuredThreshold) : 0;

    // minFrames is evaluated against the total Fame of all tracked participants.
    // Each route is evaluated independently so only routes that pass are shown.
    return {
      route,
      targetGuild: resolvedName || targetId || 'Tracked Battle',
      totalFame: trackedFame,
      minFame,
      eligible: trackedFame >= minFame,
    };
  });
}
function deliveryKey(battleId, channelId) { return String(battleId) + ':' + String(channelId); }
function deliveryNonce(battleId, channelId, partNumber) {
  return createHash('sha256')
    .update(String(battleId) + ':' + String(channelId) + ':' + String(Number(partNumber) || 1))
    .digest('hex').slice(0, 24);
}
function snapshotFingerprint(items) {
  return JSON.stringify((Array.isArray(items) ? items : []).map(item => [
    String(item && item.type || ''),
    normalizeName(item && item.name),
    item && item.id ? String(item.id) : null,
  ]));
}
function hasTrackedSnapshotChanged(state = {}, items = []) {
  return state.snapshotInitialized !== true || state.snapshotFingerprint !== snapshotFingerprint(items);
}
function isSnapshotSyncDue(state = {}, items = [], now = Date.now()) {
  if (hasTrackedSnapshotChanged(state, items)) return true;
  const lastSync = Date.parse(state.lastSnapshotSyncAt || '');
  return !Number.isFinite(lastSync) || now - lastSync >= SNAPSHOT_SYNC_INTERVAL_MS;
}
function retryDelayMs(failureCount) {
  const count = Math.max(1, Math.min(10, Number(failureCount) || 1));
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * (2 ** (count - 1)));
}
function needsEmptySnapshotCleanup(state = {}) {
  return state.snapshotInitialized === true && state.snapshotFingerprint !== snapshotFingerprint([]);
}

function timestampMs(value) {
  if (value instanceof Date) {
    const valueMs = value.getTime();
    return Number.isFinite(valueMs) && valueMs > 0 ? valueMs : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const normalized = value < 1e12 ? value * 1000 : value;
    return normalized > 0 ? normalized : null;
  }
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return null;
  if (/^(?:\d{10}|\d{13})$/.test(raw)) {
    const numeric = Number(raw);
    const normalized = numeric < 1e12 ? numeric * 1000 : numeric;
    return Number.isFinite(normalized) && normalized > 0 ? normalized : null;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
function formatThaiDuration(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs < 0) return 'คำนวณไม่ได้';
  if (durationMs < 1000) return 'น้อยกว่า 1 วินาที';
  let seconds = Math.floor(durationMs / 1000);
  const days = Math.floor(seconds / 86400);
  seconds %= 86400;
  const hours = Math.floor(seconds / 3600);
  seconds %= 3600;
  const minutes = Math.floor(seconds / 60);
  seconds %= 60;
  const parts = [];
  if (days) parts.push(days + ' วัน');
  if (hours) parts.push(hours + ' ชั่วโมง');
  if (minutes) parts.push(minutes + ' นาที');
  if (seconds || !parts.length) parts.push(seconds + ' วินาที');
  return parts.join(' ');
}

function formatThaiTimestamp(value) {
  const valueMs = timestampMs(value);
  if (valueMs === null) return 'ไม่มีข้อมูล';
  const date = new Date(valueMs);
  const thai = new Intl.DateTimeFormat('th-TH', {
    timeZone: 'Asia/Bangkok', calendar: 'gregory',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(date);
  return thai + ' น. (UTC ' + date.toISOString() + ')';
}
function elapsedMsBetween(startValue, endValue = new Date()) {
  const startMs = timestampMs(startValue);
  const endMs = timestampMs(endValue);
  return startMs === null || endMs === null || endMs < startMs ? null : endMs - startMs;
}
function formatPreciseDuration(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs < 0) return 'คำนวณไม่ได้';
  if (durationMs < 1000) return Math.round(durationMs) + ' ms';
  if (durationMs < 10000) return (durationMs / 1000).toFixed(2) + ' วินาที';
  return formatThaiDuration(durationMs);
}
function formatElapsedMs(value) {
  return value === null || value === undefined ? 'ไม่มีข้อมูล' : formatPreciseDuration(value);
}
function getReportFileLogDetails(file, partNumber) {
  if (!file) return ' | รายการ=ข้อความรายงาน';
  const attachment = file && file.attachment;
  const name = file.name || file.filename ||
    (attachment && (attachment.name || attachment.filename)) ||
    ('ไฟล์แนบ ' + partNumber);
  let size = null;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(file)) size = file.length;
  else if (typeof Buffer !== 'undefined' && Buffer.isBuffer(attachment)) size = attachment.length;
  else if (Number.isFinite(Number(file.size))) size = Number(file.size);
  else if (attachment && Number.isFinite(Number(attachment.size))) size = Number(attachment.size);
  return ' | รายการ=' + String(name).slice(0, 100) +
    (size !== null && size > 0 ? ' | ขนาด=' + size + ' bytes' : '');
}

function getBattleDelayMetrics(event, detail, completedAt = new Date()) {
  const completedAtMs = timestampMs(completedAt);
  const startedAtMs = timestampMs(event && event.battle_start_time)
    ?? timestampMs(detail && detail.startTime);
  const endedAtMs = timestampMs(detail && detail.endTime);
  const elapsed = (fromMs) => fromMs !== null && completedAtMs !== null && completedAtMs >= fromMs
    ? completedAtMs - fromMs
    : null;
  return {
    fromBattleStartMs: elapsed(startedAtMs),
    fromBattleEndMs: endedAtMs !== null && (startedAtMs === null || endedAtMs >= startedAtMs)
      ? elapsed(endedAtMs)
      : null,
    battleStartTime: startedAtMs === null ? null : new Date(startedAtMs).toISOString(),
    battleEndTime: endedAtMs === null ? null : new Date(endedAtMs).toISOString(),
  };
}
function formatBattleDelayLines(event, detail, completedAt) {
  const metrics = getBattleDelayMetrics(event, detail, completedAt);
  return [
    '⏱️ ตั้งแต่ Battle เริ่มจนส่งรายงานครบ: ' +
      (metrics.fromBattleStartMs === null ? 'ไม่มีข้อมูลเวลาเริ่มที่ใช้คำนวณได้' : formatThaiDuration(metrics.fromBattleStartMs)),
    '⏱️ หลัง Battle จบจนส่งรายงานครบ: ' +
      (metrics.fromBattleEndMs === null ? 'ไม่มีข้อมูลเวลาจบที่ใช้คำนวณได้' : formatThaiDuration(metrics.fromBattleEndMs)),
  ];
}

function createBattleboardIntegration(deps = {}) {
  const client = deps.client;
  const getAllGuildConfigs = deps.getAllGuildConfigs;
  const getGuildConfig = deps.getGuildConfig;
  const saveData = deps.saveData;
  const buildBattleReportPayload = deps.buildBattleReportPayload;
  const formatFame = deps.formatFame || (value => Number(value || 0).toLocaleString());
  const onServerAvailabilityChange = typeof deps.onServerAvailabilityChange === 'function'
    ? deps.onServerAvailabilityChange : () => {};
  const isBattleProcessed = typeof deps.isBattleProcessed === 'function'
    ? deps.isBattleProcessed : () => false;
  const markBattleProcessed = typeof deps.markBattleProcessed === 'function'
    ? deps.markBattleProcessed : () => {};
  const activeServerIds = new Set();
  const SERVER_FAILURES_BEFORE_FAILOVER = 3;
  let started = false;
  let running = false;
  let timer = null;

  function notifyServerAvailability(serverId, active, details = {}) {
    try { onServerAvailabilityChange(String(serverId), active === true, details); }
    catch (error) {
      console.error('❌ [Battleboard] Source handoff callback failed | Discord Server=' +
        String(serverId) + ' | Error=' + String(error && error.message || error).slice(0, 180));
    }
  }
  function hasPartialDelivery(state = {}) {
    return (Array.isArray(state.delivered) ? state.delivered : []).some(record =>
      record && record.status !== 'sent' && Number(record.partsSent) > 0
    );
  }

  function getApiConfig() {
    const baseUrl = String(process.env.BATTLEBOARD_API_URL || '').trim().replace(/\/+$/, '');
    const apiKey = String(process.env.BOT_API_KEY || '').trim();
    if (!baseUrl || apiKey.length < 32) return null;
    try { if (new URL(baseUrl).protocol !== 'https:') return null; } catch { return null; }
    return { baseUrl, apiKey };
  }
  function isConfigured() { return Boolean(getApiConfig()); }
  async function request(path, options = {}) {
    const config = getApiConfig();
    if (!config) throw new Error('Battleboard API credentials are not configured.');
    const response = await fetch(config.baseUrl + path, {
      method: options.method || 'GET',
      headers: {
        Authorization: 'Bearer ' + config.apiKey,
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const bodyText = await response.text();
    let data = {};
    if (bodyText) {
      try { data = JSON.parse(bodyText); } catch { data = { error: 'Invalid JSON response.' }; }
    }
    if (!response.ok) {
      const error = new Error('Battleboard API HTTP ' + response.status + (data.error ? ': ' + String(data.error).slice(0, 160) : ''));
      error.status = response.status;
      throw error;
    }
    return data;
  }
  function persist() {
    try { if (typeof saveData === 'function') saveData(); }
    catch (error) { console.error('❌ [Battleboard] Could not persist state:', error.message); }
  }
  function getState(config) {
    if (!config.battleboardState || typeof config.battleboardState !== 'object') config.battleboardState = {};
    if (!Array.isArray(config.battleboardState.delivered)) config.battleboardState.delivered = [];
    if (!Array.isArray(config.battleboardState.pendingEvents)) config.battleboardState.pendingEvents = [];
    return config.battleboardState;
  }
  function findDelivery(state, key) { return state.delivered.find(item => item && item.key === key) || null; }
  function saveDelivery(state, record) {
    const prior = findDelivery(state, record.key);
    if (prior) Object.assign(prior, record);
    else state.delivered.push(record);
    if (state.delivered.length > MAX_DELIVERIES) state.delivered.splice(0, state.delivered.length - MAX_DELIVERIES);
    persist();
  }
  async function syncSnapshot(serverId, state, items) {
    if (!isSnapshotSyncDue(state, items)) return false;
    const trackedSnapshotChanged = hasTrackedSnapshotChanged(state, items);
    const syncStartedAtMs = Date.now();
    const params = new URLSearchParams({ server: 'asia', discordServerId: serverId });
    let result;
    try {
      result = await request('/api/bot-tracked-entities?' + params.toString(), {
        method: 'PUT',
        body: { server: 'asia', discordServerId: serverId, items, confirmEmpty: items.length === 0 },
      });
    } catch (error) {
      if (error && typeof error === 'object') {
        error.autoBattleStage = 'ซิงก์รายการ Guild/Player ไป Battleboard';
        error.autoBattleStageMs = Date.now() - syncStartedAtMs;
      }
      throw error;
    }
    const syncDurationMs = Date.now() - syncStartedAtMs;
    console.log('🔄 [Auto-Battle] ซิงก์รายการ Guild/Player ไป Battleboard เสร็จ | เซิร์ฟเวอร์=' + serverId +
      ' | API ใช้เวลา=' + formatPreciseDuration(syncDurationMs) +
      ' | รายการ=' + items.length +
      ' | ข้อมูลเปลี่ยน=' + trackedSnapshotChanged);
    state.snapshotInitialized = true;
    state.snapshotFingerprint = snapshotFingerprint(items);
    state.lastSnapshotSyncAt = new Date().toISOString();
    persist();
    if (trackedSnapshotChanged) {
      console.log('🔁 [Battleboard] Tracking snapshot changed | Discord=' + serverId +
        ' | Guilds=' + Number(result.counts && result.counts.guilds || 0) +
        ' | Players=' + Number(result.counts && result.counts.players || 0));
    }
    return true;
  }
  function eventsPath(serverId, cursor, limit) {
    const params = new URLSearchParams({ server: 'asia', discordServerId: serverId, mode: 'events', limit: String(limit || 50) });
    if (cursor && cursor.after) params.set('after', cursor.after);
    if (cursor && cursor.afterBattleId) params.set('afterBattleId', String(cursor.afterBattleId));
    return '/api/bot-tracked-entities?' + params.toString();
  }
  async function initialiseCursor(serverId, state) {
    const result = await request(eventsPath(serverId, null, 1));
    state.eventCursor = result.cursor && result.cursor.after
      ? { after: result.cursor.after, afterBattleId: String(result.cursor.afterBattleId || '0') }
      : { after: new Date().toISOString(), afterBattleId: '0' };
    state.cursorInitialized = true;
    persist();
    console.log('🧭 [Auto-Battle] ตั้งจุดเริ่มตรวจ Event สำเร็จ โดยไม่ส่งรายงานย้อนหลัง | เซิร์ฟเวอร์=' + serverId);
  }
  function trackedPlayers(config) {
    return (Array.isArray(config.players) ? config.players : [])
      .map(item => typeof item === 'string' ? item : item && (item.name || item.playerName))
      .map(item => String(item || '').trim()).filter(Boolean);
  }
  function trackedGuilds(config) {
    return (Array.isArray(config.guilds) ? config.guilds : [])
      .map(item => typeof item === 'string' ? item : item && (item.name || item.guildName))
      .map(item => String(item || '').trim()).filter(Boolean);
  }
  function getRoutes(guildConfig, detail, event) {
    const configs = Array.isArray(guildConfig.autoBattles) ? guildConfig.autoBattles : [];
    return configs.filter(config => config && config.enabled !== false && config.channelId && targetGuildMatches(config, detail, event));
  }
  async function fetchDetail(battleId) {
    const params = new URLSearchParams({ server: 'asia', id: String(battleId) });
    try {
      return await request('/api/bot-battle-detail?' + params.toString());
    } catch (error) {
      if (Number(error && error.status) === 404) return { status: 404 };
      throw error;
    }
  }
  async function deliver(channel, channelId, battleId, report, targets, routeChecks, state, serverId, event, detail, timings = {}) {
    const key = deliveryKey(battleId, channelId);
    const prior = findDelivery(state, key);
    if (prior && prior.status === 'sent') return;
    const files = Array.isArray(report.payload && report.payload.files) ? report.payload.files : [];
    const partsTotal = Math.max(1, files.length);
    const record = prior || { key, battleId: String(battleId), channelId: String(channelId), status: 'sending', partsSent: 0 };
    const reportAttemptStartedAtMs = Date.now();
    const discordSendThisRunStartedAtMs = reportAttemptStartedAtMs;
    if (!record.firstAttemptAt) record.firstAttemptAt = new Date(reportAttemptStartedAtMs).toISOString();
    if (!Array.isArray(record.partResults)) record.partResults = [];
    record.auditVersion = 2;
    record.lastAttemptAt = new Date(reportAttemptStartedAtMs).toISOString();
    saveDelivery(state, record);
    console.log(
      '📤 [Auto-Battle] เริ่มส่งรายงาน' +
      ' | เซิร์ฟเวอร์=' + serverId +
      ' | Battle ID=' + battleId +
      ' | Guild=' + targets.join(', ') +
      ' | ห้อง=' + channelId +
      ' | จำนวนส่วน=' + partsTotal
    );
    const routeSummary = (Array.isArray(routeChecks) ? routeChecks : [])
      .map(check => check.targetGuild + ': ' + formatFame(check.totalFame) + ' / ' + formatFame(check.minFame))
      .join(' | ');
    const alertText =
      '🚨 **BOSS BOT Battleboard Alert!** ตรวจพบไฟต์ใหม่ของ **' + targets.join(', ') + '**\n' +
      '🆔 Battle ID: ' + battleId + '\n' +
      '💰 Fame รวมของผู้ที่ติดตาม: ' + formatFame(report.totalFame) + '\n' +
      (routeSummary ? '🎯 Fame ตามเงื่อนไขแต่ละ Guild: ' + routeSummary + '\n' : '') +
      '⚔️ Kills: ' + Number(report.totalKills || 0).toLocaleString() + '\n' +
      '☠️ Deaths: ' + Number(report.totalDeaths || 0).toLocaleString() + '\n' +
      '➕ Kills + Deaths: ' + (Number(report.totalKills || 0) + Number(report.totalDeaths || 0)).toLocaleString() + '\n' +
      '🔗 Battle Link: <' + report.battleUrl + '>';

    const sendPart = async (partNumber, payload) => {
      const partIndex = partNumber - 1;
      const partStartedAtMs = Date.now();
      const partStartedAt = new Date(partStartedAtMs).toISOString();
      const fileDetails = getReportFileLogDetails(files[partIndex], partNumber);
      const previousPart = record.partResults[partIndex] || {};
      const attemptNumber = Math.max(0, Number(previousPart.attempts) || 0) + 1;
      const partLabel = files.length ? 'ไฟล์แนบ ' : 'ข้อความรายงาน ';
      record.partResults[partIndex] = {
        ...previousPart,
        partNumber,
        status: 'sending',
        attempts: attemptNumber,
        startedAt: partStartedAt,
      };
      record.lastAttemptAt = partStartedAt;
      saveDelivery(state, record);
      console.log(
        '📤 [Auto-Battle] กำลังส่งรายงานส่วนที่ ' + partNumber + '/' + partsTotal +
        ' | ' + partLabel + partNumber + '/' + partsTotal +
        ' | เซิร์ฟเวอร์=' + serverId +
        ' | Battle ID=' + battleId +
        ' | Guild=' + targets.join(', ') +
        ' | ห้อง=' + channelId +
        fileDetails +
        ' | ครั้งที่=' + attemptNumber
      );
      try {
        const sentMessage = await channel.send({
          ...payload,
          allowedMentions: { parse: [] },
          nonce: deliveryNonce(battleId, channelId, partNumber),
          enforceNonce: true,
        });
        const sentAt = new Date();
        const sendDurationMs = Math.max(0, sentAt.getTime() - partStartedAtMs);
        record.partsSent = Math.max(Number(record.partsSent) || 0, partNumber);
        record.partResults[partIndex] = {
          ...record.partResults[partIndex],
          status: 'sent',
          sentAt: sentAt.toISOString(),
          sendDurationMs,
          messageId: sentMessage && sentMessage.id ? String(sentMessage.id) : null,
        };
        if (sentMessage && sentMessage.id) {
          if (!Array.isArray(record.messageIds)) record.messageIds = [];
          record.messageIds[partNumber - 1] = String(sentMessage.id);
        }
        saveDelivery(state, record);
        console.log(
          '✅ [Auto-Battle] ส่งรายงานส่วนที่ ' + partNumber + '/' + partsTotal + ' เข้า Discord สำเร็จ' +
          ' | ' + partLabel + partNumber + '/' + partsTotal +
          ' | เซิร์ฟเวอร์=' + serverId +
          ' | Battle ID=' + battleId +
          ' | Guild=' + targets.join(', ') +
          ' | ห้อง=' + channelId +
          fileDetails +
          ' | ใช้เวลาส่ง=' + formatPreciseDuration(sendDurationMs) +
          (sentMessage && sentMessage.id ? ' | Message ID=' + sentMessage.id : '')
        );
      } catch (error) {
        const failedAt = new Date();
        const sendDurationMs = Math.max(0, failedAt.getTime() - partStartedAtMs);
        const reason = String(error && error.message || error).slice(0, 220);
        if (error && typeof error === 'object') {
          error.autoBattleStage = 'ส่งรายงานส่วนที่ ' + partNumber;
          error.autoBattleStageMs = sendDurationMs;
        }
        record.partResults[partIndex] = {
          ...record.partResults[partIndex],
          status: 'failed',
          failedAt: failedAt.toISOString(),
          sendDurationMs,
          error: reason,
        };
        record.lastError = reason;
        saveDelivery(state, record);
        console.error(
          '❌ [Auto-Battle] ส่งรายงานส่วนที่ ' + partNumber + '/' + partsTotal + ' ไม่สำเร็จ' +
          ' | ' + partLabel + partNumber + '/' + partsTotal +
          ' | เซิร์ฟเวอร์=' + serverId +
          ' | Battle ID=' + battleId +
          ' | Guild=' + targets.join(', ') +
          ' | ห้อง=' + channelId +
          fileDetails +
          ' | ครั้งที่=' + attemptNumber +
          ' | ใช้เวลาก่อนล้มเหลว=' + formatPreciseDuration(sendDurationMs) +
          ' | สาเหตุ=' + reason
        );
        throw error;
      }
    };

    if (files.length) {
      if ((Number(record.partsSent) || 0) < 1) {
        await sendPart(1, { content: alertText, files: [files[0]] });
      } else {
        console.log(
          '⏭️ [Auto-Battle] ข้ามไฟล์แนบ 1/' + partsTotal + ' เพราะมีบันทึกว่าส่งสำเร็จแล้ว' +
          ' | Battle ID=' + battleId +
          (record.messageIds && record.messageIds[0] ? ' | Message ID=' + record.messageIds[0] : '')
        );
      }
      for (let index = 1; index < files.length; index++) {
        if ((Number(record.partsSent) || 0) >= index + 1) {
          console.log(
            '⏭️ [Auto-Battle] ข้ามไฟล์แนบ ' + (index + 1) + '/' + partsTotal + ' เพราะมีบันทึกว่าส่งสำเร็จแล้ว' +
            ' | Battle ID=' + battleId +
            (record.messageIds && record.messageIds[index] ? ' | Message ID=' + record.messageIds[index] : '')
          );
          continue;
        }
        const continuationText =
          '📎 **BOSS BOT Battle Report – ส่วนที่ ' + (index + 1) + '/' + partsTotal + '** | Battle ID: ' + battleId;
        await sendPart(index + 1, { content: continuationText, files: [files[index]] });
      }
    } else if ((Number(record.partsSent) || 0) < 1) {
      await sendPart(1, {
        content: alertText + '\n' + String(report.payload && report.payload.content || ''),
      });
    } else {
      console.log(
        '⏭️ [Auto-Battle] ข้ามข้อความรายงาน 1/1 เพราะมีบันทึกว่าส่งสำเร็จแล้ว' +
        ' | Battle ID=' + battleId +
        (record.messageIds && record.messageIds[0] ? ' | Message ID=' + record.messageIds[0] : '')
      );
    }

    record.status = 'sent';
    record.partsTotal = partsTotal;
    record.sentAt = new Date().toISOString();
    const totalSendDurationMs = Math.max(0, Date.parse(record.sentAt) - Date.parse(record.firstAttemptAt || record.sentAt));
    record.totalSendDurationMs = totalSendDurationMs;
    saveDelivery(state, record);
    console.log(
      '✅ [Auto-Battle] ส่งรายงานครบทุกส่วนเข้า Discord สำเร็จ' +
      ' | เซิร์ฟเวอร์=' + serverId +
      ' | Battle ID=' + battleId +
      ' | Guild=' + targets.join(', ') +
      ' | ห้อง=' + channelId +
      ' | ส่งแล้ว=' + Math.min(Number(record.partsSent) || 0, partsTotal) + '/' + partsTotal + ' ส่วน' +
      ' | ใช้เวลาส่งรวม=' + formatThaiDuration(totalSendDurationMs)
    );
    for (const line of formatBattleDelayLines(event, detail, record.sentAt)) {
      console.log('📊 [Auto-Battle] ' + line + ' | Battle ID=' + battleId);
    }
    const metrics = getBattleDelayMetrics(event, detail, record.sentAt);
    const sourceFirstSeenAt = event && (event.first_seen_at || event.firstSeenAt);
    const websiteEventAt = event && event.checked_at;
    const botReceivedAt = event && event.__botReceivedAt;
    const detailReadyAt = event && event.__detailReadyAt;
    const queuedAt = timings.queuedAt || (event && event.__queuedAt);
    const currentSendMs = Date.now() - discordSendThisRunStartedAtMs;
    console.log(
      '🕒 [Auto-Battle] Timeline | Battle ID=' + battleId +
      ' | Battle เริ่ม=' + formatThaiTimestamp(metrics.battleStartTime) +
      ' | Battle จบ=' + formatThaiTimestamp(metrics.battleEndTime) +
      ' | Battleboard first_seen_at=' + formatThaiTimestamp(sourceFirstSeenAt) +
      ' | เว็บสร้าง Event (checked_at)=' + formatThaiTimestamp(websiteEventAt) +
      ' | บอทได้รับ Event=' + formatThaiTimestamp(botReceivedAt) +
      ' | รายละเอียดพร้อม=' + formatThaiTimestamp(detailReadyAt) +
      ' | ส่งครบ=' + formatThaiTimestamp(record.sentAt)
    );
    console.log(
      '📊 [Auto-Battle] สรุปเวลาแต่ละขั้นตอน | Battle ID=' + battleId +
      ' | Events API=' + formatElapsedMs(timings.eventsApiMs) +
      ' | Battle จบ→เว็บ first_seen=' + formatElapsedMs(elapsedMsBetween(detail && detail.endTime, sourceFirstSeenAt)) +
      ' | เว็บ first_seen→สร้าง Event=' + formatElapsedMs(elapsedMsBetween(sourceFirstSeenAt, websiteEventAt)) +
      ' | checked_at→บอทรับ=' + formatElapsedMs(elapsedMsBetween(websiteEventAt, botReceivedAt)) +
      ' | บอทรับ→รายละเอียดพร้อม=' + formatElapsedMs(elapsedMsBetween(botReceivedAt, detailReadyAt)) +
      ' | รอในคิวก่อนรายละเอียดพร้อม=' + formatElapsedMs(elapsedMsBetween(queuedAt, detailReadyAt || record.sentAt)) +
      ' | Detail API รวม ' + (Number(event && event.__detailFetchCount) || 0) + ' ครั้ง=' +
        formatElapsedMs(Number.isFinite(Number(event && event.__detailFetchTotalMs)) ? Number(event.__detailFetchTotalMs) : null) +
      ' | ตรวจ Route=' + formatPreciseDuration(timings.routeMatchMs) +
      ' | สร้างรายงาน=' + formatPreciseDuration(timings.reportBuildMs) +
      ' | ตรวจ Fame=' + formatPreciseDuration(timings.fameCheckMs) +
      ' | ดึงห้อง Discord=' + formatPreciseDuration(timings.channelFetchMs) +
      ' | ส่ง Discord รอบนี้=' + formatPreciseDuration(currentSendMs) +
      ' | ส่ง Discord รวมตั้งแต่ครั้งแรก=' + formatPreciseDuration(totalSendDurationMs) +
      ' | บอทรับ Event→ส่งครบ=' + formatElapsedMs(elapsedMsBetween(botReceivedAt, record.sentAt)) +
      ' | Retry=' + (Number(timings.retryAttempts) || 0) + ' ครั้ง'
    );
  }
  async function processEvent(serverId, guildConfig, state, event, options = {}) {
    const battleId = String(event && event.battle_id || '').trim();
    if (!/^\d+$/.test(battleId)) return true;

    const pendingEntry = options.pendingEntry || null;
    const retryAttempt = pendingEntry ? Math.max(1, Number(pendingEntry.attempts) || 1) : 0;
    const shouldLogRetry = !pendingEntry || retryAttempt === 1 || retryAttempt % 5 === 0;
    const botReceivedAt = event.__botReceivedAt ||
      (pendingEntry && pendingEntry.firstBotReceivedAt) || null;
    const sourceFirstSeenAt = event.first_seen_at || event.firstSeenAt || null;
    const websiteEventAt = event.checked_at || null;

    if (event.__eventReceivedLog !== true) {
      event.__eventReceivedLog = true;
      console.log(
        '📥 [Auto-Battle] บอทได้รับ Battle Event | เซิร์ฟเวอร์=' + serverId +
        ' | Battle ID=' + battleId +
        ' | Battleboard first_seen_at=' + formatThaiTimestamp(sourceFirstSeenAt) +
        ' | เว็บสร้าง Event (checked_at)=' + formatThaiTimestamp(websiteEventAt) +
        ' | บอทรับ Event=' + formatThaiTimestamp(botReceivedAt) +
        ' | first_seen→checked_at=' + formatElapsedMs(elapsedMsBetween(sourceFirstSeenAt, websiteEventAt)) +
        ' | checked_at→บอทรับ=' + formatElapsedMs(elapsedMsBetween(websiteEventAt, botReceivedAt)) +
        ' | Events API=' + formatElapsedMs(event.__eventsApiMs)
      );
    }

    const detailFetchStartedAtMs = Date.now();
    let detailResponse;
    try {
      detailResponse = await fetchDetail(battleId);
    } catch (error) {
      const detailFetchMs = Date.now() - detailFetchStartedAtMs;
      event.__detailFetchCount = (Number(event.__detailFetchCount) || 0) + 1;
      event.__detailFetchTotalMs = (Number(event.__detailFetchTotalMs) || 0) + detailFetchMs;
      if (error && typeof error === 'object') {
        error.autoBattleStage = 'ดึงรายละเอียด Battle API';
        error.autoBattleStageMs = detailFetchMs;
      }
      console.error(
        '❌ [Auto-Battle] ดึงรายละเอียด Battle ไม่สำเร็จ | เซิร์ฟเวอร์=' + serverId +
        ' | Battle ID=' + battleId +
        ' | Retry=' + retryAttempt +
        ' | API ใช้เวลา=' + formatPreciseDuration(detailFetchMs) +
        ' | สาเหตุ=' + String(error && error.message || error).slice(0, 180)
      );
      throw error;
    }
    const detailFetchMs = Date.now() - detailFetchStartedAtMs;
    event.__detailFetchCount = (Number(event.__detailFetchCount) || 0) + 1;
    event.__detailFetchTotalMs = (Number(event.__detailFetchTotalMs) || 0) + detailFetchMs;

    // A missing or incomplete detail stays pending and is retried; it is never reported as a sent Battle.
    if (Number(detailResponse.status) === 404 || detailResponse.ready !== true ||
        !detailResponse.detail || Number(detailResponse.detailSchemaVersion || 0) < 4) {
      if (shouldLogRetry) {
        console.warn(
          '⏳ [Auto-Battle] รายละเอียด Battle ยังไม่พร้อม | เซิร์ฟเวอร์=' + serverId +
          ' | Battle ID=' + battleId +
          ' | ผล API=' + (Number(detailResponse.status) === 404 ? 'HTTP 404' : 'HTTP response แต่ข้อมูลยังไม่พร้อม') +
          ' | API ครั้งนี้=' + formatPreciseDuration(detailFetchMs) +
          ' | API รวม ' + event.__detailFetchCount + ' ครั้ง=' + formatPreciseDuration(event.__detailFetchTotalMs) +
          ' | บอทรอมาแล้ว=' + formatElapsedMs(elapsedMsBetween(botReceivedAt, new Date())) +
          (pendingEntry ? ' | อยู่ในคิว=' + formatElapsedMs(elapsedMsBetween(pendingEntry.queuedAt, new Date())) : '')
        );
      }
      return false;
    }

    const detail = detailResponse.detail;
    const detailReadyAt = new Date().toISOString();
    event.__detailReadyAt = event.__detailReadyAt || detailReadyAt;
    console.log(
      '✅ [Auto-Battle] รายละเอียด Battle พร้อมใช้งาน | เซิร์ฟเวอร์=' + serverId +
      ' | Battle ID=' + battleId +
      ' | API ครั้งนี้=' + formatPreciseDuration(detailFetchMs) +
      ' | API รวม ' + event.__detailFetchCount + ' ครั้ง=' + formatPreciseDuration(event.__detailFetchTotalMs) +
      ' | เวลาตั้งแต่บอทรับ Event=' + formatElapsedMs(elapsedMsBetween(botReceivedAt, event.__detailReadyAt)) +
      (pendingEntry ? ' | อยู่ในคิวก่อนพร้อม=' + formatElapsedMs(elapsedMsBetween(pendingEntry.queuedAt, event.__detailReadyAt)) : '')
    );

    const routeMatchStartedAtMs = Date.now();
    const routes = getRoutes(guildConfig, detail, event);
    const routeMatchMs = Date.now() - routeMatchStartedAtMs;
    if (!routes.length) {
      console.log('ℹ️ [Auto-Battle] Battle นี้ไม่ตรงกับกิลด์หรือห้องรายงานที่ตั้งค่าไว้ | เซิร์ฟเวอร์=' +
        serverId + ' | Battle ID=' + battleId +
        ' | Detail API=' + formatPreciseDuration(event.__detailFetchTotalMs) +
        ' | ตรวจ Route=' + formatPreciseDuration(routeMatchMs));
      return true;
    }
    const players = trackedPlayers(guildConfig);
    const guilds = trackedGuilds(guildConfig);
    if (!players.length && !guilds.length) {
      console.warn(
        '⚠️ [Auto-Battle] ไม่สร้างรายงาน เพราะไม่มีรายชื่อ Guild/Player ที่ติดตาม' +
        ' | เซิร์ฟเวอร์=' + serverId +
        ' | Battle ID=' + battleId +
        ' | Detail API=' + formatPreciseDuration(event.__detailFetchTotalMs) +
        ' | ตรวจ Route=' + formatPreciseDuration(routeMatchMs)
      );
      return true;
    }

    const reportBuildStartedAtMs = Date.now();
    let report;
    try {
      report = await buildBattleReportPayload(battleId, [], {
        autoBattle: true, guildId: serverId, apiData: detail, trackedPlayers: players, trackedGuilds: guilds,
      });
    } catch (error) {
      const reportBuildMs = Date.now() - reportBuildStartedAtMs;
      if (error && typeof error === 'object') {
        error.autoBattleStage = 'สร้างรายงาน/ไฟล์';
        error.autoBattleStageMs = reportBuildMs;
      }
      console.error('❌ [Auto-Battle] สร้างรายงาน/ไฟล์ไม่สำเร็จ | Battle ID=' + battleId +
        ' | ใช้เวลา=' + formatPreciseDuration(reportBuildMs) +
        ' | สาเหตุ=' + String(error && error.message || error).slice(0, 180));
      throw error;
    }
    const reportBuildMs = Date.now() - reportBuildStartedAtMs;
    console.log('🛠️ [Auto-Battle] สร้างรายงาน/ไฟล์เสร็จ | Battle ID=' + battleId +
      ' | จำนวนไฟล์=' + (Array.isArray(report.payload && report.payload.files) ? report.payload.files.length : 0) +
      ' | ใช้เวลา=' + formatPreciseDuration(reportBuildMs));

    const fameCheckStartedAtMs = Date.now();
    const routeChecks = evaluateAutoBattleRoutes(routes, report, detail, event);
    const fameCheckMs = Date.now() - fameCheckStartedAtMs;
    console.log('💰 [Auto-Battle] ตรวจ Fame/เกณฑ์เสร็จ | Battle ID=' + battleId +
      ' | ใช้เวลา=' + formatPreciseDuration(fameCheckMs) +
      ' | ผล=' + routeChecks.map(check => check.targetGuild + ':' +
        formatFame(check.totalFame) + '/' + formatFame(check.minFame) +
        (check.eligible ? ' ผ่าน' : ' ไม่ผ่าน')).join(' | '));
    const byChannel = new Map();
    for (const check of routeChecks) {
      const channelId = String(check.route.channelId);
      const entry = byChannel.get(channelId) || [];
      entry.push(check);
      byChannel.set(channelId, entry);
    }
    for (const [channelId, checks] of byChannel) {
      const key = deliveryKey(battleId, channelId);
      const prior = findDelivery(state, key);
      if (prior && prior.status === 'sent') {
        console.log(
          '⏭️ [Auto-Battle] ข้ามรายงานนี้ เพราะมีบันทึกว่าส่งเข้า Discord สำเร็จแล้ว ไม่ส่งซ้ำ' +
          ' | เซิร์ฟเวอร์=' + serverId +
          ' | Battle ID=' + battleId +
          ' | ห้อง=' + channelId +
          ' | ส่งแล้ว=' + Math.min(Number(prior.partsSent) || 0, Number(prior.partsTotal) || Number(prior.partsSent) || 0) +
            '/' + (Number(prior.partsTotal) || 'ไม่ทราบ') + ' ส่วน' +
          (prior.sentAt ? ' | เวลาที่ส่ง=' + prior.sentAt : '')
        );
        continue;
      }
      if (prior && prior.status === 'below-threshold') {
        console.log(
          '⏭️ [Auto-Battle] ข้ามรายงานนี้ เพราะเคยตรวจแล้วว่า Fame ต่ำกว่าเกณฑ์' +
          ' | เซิร์ฟเวอร์=' + serverId +
          ' | Battle ID=' + battleId +
          ' | ห้อง=' + channelId +
          ' | ตรวจล่าสุด=' + String(prior.checkedAt || 'ไม่ทราบเวลา')
        );
        continue;
      }

      // Each Auto-Battle route is checked independently against the tracked-roster Fame total.
      // Sharing a Discord channel must not make every configured Guild label appear as qualified.
      const qualifiedRoutes = checks.filter(check => check.eligible);
      if (!qualifiedRoutes.length) {
        const routeSummary = checks
          .map(check => check.targetGuild + '=' + formatFame(check.totalFame) + '/' + formatFame(check.minFame))
          .join(' | ');
        saveDelivery(state, {
          key, battleId, channelId, status: 'below-threshold',
          totalFame: Number(report.totalFame || 0),
          routeChecks: checks.map(({ targetGuild, totalFame, minFame }) =>
            ({ targetGuild, totalFame, minFame })),
          checkedAt: new Date().toISOString(),
        });
        console.log('ℹ️ [Auto-Battle] ไม่ส่งรายงาน เนื่องจาก Fame รวมต่ำกว่าเกณฑ์ทุก Route | Battle ID=' + battleId +
          ' | ' + routeSummary +
          ' | สร้างรายงาน=' + formatPreciseDuration(reportBuildMs) +
          ' | ตรวจ Fame=' + formatPreciseDuration(fameCheckMs));
        console.log('📊 [Auto-Battle] สรุปเวลาแต่ละขั้นตอน (ไม่ส่งเพราะ Fame ต่ำกว่าเกณฑ์) | Battle ID=' + battleId +
          ' | Battle จบ=' + formatThaiTimestamp(detail.endTime) +
          ' | first_seen_at=' + formatThaiTimestamp(event.first_seen_at || event.firstSeenAt) +
          ' | checked_at=' + formatThaiTimestamp(event.checked_at) +
          ' | บอทรับ Event=' + formatThaiTimestamp(botReceivedAt) +
          ' | Battle จบ→first_seen=' + formatElapsedMs(elapsedMsBetween(detail.endTime, event.first_seen_at || event.firstSeenAt)) +
          ' | first_seen→checked_at=' + formatElapsedMs(elapsedMsBetween(event.first_seen_at || event.firstSeenAt, event.checked_at)) +
          ' | checked_at→บอทรับ=' + formatElapsedMs(elapsedMsBetween(event.checked_at, botReceivedAt)) +
          ' | บอทรับ→รายละเอียดพร้อม=' + formatElapsedMs(elapsedMsBetween(botReceivedAt, event.__detailReadyAt)) +
          ' | Detail API รวม=' + formatElapsedMs(event.__detailFetchTotalMs) +
          ' | ตรวจ Route=' + formatPreciseDuration(routeMatchMs) +
          ' | สร้างรายงาน=' + formatPreciseDuration(reportBuildMs) +
          ' | ตรวจ Fame=' + formatPreciseDuration(fameCheckMs));
        continue;
      }

      const channelFetchStartedAtMs = Date.now();
      let channel = null;
      let channelFetchError = null;
      try { channel = await client.channels.fetch(channelId); }
      catch (error) { channelFetchError = error; }
      const channelFetchMs = Date.now() - channelFetchStartedAtMs;
      console.log('📡 [Auto-Battle] ตรวจห้อง Discord เสร็จ | Battle ID=' + battleId +
        ' | ห้อง=' + channelId + ' | ใช้เวลา=' + formatPreciseDuration(channelFetchMs) +
        ' | พร้อมส่ง=' + Boolean(channel && typeof channel.send === 'function'));
      if (!channel || typeof channel.send !== 'function') {
        const error = new Error('Auto-Battle channel unavailable: ' + channelId +
          (channelFetchError ? ' (' + String(channelFetchError.message || channelFetchError).slice(0, 120) + ')' : ''));
        error.autoBattleStage = 'ค้นหาห้อง Discord';
        error.autoBattleStageMs = channelFetchMs;
        throw error;
      }
      const targets = [...new Set(qualifiedRoutes.map(check => check.targetGuild))];
      await deliver(channel, channelId, battleId, report, targets, qualifiedRoutes, state, serverId, event, detail, {
        eventsApiMs: event.__eventsApiMs,
        botReceivedAt,
        detailReadyAt: event.__detailReadyAt,
        queuedAt: pendingEntry && pendingEntry.queuedAt,
        retryAttempts: pendingEntry && pendingEntry.attempts,
        routeMatchMs,
        reportBuildMs,
        fameCheckMs,
        channelFetchMs,
      });
    }
    return true;
  }
  function enqueuePendingEvent(serverId, state, event, reason) {
    const battleId = String(event && event.battle_id || '').trim();
    if (!/^\d+$/.test(battleId)) return false;
    if (!Array.isArray(state.pendingEvents)) state.pendingEvents = [];
    const existing = state.pendingEvents.find(item => item && String(item.battleId) === battleId);
    if (existing) {
      existing.event = event;
      existing.lastError = String(reason || existing.lastError || '').slice(0, 180);
      return false;
    }
    const queuedAt = new Date().toISOString();
    event.__queuedAt = event.__queuedAt || queuedAt;
    state.pendingEvents.push({
      battleId,
      event,
      queuedAt,
      firstBotReceivedAt: event.__botReceivedAt || queuedAt,
      sourceFirstSeenAt: event.first_seen_at || event.firstSeenAt || null,
      websiteEventAt: event.checked_at || null,
      eventsApiMs: Number.isFinite(Number(event.__eventsApiMs)) ? Number(event.__eventsApiMs) : null,
      attempts: 0,
      lastError: String(reason || '').slice(0, 180),
    });
    if (state.pendingEvents.length > MAX_PENDING_EVENTS) {
      const dropped = state.pendingEvents.splice(0, state.pendingEvents.length - MAX_PENDING_EVENTS);
      console.warn('⚠️ [Auto-Battle] คิวรอรายละเอียดเต็ม จึงนำรายการเก่าที่สุดออก | เซิร์ฟเวอร์=' +
        serverId + ' | จำนวน=' + dropped.length);
    }
    const battleStartMs = timestampMs(event && event.battle_start_time);
    const elapsedSinceStart = battleStartMs === null || Date.now() < battleStartMs
      ? null
      : formatThaiDuration(Date.now() - battleStartMs);
    const reasonText = reason === 'detail-not-ready' ? 'รายละเอียด Battle ยังไม่ครบ'
      : reason === 'deferred-after-transient-error' ? 'รอประมวลผลต่อหลังเกิดข้อผิดพลาดชั่วคราว'
      : String(reason || 'รอรายละเอียดไม่ครบ').slice(0, 120);
    console.warn(
      '⏳ [Auto-Battle] รายละเอียด Battle ยังไม่พร้อม จัดเข้าคิวรอข้อมูลแล้ว' +
      ' | เซิร์ฟเวอร์=' + serverId +
      ' | Battle ID=' + battleId +
      (elapsedSinceStart === null ? '' : ' | ผ่านมาตั้งแต่เริ่ม Battle=' + elapsedSinceStart) +
      ' | first_seen_at=' + formatThaiTimestamp(event.first_seen_at || event.firstSeenAt) +
      ' | checked_at=' + formatThaiTimestamp(event.checked_at) +
      ' | บอทรับ Event=' + formatThaiTimestamp(event.__botReceivedAt) +
      ' | first_seen→checked_at=' + formatElapsedMs(elapsedMsBetween(event.first_seen_at || event.firstSeenAt, event.checked_at)) +
      ' | checked_at→บอทรับ=' + formatElapsedMs(elapsedMsBetween(event.checked_at, event.__botReceivedAt)) +
      ' | Events API=' + formatElapsedMs(event.__eventsApiMs) +
      ' | รอตั้งแต่บอทเห็น=' + formatElapsedMs(elapsedMsBetween(event.__botReceivedAt, queuedAt)) +
      ' | เหตุผล=' + reasonText
    );
    persist();
    return true;
  }
  function removePendingEvent(state, battleId) {
    if (!Array.isArray(state.pendingEvents)) return;
    state.pendingEvents = state.pendingEvents.filter(item => String(item && item.battleId || '') !== String(battleId));
    persist();
  }
  function rotatePendingEvent(state, entry) {
    if (!Array.isArray(state.pendingEvents)) state.pendingEvents = [];
    state.pendingEvents = state.pendingEvents.filter(item => item !== entry);
    state.pendingEvents.push(entry);
    persist();
  }
  async function processEventWithSharedDedupe(serverId, guildConfig, state, event, options = {}) {
    const battleId = String(event && event.battle_id || '').trim();
    if (/^\d+$/.test(battleId)) {
      let alreadyProcessed = false;
      try { alreadyProcessed = isBattleProcessed(serverId, battleId) === true; }
      catch (error) {
        console.warn('⚠️ [Auto-Battle] ตรวจรายการป้องกันรายงานซ้ำไม่สำเร็จ | เซิร์ฟเวอร์=' +
          serverId + ' | Battle ID=' + battleId + ' | Error=' + String(error && error.message || error).slice(0, 160));
      }
      if (alreadyProcessed) {
        console.log('⏭️ [Auto-Battle] ข้าม Battle ที่แหล่งตรวจจับก่อนหน้าประมวลผลแล้ว เพื่อป้องกันรายงานซ้ำ' +
          ' | เซิร์ฟเวอร์=' + serverId + ' | Battle ID=' + battleId);
        return true;
      }
    }
    const complete = await processEvent(serverId, guildConfig, state, event, options);
    if (complete && /^\d+$/.test(battleId)) {
      try { markBattleProcessed(serverId, battleId); }
      catch (error) {
        console.warn('⚠️ [Auto-Battle] บันทึกรายการป้องกันรายงานซ้ำไม่สำเร็จ | เซิร์ฟเวอร์=' +
          serverId + ' | Battle ID=' + battleId + ' | Error=' + String(error && error.message || error).slice(0, 160));
      }
    }
    return complete;
  }

  async function retryPendingEvents(serverId, guildConfig, state) {
    if (!Array.isArray(state.pendingEvents) || !state.pendingEvents.length) return;
    const now = Date.now();
    const retained = [];
    let expired = 0;
    for (const entry of state.pendingEvents) {
      if (!entry || !entry.event || !/^\d+$/.test(String(entry.battleId || ''))) continue;
      const queuedAt = Date.parse(entry.queuedAt || '');
      if (Number.isFinite(queuedAt) && now - queuedAt > PENDING_EVENT_MAX_AGE_MS) {
        expired++;
        continue;
      }
      retained.push(entry);
    }
    state.pendingEvents = retained;
    if (expired) {
      console.warn('⚠️ [Auto-Battle] หมดเวลารอรายละเอียด Battle เกิน 24 ชั่วโมง จึงนำออกจากคิว | เซิร์ฟเวอร์=' +
        serverId + ' | จำนวน=' + expired);
      persist();
    }
    const candidates = state.pendingEvents.slice(0, MAX_PENDING_RETRIES_PER_TICK);
    for (const entry of candidates) {
      if (!state.pendingEvents.includes(entry)) continue;
      entry.attempts = Math.max(0, Number(entry.attempts) || 0) + 1;
      entry.lastAttemptAt = new Date().toISOString();
      try {
        if (entry.attempts === 1 || entry.attempts % 5 === 0) {
          console.log('🔁 [Auto-Battle] เริ่มลอง Battle ที่ค้างอีกครั้ง | เซิร์ฟเวอร์=' + serverId +
            ' | Battle ID=' + entry.battleId +
            ' | Retry=' + entry.attempts +
            ' | อยู่ในคิวแล้ว=' + formatElapsedMs(elapsedMsBetween(entry.queuedAt, new Date())));
        }
        const complete = await processEventWithSharedDedupe(serverId, guildConfig, state, entry.event, {
          quietPending: true, pendingEntry: entry,
        });
        if (complete) {
          console.log('✅ [Auto-Battle] ประมวลผล Battle ที่ค้างเสร็จแล้ว | เซิร์ฟเวอร์=' + serverId +
            ' | Battle ID=' + entry.battleId +
            ' | Retry ทั้งหมด=' + entry.attempts +
            ' | เวลาตั้งแต่เข้าคิว=' + formatElapsedMs(elapsedMsBetween(entry.queuedAt, new Date())));
          removePendingEvent(state, entry.battleId);
        } else {
          rotatePendingEvent(state, entry);
          if (entry.attempts === 1 || entry.attempts % 5 === 0) {
            const queuedAt = timestampMs(entry.queuedAt);
            const waitingMs = queuedAt === null ? null : Math.max(0, Date.now() - queuedAt);
            console.log('⏳ [Auto-Battle] รายละเอียด Battle ยังไม่ครบ กำลังลองใหม่ครั้งที่ ' + entry.attempts +
              ' | เซิร์ฟเวอร์=' + serverId + ' | Battle ID=' + entry.battleId +
              (waitingMs === null ? '' : ' | อยู่ในคิวแล้ว=' + formatElapsedMs(waitingMs)));
          }
        }
      } catch (error) {
        entry.lastError = String(error && error.message || error).slice(0, 180);
        rotatePendingEvent(state, entry);
        console.warn('⚠️ [Auto-Battle] ลองประมวลผล Battle ที่ค้างไม่สำเร็จ จะลองใหม่อีกครั้ง' +
          ' | เซิร์ฟเวอร์=' + serverId + ' | Battle ID=' + entry.battleId +
          ' | Retry=' + entry.attempts +
          ' | ขั้นตอน=' + String(error && error.autoBattleStage || 'ไม่ทราบขั้นตอน') +
          (Number.isFinite(Number(error && error.autoBattleStageMs)) ? ' | ใช้เวลา=' + formatPreciseDuration(Number(error.autoBattleStageMs)) : '') +
          ' | อยู่ในคิวแล้ว=' + formatElapsedMs(elapsedMsBetween(entry.queuedAt, new Date())) +
          ' | สาเหตุ=' + entry.lastError);
      }
    }
  }
  async function pollServer(serverId, guildConfig) {
    if (!validDiscordServerId(serverId) || !guildConfig) return;
    const state = getState(guildConfig);
    const items = buildTrackedItems(guildConfig);

    // A Discord server with no tracking should not consume Vercel/Supabase
    // requests every 30 seconds. If tracking was removed entirely, clear the
    // previous website snapshot once; never send an accidental empty baseline.
    if (!items.length) {
      if (needsEmptySnapshotCleanup(state)) await syncSnapshot(serverId, state, items);
      return;
    }

    // Upsert the snapshot only when it changes or as a five-minute safety refresh.
    // The Events feed remains at 30 seconds, but avoids needless multi-query PUTs.
    await syncSnapshot(serverId, state, items);
    if (state.cursorInitialized !== true || !state.eventCursor) {
      await initialiseCursor(serverId, state);
      return;
    }

    // Retry old detail-pending events in a bounded batch, but never let an unavailable
    // Battle detail stop the cursor from advancing over newer Auto-Battle events.
    await retryPendingEvents(serverId, guildConfig, state);

    const eventsRequestStartedAtMs = Date.now();
    let result;
    try { result = await request(eventsPath(serverId, state.eventCursor, 100)); }
    catch (error) {
      if (error && typeof error === 'object') {
        error.autoBattleStage = 'ดึง Events feed จาก Battleboard';
        error.autoBattleStageMs = Date.now() - eventsRequestStartedAtMs;
      }
      throw error;
    }
    const eventsApiMs = Date.now() - eventsRequestStartedAtMs;
    const botReceivedAt = new Date().toISOString();
    const events = Array.isArray(result.items) ? result.items : [];
    if (events.length) {
      state.lastEventsPollSuccessLogAt = botReceivedAt;
      console.log('📥 [Auto-Battle] รับ Events feed จาก Battleboard | เซิร์ฟเวอร์=' + serverId +
        ' | จำนวน Event=' + events.length +
        ' | API ใช้เวลา=' + formatPreciseDuration(eventsApiMs) +
        ' | บอทได้รับข้อมูล=' + formatThaiTimestamp(botReceivedAt));
    } else {
      // Keep successful empty polls observable without creating a log every 30 seconds.
      const lastSuccessLogAtMs = Date.parse(state.lastEventsPollSuccessLogAt || '');
      const shouldLogEmptyPoll = !Number.isFinite(lastSuccessLogAtMs) ||
        Date.now() - lastSuccessLogAtMs >= EVENT_POLL_SUCCESS_LOG_INTERVAL_MS;
      if (shouldLogEmptyPoll) {
        const cursor = state.eventCursor || {};
        console.log('✅ [Auto-Battle] Events Feed Poll สำเร็จ ไม่มี Event ใหม่' +
          ' | เซิร์ฟเวอร์=' + serverId +
          ' | จำนวน Event=0' +
          ' | API ใช้เวลา=' + formatPreciseDuration(eventsApiMs) +
          ' | Cursor=' + String(cursor.after || 'ไม่ทราบ') + '/' + String(cursor.afterBattleId || '0') +
          ' | ตรวจเมื่อ=' + formatThaiTimestamp(botReceivedAt));
        state.lastEventsPollSuccessLogAt = botReceivedAt;
        persist();
      }
    }
    let deferRemaining = false;
    for (const rawEvent of events) {
      const event = {
        ...rawEvent,
        __botReceivedAt: rawEvent && rawEvent.__botReceivedAt || botReceivedAt,
        __eventsApiMs: Number.isFinite(Number(rawEvent && rawEvent.__eventsApiMs))
          ? Number(rawEvent.__eventsApiMs) : eventsApiMs,
      };
      if (deferRemaining) {
        enqueuePendingEvent(serverId, state, event, 'deferred-after-transient-error');
      } else {
        try {
          const complete = await processEventWithSharedDedupe(serverId, guildConfig, state, event);
          if (!complete) enqueuePendingEvent(serverId, state, event, 'detail-not-ready');
        } catch (error) {
          if ([401, 403].includes(Number(error && error.status))) throw error;
          enqueuePendingEvent(serverId, state, event, String(error && error.message || error));
          deferRemaining = true;
          console.warn('⚠️ [Auto-Battle] ประมวลผล Battle ไม่สำเร็จ จัดเข้าคิวเพื่อลองใหม่' +
            ' | เซิร์ฟเวอร์=' + serverId +
            ' | Battle ID=' + String(event && event.battle_id || 'ไม่ทราบ') +
            ' | ขั้นตอน=' + String(error && error.autoBattleStage || 'ไม่ทราบขั้นตอน') +
            (Number.isFinite(Number(error && error.autoBattleStageMs)) ? ' | ใช้เวลา=' + formatPreciseDuration(Number(error.autoBattleStageMs)) : '') +
            ' | สาเหตุ=' + String(error && error.message || error).slice(0, 180));
        }
      }
      state.eventCursor = {
        after: String(event.checked_at || state.eventCursor.after),
        afterBattleId: String(event.battle_id || state.eventCursor.afterBattleId || '0'),
      };
      state.lastEventProcessedAt = new Date().toISOString();
      persist();
    }
  }
  async function tick() {
    if (running) return;
    if (timer) { clearTimeout(timer); timer = null; }
    running = true;
    try {
      const servers = typeof getAllGuildConfigs === 'function' ? getAllGuildConfigs() : [];
      for (const item of servers) {
        const serverId = String(item && item.guildId || '').trim();
        const config = item && item.config
          ? item.config
          : (typeof getGuildConfig === 'function' ? getGuildConfig(serverId, false) : null);
        if (!config) continue;
        if (started && !activeServerIds.has(serverId)) continue;
        const state = getState(config);
        const retryAfter = Date.parse(state.retryAfterAt || '');
        if (Number.isFinite(retryAfter) && retryAfter > Date.now()) continue;
        try {
          await pollServer(serverId, config);
          if (Number(state.consecutiveFailures) > 0 || state.retryAfterAt) {
            delete state.consecutiveFailures;
            delete state.retryAfterAt;
            persist();
          }
        } catch (error) {
          const failures = Math.max(0, Number(state.consecutiveFailures) || 0) + 1;
          const delay = retryDelayMs(failures);
          state.consecutiveFailures = failures;
          state.retryAfterAt = new Date(Date.now() + delay).toISOString();
          persist();
          console.error('❌ [Auto-Battle] ตรวจสอบ Event ไม่สำเร็จ จะลองใหม่ใน ' + Math.ceil(delay / 1000) + ' วินาที' +
            ' | เซิร์ฟเวอร์=' + serverId +
            ' | ขั้นตอน=' + String(error && error.autoBattleStage || 'ซิงก์ Tracking / Poll') +
            (Number.isFinite(Number(error && error.autoBattleStageMs)) ? ' | ใช้เวลา=' + formatPreciseDuration(Number(error && error.autoBattleStageMs)) : '') +
            ' | สาเหตุ=' + String(error && error.message || error).slice(0, 260));
          if (started && activeServerIds.has(serverId) && failures >= SERVER_FAILURES_BEFORE_FAILOVER) {
            if (hasPartialDelivery(state)) {
              if (failures === SERVER_FAILURES_BEFORE_FAILOVER || failures % 5 === 0) {
                console.error('🛑 [Auto-Battle] ยังไม่สลับไป Official API เพราะมีรายงานส่งค้างบางส่วน; คง Battleboard เป็นแหล่งหลักเพื่อไม่ให้เกิดรายงานซ้ำ' +
                  ' | เซิร์ฟเวอร์=' + serverId + ' | Failure=' + failures);
              }
            } else {
              activeServerIds.delete(serverId);
              const reason = String(error && error.message || error).replace(/https?:\/\/\S+/gi, '[URL]').slice(0, 180);
              notifyServerAvailability(serverId, false, {
                phase: 'runtime-failure',
                reason,
                cursorInitialized: state.cursorInitialized === true,
              });
              console.error('🚨 [Auto-Battle FAILOVER] Battleboard API ล้มเหลวต่อเนื่อง ' + failures +
                ' ครั้ง; สลับเซิร์ฟเวอร์นี้ไป Official API fallback และหยุด Event polling ของเซิร์ฟเวอร์นี้จนกว่าจะ Restart' +
                ' | เซิร์ฟเวอร์=' + serverId + ' | สาเหตุ=' + reason);
            }
          }
        }
      }
    } finally {
      running = false;
      if (started && activeServerIds.size > 0) timer = setTimeout(tick, POLL_MS);
      else timer = null;
    }
  }
  async function preflightServer(serverId, config) {
    const items = buildTrackedItems(config);
    if (!validDiscordServerId(serverId) || !items.length) return false;
    const startedAtMs = Date.now();
    try {
      const result = await request(eventsPath(serverId, null, 1));
      if (!result || !Array.isArray(result.items)) throw new Error('Events Feed response schema is invalid.');
      const state = getState(config);
      delete state.consecutiveFailures;
      delete state.retryAfterAt;
      activeServerIds.add(String(serverId));
      persist();
      notifyServerAvailability(serverId, true, {
        phase: 'startup-preflight',
        responseMs: Date.now() - startedAtMs,
        eventCount: result.items.length,
      });
      console.log('✅ [Battleboard] API preflight ผ่าน | Discord Server=' + serverId +
        ' | Events Feed HTTP=200 | API ใช้เวลา=' + formatPreciseDuration(Date.now() - startedAtMs) +
        ' | Event ตัวอย่าง=' + result.items.length);
      return true;
    } catch (error) {
      activeServerIds.delete(String(serverId));
      const reason = String(error && error.message || error).replace(/https?:\/\/\S+/gi, '[URL]').slice(0, 180);
      notifyServerAvailability(serverId, false, {
        phase: 'startup-preflight-failed',
        reason,
        responseMs: Date.now() - startedAtMs,
      });
      console.warn('⚠️ [Battleboard] API preflight ไม่ผ่าน; ใช้ Official API fallback สำหรับเซิร์ฟเวอร์นี้' +
        ' | Discord Server=' + serverId + ' | ใช้เวลา=' + formatPreciseDuration(Date.now() - startedAtMs) +
        ' | สาเหตุ=' + reason);
      return false;
    }
  }
  async function start() {
    if (started) return activeServerIds.size > 0;
    if (!isConfigured()) {
      console.log('ℹ️ [Battleboard] ไม่ได้ตั้งค่า API/Key; คง Official API Auto-Battle scanner เป็นแหล่งตรวจจับหลัก');
      return false;
    }
    const servers = typeof getAllGuildConfigs === 'function' ? getAllGuildConfigs() : [];
    const candidates = servers.filter(item => {
      const serverId = String(item && item.guildId || '').trim();
      const config = item && item.config
        ? item.config
        : (typeof getGuildConfig === 'function' ? getGuildConfig(serverId, false) : null);
      return validDiscordServerId(serverId) && config && buildTrackedItems(config).length > 0;
    });
    if (!candidates.length) {
      console.log('ℹ️ [Battleboard] ไม่มี Discord server ที่มี Guild/Player tracking; Official API scanner ยังคงทำงานตามปกติ');
      return false;
    }
    started = true;
    for (const item of candidates) {
      const serverId = String(item.guildId).trim();
      const config = item.config ||
        (typeof getGuildConfig === 'function' ? getGuildConfig(serverId, false) : null);
      await preflightServer(serverId, config);
    }
    if (!activeServerIds.size) {
      started = false;
      console.warn('🚨 [Battleboard] API preflight ไม่ผ่านทุกเซิร์ฟเวอร์; ไม่เปิด Event polling และใช้ Official API fallback ทั้งหมด');
      return false;
    }
    console.log('🌐 [Battleboard] API integration enabled | Asia | Poll=30s | Preflight ผ่าน=' +
      activeServerIds.size + '/' + candidates.length + ' server(s); failover แยกตาม Discord Server');
    timer = setTimeout(tick, 2000);
    return true;
  }
  function stop() {
    if (timer) clearTimeout(timer);
    timer = null;
    started = false;
  }
  return { start, stop, isConfigured, tick, isServerActive: serverId => activeServerIds.has(String(serverId)) };
}
module.exports = {
  createBattleboardIntegration,
  __test: { normalizeName, validDiscordServerId, buildTrackedItems, getBattleGuilds, targetGuildMatches, evaluateAutoBattleRoutes, deliveryKey, deliveryNonce, snapshotFingerprint, hasTrackedSnapshotChanged, isSnapshotSyncDue, retryDelayMs, needsEmptySnapshotCleanup, timestampMs, formatThaiDuration, formatThaiTimestamp, formatPreciseDuration, elapsedMsBetween, getBattleDelayMetrics, formatBattleDelayLines },
};
