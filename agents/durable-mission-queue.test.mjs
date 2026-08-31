import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DurableMissionQueue } from './durable-mission-queue.mjs';

const tempStore = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dig-queue-'));
  return { dir, filePath: path.join(dir, 'missions.json') };
};

const cleanup = (t, dir) => t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('persists missions across queue instances', async t => {
  const { dir, filePath } = tempStore(); cleanup(t, dir);
  const q1 = new DurableMissionQueue({ filePath });
  const mission = await q1.enqueue({ task: 'persist me', priority: 4 });
  const q2 = new DurableMissionQueue({ filePath });
  assert.equal((await q2.get(mission.id)).task, 'persist me');
  assert.equal((await q2.stats()).queued, 1);
});

test('concurrent claim across queue instances is atomic', async t => {
  const { dir, filePath } = tempStore(); cleanup(t, dir);
  const seed = new DurableMissionQueue({ filePath, lockRetryMs: 1 });
  const mission = await seed.enqueue({ task: 'single-owner', requiredCapabilities: ['coder'] });
  const q1 = new DurableMissionQueue({ filePath, lockRetryMs: 1 });
  const q2 = new DurableMissionQueue({ filePath, lockRetryMs: 1 });
  const [a, b] = await Promise.all([
    q1.claim({ id: 'w1', capabilities: ['coder'] }),
    q2.claim({ id: 'w2', capabilities: ['coder'] })
  ]);
  const claims = [a, b].filter(Boolean);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].id, mission.id);
  assert.match(claims[0].leaseToken, /^1:/);
  assert.equal((await seed.get(mission.id)).attempts, 1);
});

test('lease expiry survives restart and requeues work', async t => {
  const { dir, filePath } = tempStore(); cleanup(t, dir);
  let now = 0;
  const q1 = new DurableMissionQueue({ filePath, leaseMs: 10, now: () => now });
  const mission = await q1.enqueue({ task: 'recover' });
  const first = await q1.claim({ id: 'dead-worker' });
  now = 11;
  const q2 = new DurableMissionQueue({ filePath, leaseMs: 10, now: () => now });
  assert.equal(await q2.requeueExpired(), 1);
  const reclaimed = await q2.claim({ id: 'replacement' });
  assert.equal(reclaimed.id, mission.id);
  assert.equal(reclaimed.attempts, 2);
  assert.equal(reclaimed.leaseEpoch, 2);
  assert.notEqual(reclaimed.leaseToken, first.leaseToken);
});

test('stale worker is fenced after lease expiry and reclaim', async t => {
  const { dir, filePath } = tempStore(); cleanup(t, dir);
  let now = 0;
  const q = new DurableMissionQueue({ filePath, leaseMs: 10, now: () => now });
  const mission = await q.enqueue({ task: 'fence stale owner' });
  const stale = await q.claim({ id: 'worker-a' });
  now = 11;
  await q.requeueExpired();
  const current = await q.claim({ id: 'worker-b' });
  await assert.rejects(() => q.heartbeat(mission.id, 'worker-a', stale.leaseToken), /not owned|stale|invalid/);
  await assert.rejects(() => q.complete(mission.id, 'worker-a', stale.leaseToken, 'late result'), /not owned|stale|invalid/);
  await q.complete(mission.id, 'worker-b', current.leaseToken, 'winner');
  assert.equal((await q.get(mission.id)).result, 'winner');
});

test('expired owner cannot complete before explicit requeue', async t => {
  const { dir, filePath } = tempStore(); cleanup(t, dir);
  let now = 100;
  const q = new DurableMissionQueue({ filePath, leaseMs: 5, now: () => now });
  const mission = await q.enqueue({ task: 'reject late completion' });
  const claim = await q.claim({ id: 'worker-a' });
  now = 106;
  await assert.rejects(() => q.complete(mission.id, 'worker-a', claim.leaseToken, 'too late'), /lease expired/);
});

