'use strict';
const POLL_MS = 30000;
const TIMEOUT_MS = 8000;
const SNAPSHOT_SYNC_INTERVAL_MS = 5 * 60 * 1000;
const RETRY_BASE_MS = 30 * 1000;
const RETRY_MAX_MS = 5 * 60 * 1000;
const MAX_DELIVERIES = 2000;
const LATENCY_SUMMARY_INTERVAL_MS = 30 * 60 * 1000;
const SLOW_REPORT_MS = 5 * 60 * 1000;
const VERY_SLOW_REPORT_MS = 10 * 60 * 1000;
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
function deliveryKey(battleId, channelId) { return String(battleId) + ':' + String(channelId); }
function toTimestampMs(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    const dateMs = value.getTime();
    return Number.isFinite(dateMs) && dateMs > 0 ? dateMs : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const dateMs = value < 1e12 ? value * 1000 : value;
    return dateMs > 0 ? dateMs : null;
  }
  const text = String(value).trim();
  if (!text) return null;
  if (/^\d{10,13}$/.test(text)) {
    const numeric = Number(text);
    const dateMs = numeric < 1e12 ? numeric * 1000 : numeric;
    return Number.isFinite(dateMs) && dateMs > 0 ? dateMs : null;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
function formatElapsedMs(value) {
  if (value == null || value === '' || !Number.isFinite(Number(value))) return 'ไม่ทราบ';
  const totalSeconds = Math.floor(Math.max(0, Number(value)) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return hours + ' ชม. ' + minutes + ' นาที ' + seconds + ' วินาที';
  return minutes + ' นาที ' + seconds + ' วินาที';
}
function getAttachmentName(file, fallback) {
  const name = file && (file.name || (file.attachment && file.attachment.name));
  return String(name || fallback || 'unknown').replace(/\s+/g, ' ').slice(0, 120);
}
function formatThaiDateTime(value) {
  const timestamp = toTimestampMs(value);
  if (timestamp == null) return 'ไม่ทราบเวลา';
  return new Date(timestamp).toLocaleString('th-TH', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }) + ' น.';
}
function getAttachmentSizeBytes(file) {
  const attachment = file && (file.attachment ?? file);
  if (Buffer.isBuffer(attachment)) return attachment.length;
  if (attachment instanceof Uint8Array) return attachment.byteLength;
  if (Number.isFinite(Number(file && file.size)) && Number(file.size) >= 0) return Number(file.size);
  return null;
}
function formatAttachmentSize(bytes) {
  if (bytes == null || !Number.isFinite(Number(bytes))) return 'ไม่ทราบขนาด';
  const size = Number(bytes);
  if (size < 1024) return size + ' ไบต์';
  if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB';
  return (size / (1024 * 1024)).toFixed(2) + ' MB';
}
function classifyLatency(value) {
  if (value == null || !Number.isFinite(Number(value))) return 'ยังวัดไม่ได้';
  const ms = Math.max(0, Number(value));
  if (ms >= VERY_SLOW_REPORT_MS) return 'ช้าผิดปกติ';
  if (ms >= SLOW_REPORT_MS) return 'เริ่มช้า';
  return 'เร็ว';
}
function createEmptyLatencySummary(now = Date.now()) {
  return {
    windowStartedAt: new Date(now).toISOString(),
    reportsSent: 0,
    belowFame: 0,
    detailPending: 0,
    detailRetryAttempts: 0,
    noRoute: 0,
    fileUploadAttempts: 0,
    fileUploadSuccesses: 0,
    fileUploadFailures: 0,
    apiFailures: 0,
    otherPollFailures: 0,
    totalBattleToDiscordMs: 0,
    battleToDiscordSamples: 0,
    fastestBattleToDiscordMs: null,
    slowestBattleToDiscordMs: null,
    totalReportGenerationMs: 0,
    reportGenerationSamples: 0,
    totalDiscordSendMs: 0,
    discordSendSamples: 0,
  };
}
function getLatencySummary(state, now = Date.now()) {
  if (!state.latencySummary || typeof state.latencySummary !== 'object') {
    state.latencySummary = createEmptyLatencySummary(now);
  }
  return state.latencySummary;
}
function addLatencyValue(summary, totalKey, samplesKey, value) {
  if (value == null || !Number.isFinite(Number(value))) return;
  summary[totalKey] = (Number(summary[totalKey]) || 0) + Math.max(0, Number(value));
  summary[samplesKey] = (Number(summary[samplesKey]) || 0) + 1;
}
function flushLatencySummary(state, serverId, now = Date.now()) {
  const summary = getLatencySummary(state, now);
  const startedAt = Date.parse(summary.windowStartedAt || '');
  if (Number.isFinite(startedAt) && now - startedAt < LATENCY_SUMMARY_INTERVAL_MS) return false;
  const average = (total, samples) => samples > 0 ? formatElapsedMs(total / samples) : 'ไม่มีข้อมูล';
  const uploadRate = summary.fileUploadAttempts > 0
    ? (summary.fileUploadSuccesses / summary.fileUploadAttempts * 100).toFixed(1) + '%'
    : 'ไม่มีข้อมูล';
  const fastest = summary.fastestBattleToDiscordMs == null ? 'ไม่มีข้อมูล' : formatElapsedMs(summary.fastestBattleToDiscordMs);
  const slowest = summary.slowestBattleToDiscordMs == null ? 'ไม่มีข้อมูล' : formatElapsedMs(summary.slowestBattleToDiscordMs);
  console.log('📊 [Battleboard สรุปทุก 30 นาที]' +
    ' | เซิร์ฟเวอร์ Discord=' + serverId +
    ' | ช่วงเวลา=' + (Number.isFinite(startedAt) ? formatThaiDateTime(startedAt) : 'ไม่ทราบ') + ' ถึง ' + formatThaiDateTime(now) +
    ' | รายงานส่งครบ=' + (summary.reportsSent || 0) +
    ' | ต่ำกว่าเกณฑ์ Fame=' + (summary.belowFame || 0) +
    ' | จำนวนรอบที่รายละเอียดยังไม่ครบ=' + (summary.detailPending || 0) +
    ' | จำนวนครั้งที่ลองตรวจรายละเอียดซ้ำ=' + (summary.detailRetryAttempts || 0) +
    ' | ไม่มีห้องตรงเงื่อนไข=' + (summary.noRoute || 0) +
    ' | ส่งข้อความ/ไฟล์สำเร็จ=' + (summary.fileUploadSuccesses || 0) + '/' + (summary.fileUploadAttempts || 0) +
    ' (' + uploadRate + ')' +
    ' | ส่งข้อความ/ไฟล์ไม่สำเร็จ=' + (summary.fileUploadFailures || 0) +
    ' | คำขอ API ผิดพลาด=' + (summary.apiFailures || 0) +
    ' | รอบตรวจผิดพลาดอื่น=' + (summary.otherPollFailures || 0) +
    ' | เฉลี่ยเริ่มไฟต์ถึง Discord=' + average(summary.totalBattleToDiscordMs, summary.battleToDiscordSamples) +
    ' | เร็วสุด=' + fastest +
    ' | ช้าสุด=' + slowest +
    ' | เฉลี่ยสร้างรายงาน=' + average(summary.totalReportGenerationMs, summary.reportGenerationSamples) +
    ' | เวลาเฉลี่ยที่ Discord รับข้อความ/ไฟล์=' + average(summary.totalDiscordSendMs, summary.discordSendSamples) + '.');
  state.latencySummary = createEmptyLatencySummary(now);
  return true;
}
function snapshotFingerprint(items) {
  return JSON.stringify((Array.isArray(items) ? items : []).map(item => [
    String(item && item.type || ''),
    normalizeName(item && item.name),
    item && item.id ? String(item.id) : null,
  ]));
}
function isSnapshotSyncDue(state = {}, items = [], now = Date.now()) {
  const fingerprint = snapshotFingerprint(items);
  if (state.snapshotInitialized !== true || state.snapshotFingerprint !== fingerprint) return true;
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

function createBattleboardIntegration(deps = {}) {
  const client = deps.client;
  const getAllGuildConfigs = deps.getAllGuildConfigs;
  const getGuildConfig = deps.getGuildConfig;
  const saveData = deps.saveData;
  const buildBattleReportPayload = deps.buildBattleReportPayload;
  const formatFame = deps.formatFame || (value => Number(value || 0).toLocaleString());
  let started = false;
  let running = false;
  let timer = null;

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
    catch (error) { console.error('❌ [Battleboard] บันทึกสถานะไม่สำเร็จ:', error.message); }
  }
  function getState(config) {
    if (!config.battleboardState || typeof config.battleboardState !== 'object') config.battleboardState = {};
    if (!Array.isArray(config.battleboardState.delivered)) config.battleboardState.delivered = [];
    if (!config.battleboardState.pendingDetailAttempts || typeof config.battleboardState.pendingDetailAttempts !== 'object') {
      config.battleboardState.pendingDetailAttempts = {};
    }
    getLatencySummary(config.battleboardState);
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
    const params = new URLSearchParams({ server: 'asia', discordServerId: serverId });
    const result = await request('/api/bot-tracked-entities?' + params.toString(), {
      method: 'PUT',
      body: { server: 'asia', discordServerId: serverId, items, confirmEmpty: items.length === 0 },
    });
    state.snapshotInitialized = true;
    state.snapshotFingerprint = snapshotFingerprint(items);
    state.lastSnapshotSyncAt = new Date().toISOString();
    persist();
    console.log('🔁 [Battleboard] ซิงก์รายการติดตามสำเร็จ | เซิร์ฟเวอร์ Discord=' + serverId +
      ' | กิลด์=' + Number(result.counts && result.counts.guilds || 0) +
      ' | ผู้เล่น=' + Number(result.counts && result.counts.players || 0));
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
    console.log('🧭 [Battleboard] ตั้งจุดเริ่มรับ Event โดยไม่ส่งรายงานย้อนหลัง | เซิร์ฟเวอร์ Discord=' + serverId);
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
  async function deliver(channel, channelId, battleId, report, targets, state, serverId, event, timingInfo = {}) {
    const key = deliveryKey(battleId, channelId);
    const prior = findDelivery(state, key);
    if (prior && prior.status === 'sent') return;

    const files = Array.isArray(report.payload && report.payload.files) ? report.payload.files : [];
    const partsTotal = Math.max(1, files.length);
    const attemptStartedAtMs = Date.now();
    const battleStartedAtMs = toTimestampMs(report && report.battleTime);
    const firstSeenAtMs = toTimestampMs(event && event.first_seen_at);
    const eventCheckedAtMs = toTimestampMs(event && event.checked_at);
    const eventReceivedAtMs = Number(timingInfo.eventReceivedAtMs) || attemptStartedAtMs;
    const reportGeneratedAtMs = Number(timingInfo.reportGeneratedAtMs) || attemptStartedAtMs;
    const reportGenerationMs = Number.isFinite(Number(timingInfo.reportGenerationMs))
      ? Math.max(0, Number(timingInfo.reportGenerationMs)) : null;

    const record = prior || {
      key,
      battleId: String(battleId),
      channelId: String(channelId),
      status: 'sending',
      partsSent: 0,
      partTimings: [],
    };
    if (!Array.isArray(record.partTimings)) record.partTimings = [];
    if (!record.firstDeliveryAttemptAt) record.firstDeliveryAttemptAt = new Date(attemptStartedAtMs).toISOString();
    record.status = 'sending';
    record.partsTotal = partsTotal;
    record.battleStartedAt = battleStartedAtMs ? new Date(battleStartedAtMs).toISOString() : null;
    record.websiteFirstSeenAt = firstSeenAtMs ? new Date(firstSeenAtMs).toISOString() : null;
    record.websiteEventCreatedAt = eventCheckedAtMs ? new Date(eventCheckedAtMs).toISOString() : null;
    record.botReceivedEventAt = new Date(eventReceivedAtMs).toISOString();
    record.reportGeneratedAt = new Date(reportGeneratedAtMs).toISOString();
    record.reportGenerationMs = reportGenerationMs;
    record.detailFetchMs = Number.isFinite(Number(timingInfo.detailFetchMs)) ? Math.max(0, Number(timingInfo.detailFetchMs)) : null;
    record.lastDeliveryAttemptAt = new Date(attemptStartedAtMs).toISOString();
    saveDelivery(state, record);

    const alertText =
      '🚨 **BOSS BOT Battleboard Alert!** ตรวจพบไฟต์ใหม่ของ **' + targets.join(', ') + '**\n' +
      '💰 Fame รวมของผู้ที่ติดตาม: ' + formatFame(report.totalFame) + '\n' +
      '⚔️ Kills: ' + Number(report.totalKills || 0).toLocaleString() + '\n' +
      '☠️ Deaths: ' + Number(report.totalDeaths || 0).toLocaleString() + '\n' +
      '➕ Kills + Deaths: ' + (Number(report.totalKills || 0) + Number(report.totalDeaths || 0)).toLocaleString() + '\n' +
      '🔗 Battle Link: <' + report.battleUrl + '>';

    const elapsedFrom = (startMs, endMs) =>
      startMs ? formatElapsedMs(endMs - startMs) : 'ไม่ทราบ';
    const sendPart = async (payload, partLabel, partNumber, fileName, fileSizeBytes) => {
      const sendStartedAtMs = Date.now();
      const summary = getLatencySummary(state);
      summary.fileUploadAttempts = (Number(summary.fileUploadAttempts) || 0) + 1;
      let discordMessage = null;
      try {
        discordMessage = await channel.send(payload);
      } catch (sendError) {
        const failedAtMs = Date.now();
        const sendRoundTripMs = Math.max(0, failedAtMs - sendStartedAtMs);
        record.lastFailedPart = partNumber;
        record.lastFailureAt = new Date(failedAtMs).toISOString();
        record.lastFailure = String(sendError && sendError.message || sendError).slice(0, 200);
        summary.fileUploadFailures = (Number(summary.fileUploadFailures) || 0) + 1;
        saveDelivery(state, record);
        console.error('❌ [Battleboard ส่งไฟล์ไม่สำเร็จ]' +
          ' | เซิร์ฟเวอร์ Discord=' + serverId +
          ' | ไฟต์=' + battleId +
          ' | ห้อง=' + channelId +
          ' | ไฟล์ลำดับ=' + partNumber + '/' + partsTotal +
          ' | รายการ=' + partLabel +
          ' | ชื่อไฟล์=' + fileName +
          ' | ขนาด=' + formatAttachmentSize(fileSizeBytes) +
          ' | เริ่มไฟต์ถึงจุดที่ส่งพลาด=' + elapsedFrom(battleStartedAtMs, failedAtMs) +
          ' | บอทได้รับ Event ถึงจุดที่ส่งพลาด=' + elapsedFrom(eventReceivedAtMs, failedAtMs) +
          ' | เวลาเรียกส่ง=' + sendRoundTripMs + 'ms' +
          ' | ข้อผิดพลาด=' + String(sendError && sendError.message || sendError).slice(0, 200));
        throw sendError;
      }

      const sendResolvedAtMs = Date.now();
      const discordMessageAtMs = toTimestampMs(discordMessage && discordMessage.createdTimestamp) || sendResolvedAtMs;
      const sendRoundTripMs = Math.max(0, sendResolvedAtMs - sendStartedAtMs);
      const timing = {
        part: partNumber,
        partsTotal,
        item: partLabel,
        fileName,
        fileSizeBytes: fileSizeBytes == null ? null : Number(fileSizeBytes),
        sendStartedAt: new Date(sendStartedAtMs).toISOString(),
        discordMessageAt: new Date(discordMessageAtMs).toISOString(),
        discordMessageId: String(discordMessage && discordMessage.id || ''),
        sendRoundTripMs,
        battleToDiscordMs: battleStartedAtMs ? Math.max(0, discordMessageAtMs - battleStartedAtMs) : null,
        websiteFirstSeenToDiscordMs: firstSeenAtMs ? Math.max(0, discordMessageAtMs - firstSeenAtMs) : null,
        websiteEventToDiscordMs: eventCheckedAtMs ? Math.max(0, discordMessageAtMs - eventCheckedAtMs) : null,
        botReceivedToDiscordMs: Math.max(0, discordMessageAtMs - eventReceivedAtMs),
      };
      record.partTimings.push(timing);
      if (record.partTimings.length > 100) record.partTimings.splice(0, record.partTimings.length - 100);
      record.partsSent = Math.max(Number(record.partsSent) || 0, partNumber);
      record.lastPartSentAt = timing.discordMessageAt;
      summary.fileUploadSuccesses = (Number(summary.fileUploadSuccesses) || 0) + 1;
      addLatencyValue(summary, 'totalDiscordSendMs', 'discordSendSamples', sendRoundTripMs);
      saveDelivery(state, record);

      console.log('📨 [Battleboard ส่งไฟล์สำเร็จ]' +
        ' | เซิร์ฟเวอร์ Discord=' + serverId +
        ' | ไฟต์=' + battleId +
        ' | ห้อง=' + channelId +
        ' | ไฟล์ลำดับ=' + partNumber + '/' + partsTotal +
        ' | รายการ=' + partLabel +
        ' | ชื่อไฟล์=' + fileName +
        ' | ขนาด=' + formatAttachmentSize(fileSizeBytes) +
        ' | เริ่มไฟต์ถึง Discord รับข้อความ=' + elapsedFrom(battleStartedAtMs, discordMessageAtMs) +
        ' | เว็บพบไฟต์ถึง Discord=' + elapsedFrom(firstSeenAtMs, discordMessageAtMs) +
        ' | เว็บสร้างเหตุการณ์ถึง Discord=' + elapsedFrom(eventCheckedAtMs, discordMessageAtMs) +
        ' | บอทได้รับ Event ถึง Discord=' + elapsedFrom(eventReceivedAtMs, discordMessageAtMs) +
        ' | เวลาที่ Discord รับไฟล์=' + sendRoundTripMs + 'ms' +
        ' | รหัสข้อความ Discord=' + String(discordMessage && discordMessage.id || 'ไม่ทราบ') +
        ' | เวลาข้อความใน Discord=' + formatThaiDateTime(discordMessageAtMs) + '.');
    };

    if (files.length) {
      if ((Number(record.partsSent) || 0) < 1) {
        await sendPart(
          { content: alertText, files: [files[0]], allowedMentions: { parse: [] } },
          'ข้อความแจ้งเตือน + รูปที่ 1',
          1,
          getAttachmentName(files[0], 'report-image-1'),
          getAttachmentSizeBytes(files[0])
        );
      }
      for (let index = 1; index < files.length; index++) {
        if ((Number(record.partsSent) || 0) >= index + 1) continue;
        await sendPart(
          { files: [files[index]], allowedMentions: { parse: [] } },
          'รูปที่ ' + (index + 1),
          index + 1,
          getAttachmentName(files[index], 'report-image-' + (index + 1)),
          getAttachmentSizeBytes(files[index])
        );
      }
    } else if ((Number(record.partsSent) || 0) < 1) {
      await sendPart({
        content: alertText + '\n' + String(report.payload && report.payload.content || ''),
        allowedMentions: { parse: [] },
      }, 'ข้อความแจ้งเตือน (ไม่มีรูป)', 1, 'ไม่มีไฟล์แนบ', null);
    }

    const completedAtMs = Date.now();
    const finalDiscordAtMs = toTimestampMs(record.lastPartSentAt) || completedAtMs;
    const firstAttemptAtMs = toTimestampMs(record.firstDeliveryAttemptAt) || attemptStartedAtMs;
    const battleToDiscordMs = battleStartedAtMs ? Math.max(0, finalDiscordAtMs - battleStartedAtMs) : null;
    record.status = 'sent';
    record.partsTotal = partsTotal;
    record.sentAt = new Date(finalDiscordAtMs).toISOString();
    record.totalBattleToDiscordMs = battleToDiscordMs;
    record.totalWebsiteFirstSeenToDiscordMs = firstSeenAtMs ? Math.max(0, finalDiscordAtMs - firstSeenAtMs) : null;
    record.totalWebsiteEventToDiscordMs = eventCheckedAtMs ? Math.max(0, finalDiscordAtMs - eventCheckedAtMs) : null;
    record.totalBotReceivedToDiscordMs = Math.max(0, finalDiscordAtMs - eventReceivedAtMs);
    record.deliveryWindowMs = Math.max(0, completedAtMs - firstAttemptAtMs);
    if (!record.summaryCountedAt) {
      const summary = getLatencySummary(state);
      summary.reportsSent = (Number(summary.reportsSent) || 0) + 1;
      addLatencyValue(summary, 'totalBattleToDiscordMs', 'battleToDiscordSamples', battleToDiscordMs);
      addLatencyValue(summary, 'totalReportGenerationMs', 'reportGenerationSamples', reportGenerationMs);
      if (battleToDiscordMs != null) {
        summary.fastestBattleToDiscordMs = summary.fastestBattleToDiscordMs == null
          ? battleToDiscordMs : Math.min(summary.fastestBattleToDiscordMs, battleToDiscordMs);
        summary.slowestBattleToDiscordMs = summary.slowestBattleToDiscordMs == null
          ? battleToDiscordMs : Math.max(summary.slowestBattleToDiscordMs, battleToDiscordMs);
      }
      record.summaryCountedAt = new Date(completedAtMs).toISOString();
    }
    saveDelivery(state, record);
    persist();

    console.log('✅ [Battleboard ส่งรายงานครบ]' +
      ' | เซิร์ฟเวอร์ Discord=' + serverId +
      ' | ไฟต์=' + battleId +
      ' | ห้อง=' + channelId +
      ' | ส่งสำเร็จ=' + (Number(record.partsSent) || 0) + '/' + partsTotal + ' ไฟล์' +
      ' | เริ่มไฟต์ถึง Discord รับไฟล์สุดท้าย=' + elapsedFrom(battleStartedAtMs, finalDiscordAtMs) +
      ' | ระดับความเร็ว=' + classifyLatency(battleToDiscordMs) +
      ' | เว็บพบไฟต์ถึง Discord=' + elapsedFrom(firstSeenAtMs, finalDiscordAtMs) +
      ' | เว็บสร้าง Event ถึง Discord=' + elapsedFrom(eventCheckedAtMs, finalDiscordAtMs) +
      ' | บอทได้รับ Event ถึง Discord=' + elapsedFrom(eventReceivedAtMs, finalDiscordAtMs) +
      ' | เวลาสร้างรายงาน=' + (reportGenerationMs == null ? 'ไม่ทราบ' : reportGenerationMs + 'ms') +
      ' | เวลาส่งรายงานตั้งแต่ครั้งแรก=' + record.deliveryWindowMs + 'ms' +
      ' | เวลารับข้อความสุดท้าย=' + formatThaiDateTime(finalDiscordAtMs) + '.');
  }
  async function processEvent(serverId, guildConfig, state, event) {
    const battleId = String(event && event.battle_id || '').trim();
    if (!/^\d+$/.test(battleId)) return true;

    const eventReceivedAtMs = Date.now();
    const battleStartedAtMs = toTimestampMs(event && event.battle_start_time);
    const firstSeenAtMs = toTimestampMs(event && event.first_seen_at);
    const eventCheckedAtMs = toTimestampMs(event && event.checked_at);
    const elapsedFrom = (startMs, endMs) => startMs ? formatElapsedMs(endMs - startMs) : 'ไม่ทราบ';
    console.log('🛰️ [Battleboard รับ Event]' +
      ' | เซิร์ฟเวอร์ Discord=' + serverId +
      ' | ไฟต์=' + battleId +
      ' | เริ่มไฟต์ถึงเว็บพบไฟต์=' + elapsedFrom(battleStartedAtMs, firstSeenAtMs) +
      ' | เว็บพบไฟต์ถึงตรวจรายละเอียดครบและสร้างเหตุการณ์=' + elapsedFrom(firstSeenAtMs, eventCheckedAtMs) +
      ' | สร้างเหตุการณ์ถึงบอทได้รับ=' + elapsedFrom(eventCheckedAtMs, eventReceivedAtMs) +
      ' | เวลาบอทได้รับ=' + formatThaiDateTime(eventReceivedAtMs) + '.');

    const detailFetchStartedAtMs = Date.now();
    const detailResponse = await fetchDetail(battleId);
    const detailFetchedAtMs = Date.now();
    const detailFetchMs = Math.max(0, detailFetchedAtMs - detailFetchStartedAtMs);
    if (Number(detailResponse.status) === 404) {
      console.log('⚠️ [Battleboard ไม่พบรายละเอียดไฟต์] | ไฟต์=' + battleId + ' | ข้าม Event นี้');
      return true;
    }
    if (detailResponse.ready !== true || !detailResponse.detail || Number(detailResponse.detailSchemaVersion || 0) < 4) {
      const attempts = Math.max(0, Number(state.pendingDetailAttempts[battleId]) || 0) + 1;
      state.pendingDetailAttempts[battleId] = attempts;
      const pendingSummary = getLatencySummary(state);
      pendingSummary.detailPending = (Number(pendingSummary.detailPending) || 0) + 1;
      if (attempts > 1) pendingSummary.detailRetryAttempts = (Number(pendingSummary.detailRetryAttempts) || 0) + 1;
      if (Object.keys(state.pendingDetailAttempts).length > 500) {
        const oldestKey = Object.keys(state.pendingDetailAttempts)[0];
        delete state.pendingDetailAttempts[oldestKey];
      }
      persist();
      console.log('⏳ [Battleboard รอรายละเอียดไฟต์] | เซิร์ฟเวอร์ Discord=' + serverId +
        ' | ไฟต์=' + battleId +
        ' | รหัสสถานะ=' + String(detailResponse.status || detailResponse.statusCode || 'ยังไม่สมบูรณ์') +
        ' | เวลาเรียก API=' + detailFetchMs + 'ms' +
        ' | จำนวนครั้งที่ตรวจ=' + attempts +
        ' | ระบบจะรอตรวจใหม่ ไม่ข้ามไฟต์นี้');
      return false;
    }
    delete state.pendingDetailAttempts[battleId];
    persist();
    console.log('📚 [Battleboard ได้รายละเอียดครบ]' +
      ' | ไฟต์=' + battleId +
      ' | จำนวนเหตุการณ์ใน Battle=' + Number(detailResponse.eventCount || 0) +
      ' | จำนวนหน้ารายละเอียด=' + Number(detailResponse.eventsPageCount || 0) +
      ' | เวลาดึงรายละเอียด=' + detailFetchMs + 'ms' +
      ' | สร้างเหตุการณ์ถึงรายละเอียดพร้อม=' + elapsedFrom(eventCheckedAtMs, detailFetchedAtMs) + '.');

    const detail = detailResponse.detail;
    const routes = getRoutes(guildConfig, detail, event);
    if (!routes.length) {
      getLatencySummary(state).noRoute = (Number(getLatencySummary(state).noRoute) || 0) + 1;
      persist();
      console.log('ℹ️ [Battleboard ไม่มีห้องรายงานตรงเงื่อนไข] | เซิร์ฟเวอร์ Discord=' + serverId + ' | ไฟต์=' + battleId);
      return true;
    }
    const players = trackedPlayers(guildConfig);
    const guilds = trackedGuilds(guildConfig);
    if (!players.length && !guilds.length) {
      console.log('ℹ️ [Battleboard ไม่มีรายชื่อกิลด์หรือผู้เล่นที่ติดตาม] | เซิร์ฟเวอร์ Discord=' + serverId + ' | ไฟต์=' + battleId);
      return true;
    }

    const reportGenerationStartedAtMs = Date.now();
    const report = await buildBattleReportPayload(battleId, [], {
      autoBattle: true, guildId: serverId, apiData: detail, trackedPlayers: players, trackedGuilds: guilds,
    });
    const reportGeneratedAtMs = Date.now();
    const reportGenerationMs = Math.max(0, reportGeneratedAtMs - reportGenerationStartedAtMs);
    const reportTimings = {
      eventReceivedAtMs,
      reportGeneratedAtMs,
      reportGenerationMs,
      detailFetchMs,
    };
    console.log('🧰 [Battleboard สร้างรายงานเสร็จ]' +
      ' | เซิร์ฟเวอร์ Discord=' + serverId +
      ' | ไฟต์=' + battleId +
      ' | บอทได้รับเหตุการณ์ถึงสร้างรายงานเสร็จ=' + elapsedFrom(eventReceivedAtMs, reportGeneratedAtMs) +
      ' | เวลาประมวลผลและสร้างภาพ=' + reportGenerationMs + 'ms' +
      ' | จำนวนรูป=' + (Array.isArray(report.payload && report.payload.files) ? report.payload.files.length : 0) +
      ' | เริ่มไฟต์ถึงสร้างรายงานเสร็จ=' + elapsedFrom(battleStartedAtMs, reportGeneratedAtMs) + '.');

    const byChannel = new Map();
    for (const route of routes) {
      const channelId = String(route.channelId);
      const entry = byChannel.get(channelId) || { targets: [], minFame: Number.POSITIVE_INFINITY };
      const target = String(route.targetGuild || route.targetGuildId || 'Tracked Battle');
      if (!entry.targets.includes(target)) entry.targets.push(target);
      const fame = Number(route.minFrames);
      entry.minFame = Math.min(entry.minFame, Number.isFinite(fame) ? fame : 0);
      byChannel.set(channelId, entry);
    }
    for (const [channelId, route] of byChannel) {
      const key = deliveryKey(battleId, channelId);
      const prior = findDelivery(state, key);
      if (prior && (prior.status === 'sent' || prior.status === 'below-threshold')) continue;
      if (Number(report.totalFame || 0) < route.minFame) {
        getLatencySummary(state).belowFame = (Number(getLatencySummary(state).belowFame) || 0) + 1;
        saveDelivery(state, {
          key, battleId, channelId, status: 'below-threshold',
          totalFame: Number(report.totalFame || 0), minFame: route.minFame, checkedAt: new Date().toISOString(),
        });
        console.log('ℹ️ [Battleboard ต่ำกว่าเกณฑ์ Fame]' +
          ' | ไฟต์=' + battleId +
          ' | ห้อง=' + channelId +
          ' | Fame ที่ติดตาม=' + formatFame(report.totalFame) +
          ' | เกณฑ์ขั้นต่ำ=' + formatFame(route.minFame) +
          ' | ผู้เล่นที่ติดตาม=' + players.length +
          ' | กิลด์ที่ติดตาม=' + guilds.length +
          ' | เวลาตั้งแต่เริ่มไฟต์=' + elapsedFrom(battleStartedAtMs, Date.now()) +
          ' | ไม่ส่งรายงานตามการตั้งค่า');
        continue;
      }
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel || typeof channel.send !== 'function') throw new Error('ไม่พบห้อง Discord หรือบอทไม่มีสิทธิ์ส่งข้อความ: ' + channelId);
      await deliver(channel, channelId, battleId, report, route.targets, state, serverId, event, reportTimings);
    }
    return true;
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
    const result = await request(eventsPath(serverId, state.eventCursor, 100));
    const events = Array.isArray(result.items) ? result.items : [];
    for (const event of events) {
      if (!(await processEvent(serverId, guildConfig, state, event))) return;
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
    running = true;
    try {
      const servers = typeof getAllGuildConfigs === 'function' ? getAllGuildConfigs() : [];
      for (const item of servers) {
        const serverId = String(item && item.guildId || '').trim();
        const config = item && item.config
          ? item.config
          : (typeof getGuildConfig === 'function' ? getGuildConfig(serverId, false) : null);
        if (!config) continue;
        const state = getState(config);
        const retryAfter = Date.parse(state.retryAfterAt || '');
        if (Number.isFinite(retryAfter) && retryAfter > Date.now()) {
          flushLatencySummary(state, serverId);
          continue;
        }
        try {
          await pollServer(serverId, config);
          flushLatencySummary(state, serverId);
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
          const summary = getLatencySummary(state);
          if (Number(error && error.status) >= 400) summary.apiFailures = (Number(summary.apiFailures) || 0) + 1;
          else summary.otherPollFailures = (Number(summary.otherPollFailures) || 0) + 1;
          persist();
          console.error('❌ [Battleboard] ตรวจข้อมูลจากเว็บไซต์ไม่สำเร็จ | เซิร์ฟเวอร์ Discord=' + serverId +
            ' | รอตรวจซ้ำอีก=' + Math.ceil(delay / 1000) + 'วินาที | สาเหตุ=' + String(error && error.message || error).slice(0, 260));
          flushLatencySummary(state, serverId);
        }
      }
    } finally {
      running = false;
      timer = setTimeout(tick, POLL_MS);
    }
  }
  function start() {
    if (started) return isConfigured();
    started = true;
    if (!isConfigured()) {
      console.log('ℹ️ [Battleboard] ยังไม่ได้ตั้งค่า API จึงใช้ระบบ Auto-Battle เดิมต่อไป');
      return false;
    }
    console.log('🌐 [Battleboard] เปิดระบบเชื่อมต่อเว็บไซต์แล้ว | เซิร์ฟเวอร์=Asia | ตรวจทุก=30วินาที');
    timer = setTimeout(tick, 2000);
    return true;
  }
  function stop() {
    if (timer) clearTimeout(timer);
    timer = null;
    started = false;
  }
  return { start, stop, isConfigured, tick };
}
module.exports = {
  createBattleboardIntegration,
  __test: { normalizeName, validDiscordServerId, buildTrackedItems, getBattleGuilds, targetGuildMatches, deliveryKey, toTimestampMs, formatElapsedMs, getAttachmentName, getAttachmentSizeBytes, formatAttachmentSize, classifyLatency, createEmptyLatencySummary, formatThaiDateTime, flushLatencySummary, snapshotFingerprint, isSnapshotSyncDue, retryDelayMs, needsEmptySnapshotCleanup },
};
