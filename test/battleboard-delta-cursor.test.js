const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeBattleboardPendingItems, validCursor } = require('../battleboard-delta-cursor');

const next = { after: '2026-11-08T15:30:00.123Z', afterId: '527700001' };

test('stores matching unprocessed Battles and allows cursor to advance when pending queue is persisted', () => {
  const result = mergeBattleboardPendingItems({
    items: [{ id: '527700001', _battleboardFirstSeenAt: '2026-11-08T15:20:00.000Z' }],
    nextCursor: next,
    matchesTarget: () => true,
    processedIds: new Set(),
    existingPending: [],
  });
  assert.equal(result.shouldAdvance, true);
  assert.deepEqual(result.cursor, next);
  assert.equal(result.pendingItems.length, 1);
  assert.equal(result.pendingItems[0].id, '527700001');
  assert.equal(result.pendingItems[0].firstSeenAt, Date.parse('2026-11-08T15:20:00.000Z'));
});

test('keeps old pending Battles and removes IDs already processed', () => {
  const result = mergeBattleboardPendingItems({
    items: [{ id: '527700003' }],
    nextCursor: next,
    matchesTarget: () => true,
    processedIds: new Set(['527700001']),
    existingPending: [
      { id: '527700001', firstSeenAt: 1000 },
      { id: '527700002', firstSeenAt: 2000 },
    ],
  });
  assert.equal(result.shouldAdvance, true);
  assert.deepEqual(result.pendingItems.map(item => item.id), ['527700002', '527700003']);
});

test('does not advance cursor if the pending queue limit would drop a matching Battle', () => {
  const existing = Array.from({ length: 2 }, (_, index) => ({
    id: String(527700010 + index), firstSeenAt: 1000 + index
  }));
  const result = mergeBattleboardPendingItems({
    items: [{ id: '527700012' }],
    nextCursor: next,
    matchesTarget: () => true,
    processedIds: new Set(),
    existingPending: existing,
    maxPending: 2,
  });
  assert.equal(result.shouldAdvance, false);
  assert.equal(result.overflowItems.length, 1);
  assert.equal(result.pendingItems.length, 2);
});

test('advances over pages with no matching or already processed Battles', () => {
  const result = mergeBattleboardPendingItems({
    items: [{ id: '527700001' }],
    nextCursor: next,
    matchesTarget: () => true,
    processedIds: new Set(['527700001']),
    existingPending: [],
  });
  assert.equal(result.shouldAdvance, true);
  assert.deepEqual(result.cursor, next);
  assert.equal(result.pendingItems.length, 0);
});

test('requires a valid timestamp and numeric tie-break Battle ID', () => {
  assert.equal(validCursor(next), true);
  assert.equal(validCursor({ after: 'not-a-date', afterId: '527700001' }), false);
  assert.equal(validCursor({ after: next.after, afterId: 'bad' }), false);
});
