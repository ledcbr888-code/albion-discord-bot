'use strict';

const { createHash } = require('node:crypto');

function fingerprintTrackingSnapshot(snapshot) {
  let parsed;
  try {
    parsed = typeof snapshot === 'string' ? JSON.parse(snapshot) : snapshot;
  } catch (error) {
    throw new Error('Tracking backup snapshot is not valid JSON: ' + error.message);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Tracking backup snapshot must be a JSON object.');
  }
  const fingerprintPayload = { ...parsed };
  // saveData() changes this metadata on every local write. It is not a data change.
  delete fingerprintPayload.updatedAt;
  return createHash('sha256').update(JSON.stringify(fingerprintPayload)).digest('hex');
}

function createTrackingBackupScheduler(options = {}) {
  if (typeof options.write !== 'function') throw new TypeError('A backup write function is required.');

  const write = options.write;
  const debounceMs = Math.max(0, Number(options.debounceMs) || 0);
  const minIntervalMs = Math.max(0, Number(options.minIntervalMs) || 0);
  const retryBaseMs = Math.max(1, Number(options.retryBaseMs) || 30000);
  const retryMaxMs = Math.max(retryBaseMs, Number(options.retryMaxMs) || 300000);
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const setTimer = typeof options.setTimeout === 'function' ? options.setTimeout : setTimeout;
  const clearTimer = typeof options.clearTimeout === 'function' ? options.clearTimeout : clearTimeout;
  const onSuccess = typeof options.onSuccess === 'function' ? options.onSuccess : () => {};
  const onError = typeof options.onError === 'function' ? options.onError : () => {};

  let pending = null;
  let inFlightFingerprint = null;
  let lastSavedFingerprint = null;
  let lastWriteAt = 0;
  let failureCount = 0;
  let timer = null;
  let stopped = false;
  let activeFlush = null;

  function cancelTimer() {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  }

  function schedule(delayMs = debounceMs) {
    if (stopped || !pending || inFlightFingerprint !== null) return;
    cancelTimer();
    const minimumWait = lastWriteAt
      ? Math.max(0, lastWriteAt + minIntervalMs - now())
      : 0;
    const waitMs = Math.max(Math.max(0, Number(delayMs) || 0), minimumWait);
    timer = setTimer(() => {
      timer = null;
      flush().catch(() => {});
    }, waitMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  async function flush() {
    if (stopped || !pending) return false;
    if (activeFlush) return activeFlush;

    const minimumWait = lastWriteAt
      ? Math.max(0, lastWriteAt + minIntervalMs - now())
      : 0;
    if (minimumWait > 0) {
      schedule(minimumWait);
      return false;
    }

    cancelTimer();
    const current = pending;
    pending = null;
    inFlightFingerprint = current.fingerprint;

    activeFlush = (async () => {
      try {
        await write(current.snapshot);
        lastWriteAt = now();
        lastSavedFingerprint = current.fingerprint;
        failureCount = 0;
        onSuccess();
        return true;
      } catch (error) {
        // Keep the newest snapshot. If a newer one arrived during the write,
        // it supersedes the failed snapshot and will be retried instead.
        if (!pending) pending = current;
        failureCount = Math.min(10, failureCount + 1);
        const retryDelay = Math.min(retryMaxMs, retryBaseMs * (2 ** (failureCount - 1)));
        onError(error, failureCount, retryDelay);
        return false;
      } finally {
        inFlightFingerprint = null;
        activeFlush = null;
        if (pending) {
          const retryDelay = failureCount
            ? Math.min(retryMaxMs, retryBaseMs * (2 ** (failureCount - 1)))
            : debounceMs;
          schedule(retryDelay);
        }
      }
    })();

    return activeFlush;
  }

  function enqueue(snapshot) {
    if (stopped) return false;
    const text = typeof snapshot === 'string' ? snapshot : JSON.stringify(snapshot);
    const fingerprint = fingerprintTrackingSnapshot(text);

    if (pending && pending.fingerprint === fingerprint) {
      // Keep the freshest serialization (including updatedAt) without
      // extending the debounce window for an identical data snapshot.
      pending.snapshot = text;
      return false;
    }
    if (inFlightFingerprint === fingerprint) {
      // The active write already contains this exact data state.
      pending = null;
      cancelTimer();
      return false;
    }
    if (!pending && inFlightFingerprint === null && lastSavedFingerprint === fingerprint) {
      return false;
    }

    // Replace the queued payload with the newest state, but retain the first
    // timer in this burst. Repeated saves must not postpone a backup forever.
    const hadPending = Boolean(pending);
    pending = { snapshot: text, fingerprint };
    if (!hadPending && inFlightFingerprint === null) {
      schedule(failureCount
        ? Math.min(retryMaxMs, retryBaseMs * (2 ** (failureCount - 1)))
        : debounceMs);
    }
    return true;
  }

  function markSaved(snapshot) {
    const text = typeof snapshot === 'string' ? snapshot : JSON.stringify(snapshot);
    lastSavedFingerprint = fingerprintTrackingSnapshot(text);
    if (pending && pending.fingerprint === lastSavedFingerprint) {
      pending = null;
      cancelTimer();
    }
  }

  function stop() {
    stopped = true;
    cancelTimer();
  }

  function getStatus() {
    return {
      pending: Boolean(pending),
      inFlight: inFlightFingerprint !== null,
      failureCount,
      lastWriteAt: lastWriteAt || null,
    };
  }

  return { enqueue, flush, markSaved, stop, getStatus };
}

module.exports = { createTrackingBackupScheduler, fingerprintTrackingSnapshot };
