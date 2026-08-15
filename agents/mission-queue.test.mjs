import assert from 'node:assert/strict';
import test from 'node:test';
import { MissionQueue } from './mission-queue.mjs';

test('claims by priority and capability', () => {
  let now = 1000;
  const q = new MissionQueue({ now: () => now });
  q.enqueue({ task: 'low', priority: 1, requiredCapabilities: ['qa'] });
  const high = q.enqueue({ task: 'high', priority: 9, requiredCapabilities: ['qa'] });
  assert.equal(q.claim({ id: 'w1', capabilities: ['qa'] }).id, high.id);
  assert.equal(q.stats().running, 1);
});

test('worker without required capability cannot claim', () => {
  const q = new MissionQueue();
  q.enqueue({ task: 'review', requiredCapabilities: ['qa'] });
  assert.equal(q.claim({ id: 'coder', capabilities: ['coder'] }), null);
  assert.equal(q.stats().queued, 1);
});

test('expired lease is retried then permanently failed', () => {
  let now = 0;
  const q = new MissionQueue({ maxAttempts: 2, leaseMs: 10, now: () => now });
  const m = q.enqueue({ task: 'synthetic defensive benchmark' });
  assert.equal(q.claim({ id: 'w1' }).attempts, 1);
  now = 11; assert.equal(q.requeueExpired(), 1);
  assert.equal(q.get(m.id).status, 'queued');
  assert.equal(q.claim({ id: 'w2' }).attempts, 2);
  now = 22; q.requeueExpired();
  assert.equal(q.get(m.id).status, 'failed');
});

test('expired owner cannot heartbeat or complete stale lease', () => {
  let now = 0;
  const q = new MissionQueue({ leaseMs: 10, now: () => now });
  const m = q.enqueue({ task: 'benchmark' });
  q.claim({ id: 'w1' });
  now = 11;
  assert.throws(() => q.heartbeat(m.id, 'w1'), /lease expired/);
  assert.throws(() => q.complete(m.id, 'w1'), /lease expired/);
  q.requeueExpired();
  assert.equal(q.get(m.id).status, 'queued');
});

test('only owning worker can complete', () => {
  const q = new MissionQueue();
  const m = q.enqueue({ task: 'benchmark' });
  q.claim({ id: 'owner' });
  assert.throws(() => q.complete(m.id, 'other'), /not owned/);
  assert.equal(q.complete(m.id, 'owner', { score: 1 }).status, 'completed');
});

test('cancel clears ownership and is terminal', () => {
  const q = new MissionQueue();
  const m = q.enqueue({ task: 'stop safely' });
  q.claim({ id: 'w1' });
  const cancelled = q.cancel(m.id, 'operator stop');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.workerId, null);
  assert.equal(q.stats().cancelled, 1);
  assert.throws(() => q.complete(m.id, 'w1'), /cancelled/);
});

test('rejects invalid queue and mission configuration', () => {
  assert.throws(() => new MissionQueue({ maxAttempts: 0 }), /maxAttempts/);
  assert.throws(() => new MissionQueue({ leaseMs: 0 }), /leaseMs/);
  const q = new MissionQueue();
  assert.throws(() => q.enqueue({ task: '   ' }), /task/);
  assert.throws(() => q.enqueue({ task: 'x', priority: Infinity }), /priority/);
  assert.throws(() => q.enqueue({ task: 'x', requiredCapabilities: 'qa' }), /requiredCapabilities/);
});
