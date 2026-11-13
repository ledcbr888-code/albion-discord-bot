'use strict';
const { createHmac, timingSafeEqual } = require('node:crypto');

// Signed raw-body protocol. Never trust an unsigned Battle ID or timestamp.
const MAX_SKEW_MS = 5 * 60_000;
const MAX_CACHE_SIZE = 4096;
const replay = new Map();
function createBattleWebhookReceiver({ secret, onBattle, now = () => Date.now() } = {}) {
  const key = String(secret || '').trim();
  const wake = typeof onBattle === 'function' ? onBattle : () => false;
  function receive(req, res) {
    const reply = (code, message) => res.status(code).json({ ok: code < 400, message });
    if (key.length < 32) return reply(503, 'Webhook is not configured');
    const raw = req.body;
    if (!Buffer.isBuffer(raw) || raw.length < 2 || raw.length > 16 * 1024) return reply(400, 'Invalid payload');
    const timestamp = String(req.get('x-battleboard-timestamp') || '');
    const nonce = String(req.get('x-battleboard-nonce') || '');
    const signature = String(req.get('x-battleboard-signature') || '');
    const idempotency = String(req.get('idempotency-key') || '');
    if (!/^\d{13}$/.test(timestamp) || !/^[a-f0-9-]{20,64}$/i.test(nonce) ||
      !/^sha256=[a-f0-9]{64}$/i.test(signature) || !/^asia:\d{1,20}$/.test(idempotency)) {
      return reply(401, 'Invalid authentication headers');
    }
    const current = now();
    if (Math.abs(current - Number(timestamp)) > MAX_SKEW_MS) return reply(401, 'Expired timestamp');
    const expected = createHmac('sha256', key)
      .update(timestamp + '.' + nonce + '.').update(raw).digest();
    const supplied = Buffer.from(signature.slice(7), 'hex');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      return reply(401, 'Invalid signature');
    }
    let data;
    try { data = JSON.parse(raw.toString('utf8')); } catch { return reply(400, 'Invalid JSON'); }
    const id = String(data?.battleId ?? '');
    if (data?.event !== 'battle.discovered' || data?.server !== 'asia' ||
      !/^\d{1,20}$/.test(id) || idempotency !== 'asia:' + id ||
      !Number.isFinite(Date.parse(data?.firstSeenAt)) || typeof data?.source !== 'string' ||
      !['battles', 'events', 'guild_fast_lane', 'player_fast_lane'].includes(data.source)) {
      return reply(400, 'Invalid Battle event');
    }
    for (const [cacheKey, expires] of replay) if (expires <= current) replay.delete(cacheKey);
    if (replay.has('nonce:' + nonce)) return reply(409, 'Replay detected');
    if (replay.has('battle:' + idempotency)) return reply(200, 'Already accepted');
    if (replay.size >= MAX_CACHE_SIZE) {
      // Fail closed instead of silently evicting recent replay protection.
      return reply(503, 'Webhook replay cache is full');
    }
    replay.set('nonce:' + nonce, current + MAX_SKEW_MS);
    replay.set('battle:' + idempotency, current + MAX_SKEW_MS);
    try { wake({ battleId: id, server: 'asia', firstSeenAt: data.firstSeenAt, source: data.source }); }
    catch { return reply(503, 'Discovery wake unavailable'); }
    return reply(202, 'Accepted');
  }
  return receive;
}
module.exports = { createBattleWebhookReceiver, MAX_SKEW_MS };
