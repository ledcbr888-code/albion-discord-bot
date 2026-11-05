'use strict';
const POLL_MS = 30000;
const TIMEOUT_MS = 8000;
const SNAPSHOT_SYNC_INTERVAL_MS = 5 * 60 * 1000;
const RETRY_BASE_MS = 30 * 1000;
const RETRY_MAX_MS = 5 * 60 * 1000;
const MAX_DELIVERIES = 2000;
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
    catch (error) { console.error('❌ [Battleboard] Could not persist state:', error.message); }
  }
  function getState(config) {
    if (!config.battleboardState || typeof config.battleboardState !== 'object') config.battleboardState = {};
    if (!Array.isArray(config.battleboardState.delivered)) config.battleboardState.delivered = [];
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
    console.log('🧭 [Battleboard] Initialized event cursor without replaying historical reports | Discord=' + serverId);
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
  async function deliver(channel, channelId, battleId, report, targets, state, serverId, event) {
    const key = deliveryKey(battleId, channelId);
    const prior = findDelivery(state, key);
    if (prior && prior.status === 'sent') return;

    const files = Array.isArray(report.payload && report.payload.files) ? report.payload.files : [];
    const partsTotal = Math.max(1, files.length);
    const attemptStartedAtMs = Date.now();
    const battleStartedAtMs = toTimestampMs(report && report.battleTime);
    const eventCheckedAtMs = toTimestampMs(event && event.checked_at);
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
    record.eventCheckedAt = eventCheckedAtMs ? new Date(eventCheckedAtMs).toISOString() : null;
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
    const sendPart = async (payload, partLabel, partNumber, fileName) => {
      const sendStartedAtMs = Date.now();
      let discordMessage = null;
      try {
        discordMessage = await channel.send(payload);
      } catch (sendError) {
        const failedAtMs = Date.now();
        const sendRoundTripMs = Math.max(0, failedAtMs - sendStartedAtMs);
        record.lastFailedPart = partNumber;
        record.lastFailureAt = new Date(failedAtMs).toISOString();
        record.lastFailure = String(sendError && sendError.message || sendError).slice(0, 200);
        saveDelivery(state, record);
        console.error('❌ [Battleboard Delivery] Result=FAILED' +
          ' | Discord=' + serverId +
          ' | Battle=' + battleId +
          ' | Channel=' + channelId +
          ' | Part=' + partNumber + '/' + partsTotal +
          ' | Item=' + partLabel +
          ' | File=' + fileName +
          ' | BattleToFailure=' + elapsedFrom(battleStartedAtMs, failedAtMs) +
          ' | EventCheckToFailure=' + elapsedFrom(eventCheckedAtMs, failedAtMs) +
          ' | channel.send=' + sendRoundTripMs + 'ms' +
          ' | Error=' + String(sendError && sendError.message || sendError).slice(0, 200));
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
        sendStartedAt: new Date(sendStartedAtMs).toISOString(),
        discordMessageAt: new Date(discordMessageAtMs).toISOString(),
        sendRoundTripMs,
        battleToDiscordMs: battleStartedAtMs ? Math.max(0, discordMessageAtMs - battleStartedAtMs) : null,
        eventCheckToDiscordMs: eventCheckedAtMs ? Math.max(0, discordMessageAtMs - eventCheckedAtMs) : null,
      };
      record.partTimings.push(timing);
      if (record.partTimings.length > 100) record.partTimings.splice(0, record.partTimings.length - 100);
      record.partsSent = Math.max(Number(record.partsSent) || 0, partNumber);
      record.lastPartSentAt = timing.discordMessageAt;
      saveDelivery(state, record);

      console.log('📨 [Battleboard Delivery] Result=SENT' +
        ' | Discord=' + serverId +
        ' | Battle=' + battleId +
        ' | Channel=' + channelId +
        ' | Part=' + partNumber + '/' + partsTotal +
        ' | Item=' + partLabel +
        ' | File=' + fileName +
        ' | BattleToDiscord=' + elapsedFrom(battleStartedAtMs, discordMessageAtMs) +
        ' | EventCheckToDiscord=' + elapsedFrom(eventCheckedAtMs, discordMessageAtMs) +
        ' | channel.send=' + sendRoundTripMs + 'ms' +
        ' | DiscordMessageAt=' + new Date(discordMessageAtMs).toISOString() + '.');
    };

    if (files.length) {
      if ((Number(record.partsSent) || 0) < 1) {
        await sendPart(
          { content: alertText, files: [files[0]], allowedMentions: { parse: [] } },
          'ข้อความแจ้งเตือน + รูปที่ 1',
          1,
          getAttachmentName(files[0], 'report-image-1')
        );
      }
      for (let index = 1; index < files.length; index++) {
        if ((Number(record.partsSent) || 0) >= index + 1) continue;
        await sendPart(
          { files: [files[index]], allowedMentions: { parse: [] } },
          'รูปที่ ' + (index + 1),
          index + 1,
          getAttachmentName(files[index], 'report-image-' + (index + 1))
        );
      }
    } else if ((Number(record.partsSent) || 0) < 1) {
      await sendPart({
        content: alertText + '\n' + String(report.payload && report.payload.content || ''),
        allowedMentions: { parse: [] },
      }, 'ข้อความแจ้งเตือน (ไม่มีรูป)', 1, 'ไม่มีไฟล์แนบ');
    }

    const completedAtMs = Date.now();
    const finalDiscordAtMs = toTimestampMs(record.lastPartSentAt) || completedAtMs;
    const firstAttemptAtMs = toTimestampMs(record.firstDeliveryAttemptAt) || attemptStartedAtMs;
    record.status = 'sent';
    record.partsTotal = partsTotal;
    record.sentAt = new Date(finalDiscordAtMs).toISOString();
    record.totalBattleToDiscordMs = battleStartedAtMs ? Math.max(0, finalDiscordAtMs - battleStartedAtMs) : null;
    record.totalEventCheckToDiscordMs = eventCheckedAtMs ? Math.max(0, finalDiscordAtMs - eventCheckedAtMs) : null;
    record.deliveryWindowMs = Math.max(0, completedAtMs - firstAttemptAtMs);
    saveDelivery(state, record);

    console.log('✅ [Battleboard Delivery] Result=COMPLETE' +
      ' | Discord=' + serverId +
      ' | Battle=' + battleId +
      ' | Channel=' + channelId +
      ' | Sent=' + (Number(record.partsSent) || 0) + '/' + partsTotal +
      ' | BattleToLastDiscordFile=' + elapsedFrom(battleStartedAtMs, finalDiscordAtMs) +
      ' | EventCheckToLastDiscordFile=' + elapsedFrom(eventCheckedAtMs, finalDiscordAtMs) +
      ' | DeliveryWindow=' + record.deliveryWindowMs + 'ms' +
      ' | LastDiscordMessageAt=' + new Date(finalDiscordAtMs).toISOString() + '.');
  }
  async function processEvent(serverId, guildConfig, state, event) {
    const battleId = String(event && event.battle_id || '').trim();
    if (!/^\d+$/.test(battleId)) return true;
    const detailResponse = await fetchDetail(battleId);
    if (Number(detailResponse.status) === 404) return true;
    if (detailResponse.ready !== true || !detailResponse.detail || Number(detailResponse.detailSchemaVersion || 0) < 4) {
      console.log('⏳ [Battleboard] Detail pending; retrying | Discord=' + serverId + ' | Battle=' + battleId);
      return false;
    }
    const detail = detailResponse.detail;
    const routes = getRoutes(guildConfig, detail, event);
    if (!routes.length) {
      console.log('ℹ️ [Battleboard] No matching Auto-Battle source/channel | Discord=' + serverId + ' | Battle=' + battleId);
      return true;
    }
    const players = trackedPlayers(guildConfig);
    const guilds = trackedGuilds(guildConfig);
    if (!players.length && !guilds.length) return true;
    const report = await buildBattleReportPayload(battleId, [], {
      autoBattle: true, guildId: serverId, apiData: detail, trackedPlayers: players, trackedGuilds: guilds,
    });
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
        saveDelivery(state, {
          key, battleId, channelId, status: 'below-threshold',
          totalFame: Number(report.totalFame || 0), minFame: route.minFame, checkedAt: new Date().toISOString(),
        });
        console.log('ℹ️ [Battleboard] Below Fame threshold | Battle=' + battleId +
          ' | Fame=' + formatFame(report.totalFame) + ' | Required=' + formatFame(route.minFame));
        continue;
      }
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel || typeof channel.send !== 'function') throw new Error('Auto-Battle channel unavailable: ' + channelId);
      await deliver(channel, channelId, battleId, report, route.targets, state, serverId, event);
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
          console.error('❌ [Battleboard] Poll failed | Discord=' + serverId +
            ' | RetryIn=' + Math.ceil(delay / 1000) + 's | Error=' + String(error && error.message || error).slice(0, 260));
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
  __test: { normalizeName, validDiscordServerId, buildTrackedItems, getBattleGuilds, targetGuildMatches, deliveryKey, toTimestampMs, formatElapsedMs, getAttachmentName, snapshotFingerprint, isSnapshotSyncDue, retryDelayMs, needsEmptySnapshotCleanup },
};
