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

test('persists missions across queue instances', async t => {
  const { dir, filePath } = tempStore(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const q1 = new DurableMissionQueue({ filePath });
  const mission = await q1.enqueue({ task: 'persist me', priority: 4 });
  const q2 = new DurableMissionQueue({ filePath });
  assert.equal((await q2.get(mission.id)).task, 'persist me');
  assert.equal((await q2.stats()).queued, 1);
});

test('concurrent claim across queue instances is atomic', async t => {
  const { dir, filePath } = tempStore(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
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
  assert.equal((await seed.get(mission.id)).attempts, 1);
});

test('lease expiry survives restart and requeues work', async t => {
  const { dir, filePath } = tempStore(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let now = 0;
  const q1 = new DurableMissionQueue({ filePath, leaseMs: 10, now: () => now });
  const mission = await q1.enqueue({ task: 'recover' });
  await q1.claim({ id: 'dead-worker' });
  now = 11;
  const q2 = new DurableMissionQueue({ filePath, leaseMs: 10, now: () => now });
  assert.equal(await q2.requeueExpired(), 1);
  const reclaimed = await q2.claim({ id: 'replacement' });
  assert.equal(reclaimed.id, mission.id);
  assert.equal(reclaimed.attempts, 2);
});

test('dependencies remain gated in durable store', async t => {
  const { dir, filePath } = tempStore(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const q = new DurableMissionQueue({ filePath });
  const first = await q.enqueue({ task: 'attempt', requiredCapabilities: ['coder'] });
  const review = await q.enqueue({ task: 'review', requiredCapabilities: ['qa'], dependsOn: [first.id] });
  assert.equal((await q.stats()).blocked, 1);
  assert.equal(await q.claim({ id: 'qa', capabilities: ['qa'] }), null);
  await q.claim({ id: 'coder', capabilities: ['coder'] });
  await q.complete(first.id, 'coder');
  assert.equal((await q.claim({ id: 'qa', capabilities: ['qa'] })).id, review.id);
});
