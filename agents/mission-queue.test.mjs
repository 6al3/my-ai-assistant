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

test('expired lease is retried then permanently failed', () => {
  let now = 0;
  const q = new MissionQueue({ maxAttempts: 2, leaseMs: 10, now: () => now });
  const m = q.enqueue({ task: 'synthetic defensive benchmark' });
  assert.equal(q.claim({ id: 'w1' }).attempts, 1);
  now = 11; q.requeueExpired();
  assert.equal(q.get(m.id).status, 'queued');
  assert.equal(q.claim({ id: 'w2' }).attempts, 2);
  now = 22; q.requeueExpired();
  assert.equal(q.get(m.id).status, 'failed');
});

test('only owning worker can complete', () => {
  const q = new MissionQueue();
  const m = q.enqueue({ task: 'benchmark' });
  q.claim({ id: 'owner' });
  assert.throws(() => q.complete(m.id, 'other'), /not owned/);
  assert.equal(q.complete(m.id, 'owner', { score: 1 }).status, 'completed');
});
