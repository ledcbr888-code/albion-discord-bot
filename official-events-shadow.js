'use strict';

const OFFICIAL_EVENTS_SOURCE = 'official_events_shadow';
const OFFICIAL_EVENTS_SERVER = 'asia';
const OFFICIAL_EVENTS_URL = 'https://gameinfo-sgp.albiononline.com/api/gameinfo/events';
const OFFICIAL_EVENTS_POLL_INTERVAL_MS = 120 * 1000;
const OFFICIAL_EVENTS_REQUEST_TIMEOUT_MS = 8000;
const OFFICIAL_EVENTS_PAGE_LIMIT = 51;
const OFFICIAL_EVENTS_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
const OFFICIAL_EVENTS_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MAX_SIGNED_BIGINT = 9223372036854775807n;

function validNumericId(value, maxLength = 20) {
  const raw = String(value == null ? '' : value).trim();
  if (!new RegExp('^\\d{1,' + maxLength + '}$').test(raw)) return null;
  try {
    const parsed = BigInt(raw);
    return parsed > 0n && parsed <= MAX_SIGNED_BIGINT ? raw : null;
  } catch {
    return null;
  }
}

function normalizeEventTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  const parsed = Number.isFinite(numeric) && numeric > 0
    ? new Date(numeric < 1e12 ? numeric * 1000 : numeric).getTime()
    : Date.parse(String(value));
  return Number.isFinite(parsed) && parsed > 0 ? new Date(parsed).toISOString() : null;
}

function keepSmallPayload(event) {
  const killer = event && event.Killer && typeof event.Killer === 'object' ? event.Killer : {};
  const victim = event && event.Victim && typeof event.Victim === 'object' ? event.Victim : {};
  return {
    eventId: validNumericId(event && (event.EventId ?? event.eventId ?? event.id), 24),
    battleId: validNumericId(event && (event.BattleId ?? event.battleId ?? event.battle_id)),
    timestamp: normalizeEventTimestamp(event && (event.TimeStamp ?? event.Timestamp ?? event.timestamp)),
    playerId: String(killer.Id ?? killer.id ?? '').slice(0, 80) || null,
    victimId: String(victim.Id ?? victim.id ?? '').slice(0, 80) || null,
    sourceServer: OFFICIAL_EVENTS_SERVER,
  };
}

function normalizeOfficialEvents(events, observedAt, retentionMs = OFFICIAL_EVENTS_RETENTION_MS) {
  const grouped = new Map();
  let invalidBattleIdCount = 0;
  let missingEventIdCount = 0;

  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) continue;
    const payload = keepSmallPayload(event);
    if (!payload.battleId) {
      invalidBattleIdCount++;
      continue;
    }
    if (!payload.eventId) missingEventIdCount++;
    if (grouped.has(payload.battleId)) continue;

    grouped.set(payload.battleId, {
      source: OFFICIAL_EVENTS_SOURCE,
      server: OFFICIAL_EVENTS_SERVER,
      battle_id: payload.battleId,
      event_id: payload.eventId,
      observed_at: observedAt,
      event_time: payload.timestamp,
      battle_finished_at: null,
      raw_payload: payload,
      is_new_battle: null,
      expires_at: new Date(Date.parse(observedAt) + retentionMs).toISOString(),
    });
  }

  return {
    rows: [...grouped.values()],
    distinctBattleIds: grouped.size,
    invalidBattleIdCount,
    missingEventIdCount,
  };
}

function parseRetryAfterMs(value, nowMs = Date.now()) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(15 * 60 * 1000, seconds * 1000);
  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) return Math.min(15 * 60 * 1000, Math.max(0, dateMs - nowMs));
  return null;
}

function formatLead(ms) {
  if (!Number.isFinite(ms)) return 'ยังคำนวณไม่ได้';
  const sign = ms > 0 ? '+' : ms < 0 ? '-' : '';
  const abs = Math.abs(ms);
  const seconds = Math.round(abs / 1000);
  const minutes = Math.floor(seconds / 60);
  const remain = seconds % 60;
  return sign + (minutes ? minutes + ' นาที ' : '') + remain + ' วินาที';
}

