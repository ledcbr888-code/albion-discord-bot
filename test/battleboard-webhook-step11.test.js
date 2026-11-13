'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac, randomUUID } = require('node:crypto');
const { createBattleWebhookReceiver } = require('../battleboard-webhook-receiver');
const SECRET = 'step11-test-shared-secret-32-characters-long';
const time = Date.parse('2026-11-13T16:00:00Z');
function attempt(receiver, { battleId = '528911249', timestamp = time, nonce = randomUUID(),
  secret = SECRET, signature = null, key = 'asia:' + battleId, server = 'asia',
  event = 'battle.discovered', bodyOverride = null } = {}) {
  const raw = Buffer.from(bodyOverride || JSON.stringify({
    event, battleId, server, firstSeenAt: '2026-11-13T15:59:00Z', source: 'battles',
  }));
  const signed = signature || 'sha256=' + createHmac('sha256', secret)
    .update(String(timestamp) + '.' + nonce + '.').update(raw).digest('hex');
  const headers = { 'x-battleboard-timestamp': String(timestamp), 'x-battleboard-nonce': nonce,
    'x-battleboard-signature': signed, 'idempotency-key': key };
  const req = { body: raw, get: name => headers[name.toLowerCase()] };
  const res = { statusCode: 0, body: null, status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; } };
  receiver(req, res);
  return res.statusCode;
}
test('Step 11 rejects unsigned/incorrect HMAC and never wakes the bot', () => {
  const accepted = [];
  const receiver = createBattleWebhookReceiver({ secret: SECRET, now: () => time,
    onBattle: b => { accepted.push(b); return true; } });
  assert.equal(attempt(receiver, { battleId: '90001', secret: 'invalid-secret-00000000000000000000' }), 401);
  assert.equal(attempt(receiver, { battleId: '90001', signature: 'sha256=' + '0'.repeat(64) }), 401);
  assert.equal(accepted.length, 0);
});
test('Step 11 verifies timestamp, matching Asia key, payload and protects against replay', () => {
  const accepted = [];
  const receiver = createBattleWebhookReceiver({ secret: SECRET, now: () => time,
    onBattle: b => { accepted.push(b); return true; } });
  assert.equal(attempt(receiver, { battleId: '90002', timestamp: time - 360000 }), 401);
  assert.equal(attempt(receiver, { battleId: '90002', key: 'asia:12345' }), 400);
  assert.equal(attempt(receiver, { battleId: '90002', server: 'east' }), 400);
  const nonce = randomUUID();
  assert.equal(attempt(receiver, { battleId: '90002', nonce }), 202);
  assert.equal(attempt(receiver, { battleId: '90002', nonce }), 409);
  assert.equal(attempt(receiver, { battleId: '90002' }), 200);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].battleId, '90002');
});
test('Step 11 fails closed without secret or available integration', () => {
  assert.equal(attempt(createBattleWebhookReceiver({ now: () => time }), { battleId: '90003' }), 503);
  const unavailable = createBattleWebhookReceiver({ secret: SECRET, now: () => time, onBattle: () => false });
  assert.equal(attempt(unavailable, { battleId: '90003' }), 503);
  const available = createBattleWebhookReceiver({ secret: SECRET, now: () => time, onBattle: () => true });
  assert.equal(attempt(available, { battleId: '90003' }), 202);
});
