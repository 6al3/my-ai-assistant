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

test('dependencies block claims until prerequisites complete', () => {
  const q = new MissionQueue();
  const first = q.enqueue({ task: 'attempt', requiredCapabilities: ['coder'] });
  const review = q.enqueue({ task: 'review', requiredCapabilities: ['qa'], dependsOn: [first.id] });
  assert.equal(q.stats().blocked, 1);
  assert.equal(q.claim({ id: 'qa', capabilities: ['qa'] }), null);
  q.claim({ id: 'coder', capabilities: ['coder'] });
  q.complete(first.id, 'coder');
  assert.equal(q.claim({ id: 'qa', capabilities: ['qa'] }).id, review.id);
});

test('unknown dependency is rejected', () => {
  const q = new MissionQueue();
  assert.throws(() => q.enqueue({ task: 'bad', dependsOn: ['missing'] }), /dependency not found/);
});

test('cancel releases running mission and rejects stale completion', () => {
  const q = new MissionQueue();
  const m = q.enqueue({ task: 'long synthetic task' });
  q.claim({ id: 'w1' });
  assert.equal(q.cancel(m.id, 'operator stop').status, 'cancelled');
  assert.throws(() => q.complete(m.id, 'w1'), /cancelled/);
  assert.equal(q.get(m.id).workerId, null);
});

test('failed dependency cancels downstream chain instead of blocking forever', () => {
  const q = new MissionQueue({ maxAttempts: 1 });
  const root = q.enqueue({ task: 'root' });
  const child = q.enqueue({ task: 'child', dependsOn: [root.id] });
  const grandchild = q.enqueue({ task: 'grandchild', dependsOn: [child.id] });
  q.claim({ id: 'w1' });
  q.fail(root.id, 'w1', 'synthetic failure');
  assert.equal(q.get(root.id).status, 'failed');
  assert.equal(q.get(child.id).status, 'cancelled');
  assert.equal(q.get(grandchild.id).status, 'cancelled');
  assert.deepEqual(q.stats(), { total: 3, queued: 0, running: 0, completed: 0, failed: 1, cancelled: 2, blocked: 0 });
});

test('cancelled dependency propagates downstream', () => {
  const q = new MissionQueue();
  const root = q.enqueue({ task: 'root' });
  const child = q.enqueue({ task: 'child', dependsOn: [root.id] });
  q.cancel(root.id, 'superseded');
  assert.equal(q.get(child.id).status, 'cancelled');
  assert.equal(q.claim({ id: 'worker' }), null);
});

test('idempotency key returns original mission', () => {
  const q = new MissionQueue();
  const first = q.enqueue({ task: 'once', idempotencyKey: 'job-1' });
  const duplicate = q.enqueue({ task: 'duplicate payload ignored', idempotencyKey: 'job-1' });
  assert.equal(duplicate.id, first.id);
  assert.equal(duplicate.task, first.task);
  assert.equal(q.stats().total, 1);
});

test('snapshot preserves completed state and idempotency', () => {
  const q = new MissionQueue();
  const m = q.enqueue({ task: 'once', idempotencyKey: 'stable' });
  q.claim({ id: 'w' });
  q.complete(m.id, 'w', { ok: true });
  const recovered = new MissionQueue({ snapshot: q.snapshot() });
  assert.equal(recovered.get(m.id).status, 'completed');
  assert.deepEqual(recovered.get(m.id).result, { ok: true });
  assert.equal(recovered.enqueue({ task: 'retry', idempotencyKey: 'stable' }).id, m.id);
});

test('restart recovers in-flight lease without double ownership', () => {
  let now = 100;
  const q = new MissionQueue({ maxAttempts: 3, now: () => now });
  const m = q.enqueue({ task: 'work' });
  q.claim({ id: 'old' });
  now = 200;
  const recovered = new MissionQueue({ maxAttempts: 3, now: () => now, snapshot: q.snapshot() });
  assert.equal(recovered.get(m.id).status, 'queued');
  assert.equal(recovered.get(m.id).workerId, null);
  assert.equal(recovered.claim({ id: 'new' }).attempts, 2);
  assert.throws(() => recovered.complete(m.id, 'old'), /not owned/);
});

test('stateless service restore preserves a live durable lease and fencing token', () => {
  let now = 100;
  const q = new MissionQueue({ leaseMs: 50, now: () => now, requireLeaseToken: true });
  const m = q.enqueue({ task: 'qrexec worker task' });
  const claimed = q.claim({ id: 'worker-1' });
  now = 120;
  const restored = new MissionQueue({ now: () => now, requireLeaseToken: true, preserveRunningLeasesOnRestore: true, snapshot: q.snapshot() });
  const durable = restored.get(m.id);
  assert.equal(durable.status, 'running');
  assert.equal(durable.workerId, 'worker-1');
  assert.equal(durable.leaseToken, claimed.leaseToken);
  assert.equal(restored.complete(m.id, 'worker-1', { ok: true }, claimed.leaseToken).status, 'completed');
});

test('expired durable lease cannot mutate even before another worker claims', () => {
  let now = 100;
  const q = new MissionQueue({ leaseMs: 10, now: () => now, requireLeaseToken: true });
  const m = q.enqueue({ task: 'qrexec expiry task' });
  const claimed = q.claim({ id: 'worker-1' });
  now = 111;
  assert.throws(() => q.complete(m.id, 'worker-1', { late: true }, claimed.leaseToken), /lease expired/);
  assert.throws(() => q.heartbeat(m.id, 'worker-1', claimed.leaseToken), /lease expired/);
});

test('restart terminalizes exhausted in-flight mission and propagates dependency failure', () => {
  const q = new MissionQueue({ maxAttempts: 1 });
  const root = q.enqueue({ task: 'root' });
  const child = q.enqueue({ task: 'child', dependsOn: [root.id] });
  q.claim({ id: 'old' });
  const recovered = new MissionQueue({ maxAttempts: 1, snapshot: q.snapshot() });
  assert.equal(recovered.get(root.id).status, 'failed');
  assert.equal(recovered.get(child.id).status, 'cancelled');
});

test('restore rejects duplicate idempotency keys', () => {
  const q = new MissionQueue();
  const first = q.enqueue({ task: 'a', idempotencyKey: 'same' });
  const snapshot = q.snapshot();
  snapshot.missions.push({ ...snapshot.missions[0], id: `${first.id}-copy` });
  assert.throws(() => new MissionQueue({ snapshot }), /duplicate idempotency key/);
});