function buildInFilter(ids) {
  const values = [...new Set((Array.isArray(ids) ? ids : [])
    .map(value => validNumericId(value))
    .filter(Boolean))];
  return values.length ? 'in.(' + values.join(',') + ')' : null;
}

function createOfficialEventsShadowProbe(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || global.fetch;
  const http = options.http || require('axios');
  const logger = options.logger || console;
  const clock = typeof options.clock === 'function' ? options.clock : () => new Date();

  const supabaseUrl = String(options.supabaseUrl ?? env.SUPABASE_URL ?? '').trim().replace(/\\/+$/, '');
  const serviceRoleKey = String(options.serviceRoleKey ?? env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();
  const enabled = String(options.enabled ?? env.OFFICIAL_EVENTS_SHADOW_ENABLED ?? '').toLowerCase() === 'true';
  const enabledWithStorage = enabled && Boolean(supabaseUrl && serviceRoleKey);
  let running = false;
  let lastPrunedAtMs = 0;
  let consecutiveFailures = 0;
  let nextAllowedAtMs = 0;

  function nowDate() {
    const value = clock();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new Error('Shadow Probe clock returned an invalid timestamp.');
    return date;
  }

  function supabaseHeaders(prefer = 'return=representation') {
    return {
      apikey: serviceRoleKey,
      Authorization: 'Bearer ' + serviceRoleKey,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Prefer: prefer,
    };
  }

  function tableUrl(table) {
    return supabaseUrl + '/rest/v1/' + table;
  }

  async function fetchOfficialEvents() {
    if (typeof fetchImpl !== 'function') throw new Error('Global fetch is unavailable for Official Events API.');
    const url = new URL(OFFICIAL_EVENTS_URL);
    url.searchParams.set('limit', String(OFFICIAL_EVENTS_PAGE_LIMIT));
    url.searchParams.set('offset', '0');

    const response = await fetchImpl(url.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json', 'User-Agent': 'BOSS-BOT-Official-Events-Shadow/1.0' },
      signal: AbortSignal.timeout(OFFICIAL_EVENTS_REQUEST_TIMEOUT_MS),
    });
    const responseText = await response.text();
    let payload = null;
    if (responseText) {
      try { payload = JSON.parse(responseText); }
      catch { throw new Error('Official GameInfo Events returned invalid JSON (HTTP ' + response.status + ').'); }
    }
    if (!response.ok) {
      const error = new Error('Official GameInfo Events HTTP ' + response.status);
      error.status = Number(response.status);
      error.retryAfterMs = parseRetryAfterMs(response.headers && response.headers.get
        ? response.headers.get('retry-after') : null);
      throw error;
    }
    if (!Array.isArray(payload)) {
      throw new Error('Official GameInfo Events returned an unexpected payload; expected an array.');
    }
    return payload;
  }

  async function readExistingObservations(battleIds) {
    if (!battleIds.length) return [];
    const response = await http.get(tableUrl('discovery_observations'), {
      timeout: OFFICIAL_EVENTS_REQUEST_TIMEOUT_MS,
      headers: supabaseHeaders(),
      params: {
        source: 'eq.' + OFFICIAL_EVENTS_SOURCE,
        server: 'eq.' + OFFICIAL_EVENTS_SERVER,
        battle_id: buildInFilter(battleIds),
        select: 'battle_id,event_id,observed_at',
      },
    });
    return Array.isArray(response.data) ? response.data : [];
  }

  async function readBattleListFirstSeen(battleIds) {
    if (!battleIds.length) return { rows: [], ok: true };
    try {
      const response = await http.get(tableUrl('battle_history'), {
        timeout: OFFICIAL_EVENTS_REQUEST_TIMEOUT_MS,
        headers: supabaseHeaders(),
        params: {
          server: 'eq.' + OFFICIAL_EVENTS_SERVER,
          battle_id: buildInFilter(battleIds),
          select: 'battle_id,first_seen_at',
        },
      });
      return { rows: Array.isArray(response.data) ? response.data : [], ok: true };
    } catch (error) {
      logger.warn('[Official Events Shadow] Battle List lookup unavailable | HTTP=' +
        Number(error && error.response && error.response.status || 0) +
        ' | Error=' + String(error && error.response && error.response.data && error.response.data.message ||
          error && error.message || error).slice(0, 180));
      return { rows: [], ok: false };
    }
  }

  async function insertObservations(rows) {
    if (!rows.length) return [];
    const response = await http.post(tableUrl('discovery_observations'), rows, {
      timeout: OFFICIAL_EVENTS_REQUEST_TIMEOUT_MS,
      headers: supabaseHeaders('resolution=ignore-duplicates,return=representation'),
      params: { on_conflict: 'source,server,battle_id' },
    });
    return Array.isArray(response.data) ? response.data : [];
  }

  async function pruneExpiredObservations(now) {
    await http.delete(tableUrl('discovery_observations'), {
      timeout: OFFICIAL_EVENTS_REQUEST_TIMEOUT_MS,
      headers: supabaseHeaders('return=minimal'),
      params: {
        source: 'eq.' + OFFICIAL_EVENTS_SOURCE,
        server: 'eq.' + OFFICIAL_EVENTS_SERVER,
        expires_at: 'lt.' + now.toISOString(),
      },
    });
    lastPrunedAtMs = now.getTime();
    return true;
  }

  async function runOnce() {
    if (!enabled) return { ok: false, skipped: true, reason: 'disabled' };
    if (!supabaseUrl || !serviceRoleKey) {
      return { ok: false, skipped: true, reason: 'supabase-not-configured' };
    }
    if (running) return { ok: true, skipped: true, reason: 'already-running' };
    if (Date.now() < nextAllowedAtMs) {
      return { ok: false, skipped: true, reason: 'backoff-active', retryInMs: nextAllowedAtMs - Date.now() };
    }

    running = true;
    const startedAtMs = Date.now();
    const observedAt = nowDate().toISOString();
    try {
      const events = await fetchOfficialEvents();
      const normalized = normalizeOfficialEvents(events, observedAt);
      const battleIds = normalized.rows.map(row => row.battle_id);
      const [existingObservations, battleList] = await Promise.all([
        readExistingObservations(battleIds),
        readBattleListFirstSeen(battleIds),
      ]);

      const existingByBattleId = new Map(existingObservations.map(row => [
        String(row && row.battle_id || ''), row,
      ]));
      const battleListById = new Map(battleList.rows.map(row => [
        String(row && row.battle_id || ''), row,
      ]));

      const rowsToInsert = normalized.rows
        .filter(row => !existingByBattleId.has(row.battle_id))
        .map(row => ({
          ...row,
          is_new_battle: battleList.ok ? !battleListById.has(row.battle_id) : null,
        }));
      const insertedRows = await insertObservations(rowsToInsert);

      const sampleRows = normalized.rows.map(row => {
        const existing = existingByBattleId.get(row.battle_id);
        return existing ? { ...row, ...existing } : row;
      });

      const now = nowDate();
      let pruneAttempted = false;
      let pruneSucceeded = false;
      if (!lastPrunedAtMs || now.getTime() - lastPrunedAtMs >= OFFICIAL_EVENTS_PRUNE_INTERVAL_MS) {
        pruneAttempted = true;
        try {
          pruneSucceeded = await pruneExpiredObservations(now);
        } catch (error) {
          logger.warn('[Official Events Shadow] Cleanup failed | HTTP=' +
            Number(error && error.response && error.response.status || 0) +
            ' | Error=' + String(error && error.response && error.response.data && error.response.data.message ||
              error && error.message || error).slice(0, 180));
        }
      }

      const samples = sampleRows.slice(0, 8).map(row => {
        const battleListRow = battleListById.get(String(row.battle_id));
        const battleListFirstSeenAt = battleListRow && battleListRow.first_seen_at || null;
        const leadMs = battleListFirstSeenAt
          ? Date.parse(battleListFirstSeenAt) - Date.parse(row.observed_at)
          : null;
        return {
          battleId: row.battle_id,
          battleListSeen: Boolean(battleListFirstSeenAt),
          eventsFirstSeenAt: row.observed_at,
          battleListFirstSeenAt,
          leadMs: Number.isFinite(leadMs) ? leadMs : null,
        };
      });

      const result = {
        ok: true,
        server: OFFICIAL_EVENTS_SERVER,
        apiEventCount: events.length,
        eventsWithBattleId: events.filter(event => validNumericId(event && (
          event.BattleId ?? event.battleId ?? event.battle_id
        ))).length,
        invalidBattleIdCount: normalized.invalidBattleIdCount,
        missingEventIdCount: normalized.missingEventIdCount,
        distinctBattleIds: normalized.distinctBattleIds,
        insertedBattleRows: insertedRows.length,
        battleListMatched: samples.filter(sample => sample.battleListSeen).length,
        battleListLookupOk: battleList.ok,
        pageCapReached: events.length >= OFFICIAL_EVENTS_PAGE_LIMIT,
        pruneAttempted,
        pruneSucceeded,
        durationMs: Date.now() - startedAtMs,
        samples,
      };

      consecutiveFailures = 0;
      nextAllowedAtMs = 0;
      logger.info('[Official Events Shadow] Poll succeeded | ' + JSON.stringify({
        mode: 'shadow-only',
        source: OFFICIAL_EVENTS_SOURCE,
        productionQueueWrites: 0,
        ...result,
      }));
      return result;
    } catch (error) {
      consecutiveFailures++;
      const backoffMs = error && Number.isFinite(Number(error.retryAfterMs))
        ? Math.max(OFFICIAL_EVENTS_POLL_INTERVAL_MS, Number(error.retryAfterMs))
        : Math.min(15 * 60 * 1000, OFFICIAL_EVENTS_POLL_INTERVAL_MS * (2 ** Math.min(4, consecutiveFailures - 1)));
      nextAllowedAtMs = Date.now() + backoffMs;
      logger.warn('[Official Events Shadow] Poll failed | ' + JSON.stringify({
        mode: 'shadow-only',
        server: OFFICIAL_EVENTS_SERVER,
        failureCount: consecutiveFailures,
        retryInMs: backoffMs,
        httpStatus: Number(error && error.status || error && error.response && error.response.status || 0) || null,
        error: String(error && error.response && error.response.data && error.response.data.message ||
          error && error.message || error).slice(0, 220),
      }));
      return { ok: false, error: String(error && error.message || error).slice(0, 220), retryInMs: backoffMs };
    } finally {
      running = false;
    }
  }

  return {
    enabled: enabledWithStorage,
    runOnce,
    getStatus: () => ({
      enabled: enabledWithStorage,
      running,
      consecutiveFailures,
      nextAllowedAtMs,
      pollIntervalMs: OFFICIAL_EVENTS_POLL_INTERVAL_MS,
      pageLimit: OFFICIAL_EVENTS_PAGE_LIMIT,
      server: OFFICIAL_EVENTS_SERVER,
    }),
  };
}

module.exports = {
  createOfficialEventsShadowProbe,
  __test: {
    OFFICIAL_EVENTS_SOURCE,
    OFFICIAL_EVENTS_SERVER,
    OFFICIAL_EVENTS_URL,
    OFFICIAL_EVENTS_POLL_INTERVAL_MS,
    OFFICIAL_EVENTS_PAGE_LIMIT,
    OFFICIAL_EVENTS_RETENTION_MS,
    normalizeEventTimestamp,
    keepSmallPayload,
    normalizeOfficialEvents,
    parseRetryAfterMs,
    formatLead,
    buildInFilter,
  },
};
