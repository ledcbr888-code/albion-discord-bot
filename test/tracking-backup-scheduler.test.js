'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTrackingBackupScheduler, fingerprintTrackingSnapshot } = require('../tracking-backup-scheduler');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('coalesces a burst of saves and writes only the latest snapshot', async () => {
  const writes = [];
  const scheduler = createTrackingBackupScheduler({
    debounceMs: 10,
    minIntervalMs: 0,
    write: async snapshot => { writes.push(JSON.parse(snapshot)); },
  });
  try {
    scheduler.enqueue(JSON.stringify({ value: 1, updatedAt: 'first' }));
    scheduler.enqueue(JSON.stringify({ value: 2, updatedAt: 'second' }));
    scheduler.enqueue(JSON.stringify({ value: 3, updatedAt: 'latest' }));
    await wait(40);
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0], { value: 3, updatedAt: 'latest' });
  } finally {
    scheduler.stop();
  }
});

test('enforces a minimum write interval and keeps only the newest pending snapshot', async () => {
  const writes = [];
  const scheduler = createTrackingBackupScheduler({
    debounceMs: 5,
    minIntervalMs: 50,
    write: async snapshot => { writes.push({ value: JSON.parse(snapshot).value, at: Date.now() }); },
  });
  try {
    scheduler.enqueue(JSON.stringify({ value: 1 }));
    await wait(15);
    assert.equal(writes.length, 1);
    scheduler.enqueue(JSON.stringify({ value: 2 }));
    scheduler.enqueue(JSON.stringify({ value: 3 }));
    await wait(20);
    assert.equal(writes.length, 1, 'the second write must respect the minimum interval');
    await wait(50);
    assert.equal(writes.length, 2);
    assert.equal(writes[1].value, 3, 'intermediate state should be coalesced');
    assert.ok(writes[1].at - writes[0].at >= 45);
  } finally {
    scheduler.stop();
  }
});

test('ignores updatedAt-only changes and unchanged snapshots', async () => {
  const writes = [];
  const scheduler = createTrackingBackupScheduler({
    debounceMs: 5,
    minIntervalMs: 0,
    write: async snapshot => { writes.push(JSON.parse(snapshot)); },
  });
  try {
    scheduler.markSaved(JSON.stringify({ value: 1, updatedAt: 'loaded-from-remote' }));
    assert.equal(
      fingerprintTrackingSnapshot({ value: 1, updatedAt: 'different-write-time' }),
      fingerprintTrackingSnapshot({ value: 1, updatedAt: 'loaded-from-remote' })
    );
    scheduler.enqueue(JSON.stringify({ value: 1, updatedAt: 'new-local-save' }));
    await wait(20);
    assert.equal(writes.length, 0, 'updatedAt by itself must not trigger a remote write');

    scheduler.enqueue(JSON.stringify({ value: 2, updatedAt: 'changed-data' }));
    await wait(20);
    assert.equal(writes.length, 1);
    scheduler.enqueue(JSON.stringify({ value: 2, updatedAt: 'later-write-time' }));
    await wait(20);
    assert.equal(writes.length, 1, 'an unchanged successful snapshot must not be written again');
  } finally {
    scheduler.stop();
  }
});

test('retries a failed backup and preserves the newest pending snapshot', async () => {
  const writes = [];
  const errors = [];
  let attempts = 0;
  const scheduler = createTrackingBackupScheduler({
    debounceMs: 1,
    minIntervalMs: 0,
    retryBaseMs: 10,
    retryMaxMs: 20,
    write: async snapshot => {
      attempts++;
      writes.push(JSON.parse(snapshot).value);
      if (attempts === 1) throw new Error('temporary network failure');
    },
    onError: (error, failureCount) => errors.push({ message: error.message, failureCount }),
  });
  try {
    scheduler.enqueue(JSON.stringify({ value: 'latest-state' }));
    await wait(60);
    assert.equal(attempts, 2);
    assert.deepEqual(writes, ['latest-state', 'latest-state']);
    assert.deepEqual(errors, [{ message: 'temporary network failure', failureCount: 1 }]);
    assert.equal(scheduler.getStatus().failureCount, 0);
  } finally {
    scheduler.stop();
  }
});

test('a newer snapshot arriving during a write supersedes older pending work', async () => {
  const writes = [];
  let releaseFirst;
  let firstStarted;
  const started = new Promise(resolve => { firstStarted = resolve; });
  const scheduler = createTrackingBackupScheduler({
    debounceMs: 1,
    minIntervalMs: 0,
    write: async snapshot => {
      const value = JSON.parse(snapshot).value;
      writes.push(value);
      if (value === 1) {
        firstStarted();
        await new Promise(resolve => { releaseFirst = resolve; });
      }
    },
  });
  try {
    scheduler.enqueue(JSON.stringify({ value: 1 }));
    await started;
    scheduler.enqueue(JSON.stringify({ value: 2 }));
    scheduler.enqueue(JSON.stringify({ value: 3 }));
    releaseFirst();
    await wait(40);
    assert.deepEqual(writes, [1, 3]);
  } finally {
    scheduler.stop();
  }
});
