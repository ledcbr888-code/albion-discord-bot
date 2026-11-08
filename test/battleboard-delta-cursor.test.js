const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateBattleboardDeltaPage, validCursor } = require('../battleboard-delta-cursor');

const next = { after: '2026-11-08T15:30:00.123Z', afterId: '527700001' };

test('does not advance cursor while a matching Battle is still unprocessed', () => {
  const result = evaluateBattleboardDeltaPage({
    items: [{ id: '527700001' }, { id: '527700002' }],
    nextCursor: next,
    matchesTarget: () => true,
    processedIds: new Set(['527700002']),
  });
  assert.equal(result.shouldAdvance, false);
  assert.equal(result.cursor, null);
  assert.deepEqual(result.pendingItems.map((item) => item.id), ['527700001']);
});

test('advances cursor over pages with no matching tracked Battle', () => {
  const result = evaluateBattleboardDeltaPage({
    items: [{ id: '527700001' }],
    nextCursor: next,
    matchesTarget: () => false,
    processedIds: new Set(),
  });
  assert.equal(result.shouldAdvance, true);
  assert.deepEqual(result.cursor, next);
  assert.equal(result.pendingItems.length, 0);
});

test('advances cursor when every matching Battle has already been handled', () => {
  const result = evaluateBattleboardDeltaPage({
    items: [{ id: '527700001' }, { id: '527700002' }],
    nextCursor: next,
    matchesTarget: () => true,
    processedIds: new Set(['527700001', '527700002']),
  });
  assert.equal(result.shouldAdvance, true);
  assert.deepEqual(result.cursor, next);
});

test('requires a valid timestamp and numeric tie-break Battle ID', () => {
  assert.equal(validCursor(next), true);
  assert.equal(validCursor({ after: 'not-a-date', afterId: '527700001' }), false);
  assert.equal(validCursor({ after: next.after, afterId: 'bad' }), false);
});
