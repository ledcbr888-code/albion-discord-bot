'use strict';

// Process-local scheduler state. No HTTP calls or persistence.
function rotateScannerOrder(items, start = 0) {
    const list = Array.isArray(items) ? [...items] : [];
    if (!list.length) return list;
    const index = ((Math.trunc(Number(start) || 0) % list.length) + list.length) % list.length;
    return list.slice(index).concat(list.slice(0, index));
}

function createAlbionZvZCapacityQueue({
    now = Date.now, maxWaitMs = 120_000, retryDelayMs = 45_000, maxEntries = 1000
} = {}) {
    const pending = new Map();
    function isReady(key) {
        const entry = pending.get(String(key));
        return !entry || now() >= entry.nextAttemptAt;
    }
    function clear(key) { pending.delete(String(key)); }
    function onExhausted(key) {
        key = String(key);
        const at = now();
        const previous = pending.get(key);
        const firstAt = previous ? previous.firstAt : at;
        const waitedMs = Math.max(0, at - firstAt);
        if (waitedMs >= maxWaitMs) {
            pending.delete(key);
            return { defer: false, expired: true, waitedMs };
        }
        pending.delete(key);
        pending.set(key, { firstAt, nextAttemptAt: at + retryDelayMs });
        while (pending.size > maxEntries) pending.delete(pending.keys().next().value);
        return { defer: true, remainingMs: maxWaitMs - waitedMs, nextAttemptAt: at + retryDelayMs };
    }
    return { isReady, onExhausted, clear };
}

module.exports = { rotateScannerOrder, createAlbionZvZCapacityQueue };
