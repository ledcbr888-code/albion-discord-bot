'use strict';

const DEDUPE_TTL_MS = 10 * 60 * 1000;
const MAX_REMEMBERED_IDS = 2000;
const MAX_BATCH_SIZE = 100;
const REQUEST_TIMEOUT_MS = 4500;
const LOG_THROTTLE_MS = 5 * 60 * 1000;

function normalizeBattleId(value) {
  const id = String(value ?? '').trim();
  if (!/^\\d{1,20}$/.test(id)) return null;
  try { return BigInt(id) > 0n ? id : null; }
  catch { return null; }
}

function createBattleboardDiscoveryShadow(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || ((...args) => global.fetch(...args));
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const logger = options.logger || console;
  const timeoutMs = Math.max(500, Math.min(15000, Number(options.timeoutMs) || REQUEST_TIMEOUT_MS));
  const recentlySubmitted = new Map();
  const pendingIds = new Set();
  let lastWarningAt = Number.NEGATIVE_INFINITY;
  let lastSuccessAt = Number.NEGATIVE_INFINITY;

  function logWarning(message) {
    const at = now();
    if (at - lastWarningAt < LOG_THROTTLE_MS) return;
    lastWarningAt = at;
    try { logger.warn('⚠️ [Battleboard Discovery Shadow] ' + message); } catch {}
  }

  function logSuccess(count) {
    const at = now();
    if (at - lastSuccessAt < LOG_THROTTLE_MS) return;
    lastSuccessAt = at;
    try {
      logger.log('🛰️ [Battleboard Discovery Shadow] ส่ง Battle ID จาก Official Events เข้าคิวกลางสำเร็จ' +
        ' | แหล่ง=official_events_shadow | ใหม่=' + count + ' | เซิร์ฟเวอร์=Asia');
    } catch {}
  }

  function getConfig() {
    const enabled = String(env.BATTLEBOARD_DISCOVERY_SHADOW_ENABLED || '').trim().toLowerCase() === 'true';
    if (!enabled) return { enabled: false, reason: 'disabled' };

    const baseUrl = String(env.BATTLEBOARD_API_URL || '').trim().replace(/\\/+$/, '');
    const apiKey = String(env.BOT_API_KEY || '').trim();
    if (!baseUrl || apiKey.length < 32) return { enabled: true, reason: 'missing-config' };

    try {
      if (new URL(baseUrl).protocol !== 'https:') return { enabled: true, reason: 'https-required' };
    } catch {
      return { enabled: true, reason: 'invalid-url' };
    }
    return { enabled: true, baseUrl, apiKey };
  }

  function prune(nowMs) {
    for (const [id, expiresAt] of recentlySubmitted) {
      if (expiresAt <= nowMs) recentlySubmitted.delete(id);
    }
    while (recentlySubmitted.size > MAX_REMEMBERED_IDS) {
      recentlySubmitted.delete(recentlySubmitted.keys().next().value);
    }
  }

  async function postBatch(config, ids) {
    const response = await fetchImpl(config.baseUrl + '/api/bot-discovery', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + config.apiKey,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        server: 'asia',
        items: ids.map(battleId => ({
          battleId,
          source: 'official_events_shadow',
          observedAt: new Date(now()).toISOString(),
        })),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const text = await response.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); }
      catch { data = null; }
    }
    if (!response.ok || !data || data.ok !== true) {
      throw new Error('HTTP ' + Number(response.status || 0) +
        (data && data.error ? ' (' + String(data.error).slice(0, 140) + ')' : ''));
    }
    return data;
  }

  async function submit(battleIds) {
    const config = getConfig();
    if (!config.enabled) return { ok: true, skipped: 'disabled', submitted: 0 };
    if (!config.baseUrl) {
      const reason = config.reason || 'missing-config';
      logWarning(reason === 'missing-config'
        ? 'เปิด Feature Flag แล้ว แต่ยังไม่มี BATTLEBOARD_API_URL หรือ BOT_API_KEY ที่ถูกต้อง'
        : 'ค่าตั้งค่า API ไม่ถูกต้อง (' + reason + ')');
      return { ok: false, reason, submitted: 0 };
    }

    const nowMs = now();
    prune(nowMs);
    const normalized = [...new Set((Array.isArray(battleIds) ? battleIds : [])
      .map(normalizeBattleId).filter(Boolean))];
    if (!normalized.length) return { ok: true, skipped: 'no-valid-battle-ids', submitted: 0 };

    const fresh = normalized.filter(id => !recentlySubmitted.has(id) && !pendingIds.has(id));
    if (!fresh.length) return { ok: true, skipped: 'duplicate', submitted: 0 };

    for (const id of fresh) pendingIds.add(id);
    let submitted = 0;
    let currentBatch = [];
    try {
      for (let offset = 0; offset < fresh.length; offset += MAX_BATCH_SIZE) {
        currentBatch = fresh.slice(offset, offset + MAX_BATCH_SIZE);
        await postBatch(config, currentBatch);
        const expiry = now() + DEDUPE_TTL_MS;
        for (const id of currentBatch) recentlySubmitted.set(id, expiry);
        submitted += currentBatch.length;
        prune(now());
      }
      if (submitted > 0) logSuccess(submitted);
      return {
        ok: true,
        server: 'asia',
        source: 'official_events_shadow',
        submitted,
        skipped: normalized.length - fresh.length,
      };
    } catch (error) {
      logWarning('ส่งข้อมูลเข้า API ไม่สำเร็จ; Auto-Battle หลักทำงานต่อได้และรอการพบ Event รอบถัดไป' +
        ' | รายการในชุดที่ล้มเหลว=' + currentBatch.length +
        ' | สาเหตุ=' + String(error && error.message || error).slice(0, 180));
      return {
        ok: false,
        source: 'official_events_shadow',
        submitted,
        failedBatchSize: currentBatch.length,
        error: String(error && error.message || error).slice(0, 180),
      };
    } finally {
      for (const id of fresh) pendingIds.delete(id);
    }
  }

  return {
    submit,
    isEnabled: () => getConfig().enabled,
  };
}

module.exports = {
  createBattleboardDiscoveryShadow,
  __test: { normalizeBattleId },
};
