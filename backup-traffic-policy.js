'use strict';
const { createHash } = require('node:crypto');

const TRANSIENT_FIELD_NAMES = new Set([
  'lastCheckedAt', 'last_checked_at', 'lastPollAt', 'lastPolledAt',
  'lastEventsPollSuccessLogAt', 'lastSnapshotSyncAt', 'lastApiLatency',
  'lastLatencyMs', 'lastHeartbeatAt', 'heartbeat', 'runtimeCounters',
  'processId', 'schedulerTick', 'lastLogAt', 'lastDebugAt',
  'lastEventKey', 'lastMessageId', 'banditConfirmations', 'banditNotOccurred',
]);
const GUILD_RUNTIME_FIELDS = new Set([
  'battleboardState', 'processedBattles', 'avaProcessedMessages',
  'avaMessageStates', 'ctaEvents', 'lastBanditAlertKey',
  'dailyBonusState', 'dailySourceStatus',
]);
function removeTransientFields(input) {
  if (Array.isArray(input)) return input.map(removeTransientFields);
  if (!input || typeof input !== 'object') return input;
  const output = {};
  for (const [key, value] of Object.entries(input)) {
    if (!TRANSIENT_FIELD_NAMES.has(key)) output[key] = removeTransientFields(value);
  }
  return output;
}
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonicalize(item)])
  );
}
function configFingerprint(input) {
  const data = typeof input === 'string' ? JSON.parse(input) : input;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new TypeError('Backup must be a JSON object');
  const guilds = {};
  for (const [id, config] of Object.entries(data.guilds || {})) {
    const retained = {};
    for (const [key, value] of Object.entries(config || {})) {
      if (!GUILD_RUNTIME_FIELDS.has(key)) retained[key] = removeTransientFields(value);
    }
    guilds[id] = retained;
  }
  // Only meaningful configuration changes should create an urgent GitHub mirror.
  const stable = { version: data.version, guilds };
  return createHash('sha256').update(JSON.stringify(canonicalize(stable))).digest('hex');
}
function createGitHubMirrorPolicy({ now = Date.now, dailyIntervalMs = 24 * 60 * 60 * 1000 } = {}) {
  let lastQueuedHash = null;
  let lastQueuedAt = null;
  return {
    shouldMirror(snapshot, { force = false } = {}) {
      const fingerprint = configFingerprint(snapshot);
      return force || fingerprint !== lastQueuedHash ||
        lastQueuedAt === null || now() - lastQueuedAt >= dailyIntervalMs;
    },
    markQueued(snapshot) {
      lastQueuedHash = configFingerprint(snapshot);
      lastQueuedAt = now();
    },
    dueDaily() { return lastQueuedAt === null || now() - lastQueuedAt >= dailyIntervalMs; },
    getStatus() { return { lastQueuedAt, lastQueuedHash }; },
  };
}
function createTrafficMeter({ log = console.log, now = Date.now, intervalMs = 15 * 60 * 1000 } = {}) {
  const counters = new Map();
  let lastLogAt = now();
  function record(destination, operation, requestBytes, responseBytes = 0, success = true) {
    const key = String(destination) + '/' + String(operation);
    const item = counters.get(key) || { requests: 0, outgoingBytes: 0, incomingBytes: 0, failures: 0 };
    item.requests++;
    item.outgoingBytes += Math.max(0, Number(requestBytes) || 0);
    item.incomingBytes += Math.max(0, Number(responseBytes) || 0);
    if (!success) item.failures++;
    counters.set(key, item);
    if (now() - lastLogAt >= intervalMs) flush();
  }
  function flush() {
    if (!counters.size) return;
    for (const [key, value] of counters) {
      log('[Bandwidth] ' + key + ' | operations=' + value.requests +
        ' | outgoingBytes=' + value.outgoingBytes +
        ' | incomingBytes=' + value.incomingBytes +
        ' | failures=' + value.failures);
    }
    counters.clear();
    lastLogAt = now();
  }
  return { record, flush };
}
module.exports = { configFingerprint, createGitHubMirrorPolicy, createTrafficMeter };