test('heartbeat extends only the current fenced lease', async t => {
  const { dir, filePath } = tempStore(); cleanup(t, dir);
  let now = 0;
  const q = new DurableMissionQueue({ filePath, leaseMs: 10, now: () => now });
  const mission = await q.enqueue({ task: 'heartbeat' });
  const claim = await q.claim({ id: 'worker-a' });
  now = 5;
  const beat = await q.heartbeat(mission.id, 'worker-a', claim.leaseToken);
  assert.equal(beat.leaseUntil, 15);
  await assert.rejects(() => q.heartbeat(mission.id, 'worker-a', '1:bogus'), /stale or invalid lease token/);
});

test('dependencies remain gated in durable store', async t => {
  const { dir, filePath } = tempStore(); cleanup(t, dir);
  const q = new DurableMissionQueue({ filePath });
  const first = await q.enqueue({ task: 'attempt', requiredCapabilities: ['coder'] });
  const review = await q.enqueue({ task: 'review', requiredCapabilities: ['qa'], dependsOn: [first.id] });
  assert.equal((await q.stats()).blocked, 1);
  assert.equal(await q.claim({ id: 'qa', capabilities: ['qa'] }), null);
  const coderClaim = await q.claim({ id: 'coder', capabilities: ['coder'] });
  await q.complete(first.id, 'coder', coderClaim.leaseToken);
  assert.equal((await q.claim({ id: 'qa', capabilities: ['qa'] })).id, review.id);
});

test('contention stress: each mission is claimed and completed once', async t => {
  const { dir, filePath } = tempStore(); cleanup(t, dir);
  const missionCount = 32;
  const workerCount = 12;
  const seed = new DurableMissionQueue({ filePath, lockRetryMs: 1, lockTimeoutMs: 10_000 });
  for (let i = 0; i < missionCount; i += 1) await seed.enqueue({ task: `job-${i}`, requiredCapabilities: ['coder'] });
  const completed = new Set();
  await Promise.all(Array.from({ length: workerCount }, async (_, index) => {
    const q = new DurableMissionQueue({ filePath, lockRetryMs: 1, lockTimeoutMs: 10_000 });
    const workerId = `worker-${index}`;
    while (true) {
      const claim = await q.claim({ id: workerId, capabilities: ['coder'] });
      if (!claim) return;
      assert.equal(completed.has(claim.id), false);
      completed.add(claim.id);
      await q.complete(claim.id, workerId, claim.leaseToken, { ok: true });
    }
  }));
  assert.equal(completed.size, missionCount);
  const stats = await seed.stats();
  assert.equal(stats.completed, missionCount);
  assert.equal(stats.running, 0);
  assert.equal(stats.queued, 0);
});

test('list returns independent clones and does not leak mutations', async t => {
  const { dir, filePath } = tempStore(); cleanup(t, dir);
  const q = new DurableMissionQueue({ filePath });
  const mission = await q.enqueue({ task: 'clone check', metadata: { nested: { value: 1 } } });
  const listed = await q.list();
  assert.equal(listed.length, 1);
  listed[0].metadata.nested.value = 99;
  assert.equal((await q.get(mission.id)).metadata.nested.value, 1);
});

test('constructor and enqueue reject malformed scheduling inputs', async t => {
  const { dir, filePath } = tempStore(); cleanup(t, dir);
  assert.throws(() => new DurableMissionQueue({ filePath, maxAttempts: 0 }), /maxAttempts/);
  assert.throws(() => new DurableMissionQueue({ filePath, leaseMs: 0 }), /leaseMs/);
  const q = new DurableMissionQueue({ filePath });
  await assert.rejects(() => q.enqueue({ task: 'x', priority: Number.NaN }), /priority/);
  await assert.rejects(() => q.enqueue({ task: 'x', requiredCapabilities: 'coder' }), /requiredCapabilities/);
  await assert.rejects(() => q.enqueue({ task: 'x', dependsOn: 'bad' }), /dependsOn/);
});

test('cancellation clears ownership and prevents later completion', async t => {
  const { dir, filePath } = tempStore(); cleanup(t, dir);
  const q = new DurableMissionQueue({ filePath });
  const mission = await q.enqueue({ task: 'cancel me' });
  const claim = await q.claim({ id: 'worker-a' });
  const cancelled = await q.cancel(mission.id, 'operator stop');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.workerId, null);
  assert.equal(cancelled.leaseToken, null);
  await assert.rejects(() => q.complete(mission.id, 'worker-a', claim.leaseToken), /cancelled/);
});
