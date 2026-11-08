'use strict';
const { createHash } = require('node:crypto');
const POLL_MS = 30000;
const TIMEOUT_MS = 8000;
const SNAPSHOT_SYNC_INTERVAL_MS = 5 * 60 * 1000;
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

function timestampMs(value) {
  if (value instanceof Date) {
    const valueMs = value.getTime();
    return Number.isFinite(valueMs) ? valueMs : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value == null ? '' : value).trim());
  return Number.isFinite(parsed) ? parsed : null;
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
    const params = new URLSearchParams({ server: 'asia', discordServerId: serverId });
    const result = await request('/api/bot-tracked-entities?' + params.toString(), {
      method: 'PUT',
      body: { server: 'asia', discordServerId: serverId, items, confirmEmpty: items.length === 0 },
    });
    state.snapshotInitialized = true;
    state.snapshotFingerprint = snapshotFingerprint(items);
    state.lastSnapshotSyncAt = new Date().toISOString();
    persist();
    console.log('🔁 [Battleboard] Tracking synced | Discord=' + serverId +
      ' | Guilds=' + Number(result.counts && result.counts.guilds || 0) +
      ' | Players=' + Number(result.counts && result.counts.players || 0));
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
  async function deliver(channel, channelId, battleId, report, targets, routeChecks, state, serverId, event, detail) {
    const key = deliveryKey(battleId, channelId);
    const prior = findDelivery(state, key);
    if (prior && prior.status === 'sent') return;
    const files = Array.isArray(report.payload && report.payload.files) ? report.payload.files : [];
    const partsTotal = Math.max(1, files.length);
    const record = prior || { key, battleId: String(battleId), channelId: String(channelId), status: 'sending', partsSent: 0 };
    if (!prior) saveDelivery(state, record);
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
      try {
        const sentMessage = await channel.send({
          ...payload,
          allowedMentions: { parse: [] },
          nonce: deliveryNonce(battleId, channelId, partNumber),
          enforceNonce: true,
        });
        record.partsSent = Math.max(Number(record.partsSent) || 0, partNumber);
        if (sentMessage && sentMessage.id) {
          if (!Array.isArray(record.messageIds)) record.messageIds = [];
          record.messageIds[partNumber - 1] = String(sentMessage.id);
        }
        saveDelivery(state, record);
        console.log(
          '✅ [Auto-Battle] ส่งรายงานส่วนที่ ' + partNumber + '/' + partsTotal + ' เข้า Discord สำเร็จ' +
          ' | เซิร์ฟเวอร์=' + serverId +
          ' | Battle ID=' + battleId +
          ' | Guild=' + targets.join(', ') +
          ' | ห้อง=' + channelId +
          (sentMessage && sentMessage.id ? ' | Message ID=' + sentMessage.id : '')
        );
      } catch (error) {
        const reason = String(error && error.message || error).slice(0, 220);
        console.error(
          '❌ [Auto-Battle] ส่งรายงานส่วนที่ ' + partNumber + '/' + partsTotal + ' ไม่สำเร็จ' +
          ' | เซิร์ฟเวอร์=' + serverId +
          ' | Battle ID=' + battleId +
          ' | Guild=' + targets.join(', ') +
          ' | ห้อง=' + channelId +
          ' | สาเหตุ=' + reason
        );
        throw error;
      }
    };

    if (files.length) {
      if ((Number(record.partsSent) || 0) < 1) {
        await sendPart(1, { content: alertText, files: [files[0]] });
      }
      for (let index = 1; index < files.length; index++) {
        if ((Number(record.partsSent) || 0) >= index + 1) continue;
        const continuationText =
          '📎 **BOSS BOT Battle Report – ส่วนที่ ' + (index + 1) + '/' + partsTotal + '** | Battle ID: ' + battleId;
        await sendPart(index + 1, { content: continuationText, files: [files[index]] });
      }
    } else if ((Number(record.partsSent) || 0) < 1) {
      await sendPart(1, {
        content: alertText + '\n' + String(report.payload && report.payload.content || ''),
      });
    }

    record.status = 'sent';
    record.partsTotal = partsTotal;
    record.sentAt = new Date().toISOString();
    saveDelivery(state, record);
    console.log(
      '✅ [Auto-Battle] ส่งรายงานครบทุกส่วนเข้า Discord สำเร็จ' +
      ' | เซิร์ฟเวอร์=' + serverId +
      ' | Battle ID=' + battleId +
      ' | Guild=' + targets.join(', ') +
      ' | ห้อง=' + channelId +
      ' | ส่งแล้ว=' + Math.min(Number(record.partsSent) || 0, partsTotal) + '/' + partsTotal + ' ส่วน'
    );
    for (const line of formatBattleDelayLines(event, detail, record.sentAt)) {
      console.log('📊 [Auto-Battle] ' + line + ' | Battle ID=' + battleId);
    }
  }
  async function processEvent(serverId, guildConfig, state, event, options = {}) {
    const battleId = String(event && event.battle_id || '').trim();
    if (!/^\d+$/.test(battleId)) return true;
    const detailResponse = await fetchDetail(battleId);
    // A missing detail may be a short upstream delay; keep it pending instead of dropping it.
    if (Number(detailResponse.status) === 404) {
      if (options.quietPending !== true) {
        console.log('⏳ [Auto-Battle] ยังไม่พบรายละเอียด Battle จากระบบต้นทาง | เซิร์ฟเวอร์=' + serverId + ' | Battle ID=' + battleId);
      }
      return false;
    }
    if (detailResponse.ready !== true || !detailResponse.detail || Number(detailResponse.detailSchemaVersion || 0) < 4) {
      if (options.quietPending !== true) {
        console.log('⏳ [Auto-Battle] รายละเอียด Battle ยังไม่พร้อม รอข้อมูลครบก่อนส่งรายงาน | เซิร์ฟเวอร์=' + serverId + ' | Battle ID=' + battleId +
          ' | สถานะ=' + String(detailResponse.status || detailResponse.statusText || 'กำลังรวบรวมข้อมูล'));
      }
      return false;
    }
    const detail = detailResponse.detail;
    const routes = getRoutes(guildConfig, detail, event);
    if (!routes.length) {
      console.log('ℹ️ [Auto-Battle] Battle นี้ไม่ตรงกับกิลด์หรือห้องรายงานที่ตั้งค่าไว้ | เซิร์ฟเวอร์=' + serverId + ' | Battle ID=' + battleId);
      return true;
    }
    const players = trackedPlayers(guildConfig);
    const guilds = trackedGuilds(guildConfig);
    if (!players.length && !guilds.length) return true;
    const report = await buildBattleReportPayload(battleId, [], {
      autoBattle: true, guildId: serverId, apiData: detail, trackedPlayers: players, trackedGuilds: guilds,
    });
    const routeChecks = evaluateAutoBattleRoutes(routes, report, detail, event);
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
      if (prior && (prior.status === 'sent' || prior.status === 'below-threshold')) continue;

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
          ' | ' + routeSummary);
        continue;
      }

      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel || typeof channel.send !== 'function') throw new Error('Auto-Battle channel unavailable: ' + channelId);
      const targets = [...new Set(qualifiedRoutes.map(check => check.targetGuild))];
      await deliver(channel, channelId, battleId, report, targets, qualifiedRoutes, state, serverId, event, detail);
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
    state.pendingEvents.push({
      battleId,
      event,
      queuedAt: new Date().toISOString(),
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
        const complete = await processEvent(serverId, guildConfig, state, entry.event, { quietPending: true });
        if (complete) {
          removePendingEvent(state, entry.battleId);
        } else {
          rotatePendingEvent(state, entry);
          if (entry.attempts === 1 || entry.attempts % 5 === 0) {
            const queuedAt = timestampMs(entry.queuedAt);
            const waitingMs = queuedAt === null ? null : Math.max(0, Date.now() - queuedAt);
            console.log('⏳ [Auto-Battle] รายละเอียด Battle ยังไม่ครบ กำลังลองใหม่ครั้งที่ ' + entry.attempts +
              ' | เซิร์ฟเวอร์=' + serverId + ' | Battle ID=' + entry.battleId +
              (waitingMs === null ? '' : ' | อยู่ในคิวแล้ว=' + formatThaiDuration(waitingMs)));
          }
        }
      } catch (error) {
        entry.lastError = String(error && error.message || error).slice(0, 180);
        rotatePendingEvent(state, entry);
        console.warn('⚠️ [Auto-Battle] ลองประมวลผล Battle ที่ค้างไม่สำเร็จ จะลองใหม่อีกครั้ง' +
          ' | เซิร์ฟเวอร์=' + serverId + ' | Battle ID=' + entry.battleId + ' | สาเหตุ=' + entry.lastError);
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

    const result = await request(eventsPath(serverId, state.eventCursor, 100));
    const events = Array.isArray(result.items) ? result.items : [];
    let deferRemaining = false;
    for (const event of events) {
      if (deferRemaining) {
        enqueuePendingEvent(serverId, state, event, 'deferred-after-transient-error');
      } else {
        try {
          const complete = await processEvent(serverId, guildConfig, state, event);
          if (!complete) enqueuePendingEvent(serverId, state, event, 'detail-not-ready');
        } catch (error) {
          if ([401, 403].includes(Number(error && error.status))) throw error;
          enqueuePendingEvent(serverId, state, event, String(error && error.message || error));
          deferRemaining = true;
          console.warn('⚠️ [Auto-Battle] ประมวลผล Battle ไม่สำเร็จ จัดเข้าคิวเพื่อลองใหม่' +
            ' | เซิร์ฟเวอร์=' + serverId +
            ' | Battle ID=' + String(event && event.battle_id || 'ไม่ทราบ') +
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
            ' | เซิร์ฟเวอร์=' + serverId + ' | สาเหตุ=' + String(error && error.message || error).slice(0, 260));
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
      console.log('ℹ️ [Battleboard] Not configured; existing Official API Auto-Battle scanner remains active.');
      return false;
    }
    console.log('🌐 [Battleboard] API integration enabled | Asia | Poll=30s');
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
  __test: { normalizeName, validDiscordServerId, buildTrackedItems, getBattleGuilds, targetGuildMatches, evaluateAutoBattleRoutes, deliveryKey, deliveryNonce, snapshotFingerprint, isSnapshotSyncDue, retryDelayMs, needsEmptySnapshotCleanup, timestampMs, formatThaiDuration, getBattleDelayMetrics, formatBattleDelayLines },
};
