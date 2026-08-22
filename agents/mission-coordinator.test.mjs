import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MissionCoordinator } from './mission-coordinator.mjs';
import { MissionQueueStore } from './mission-queue-store.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dig-coordinator-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new MissionQueueStore(path.join(root, 'missions.json'));
  return { root, store };
}

test('open restores persisted queue and idempotency across restart', async t => {
  const { store } = await fixture(t);
  const first = await MissionCoordinator.open({ store });
  const mission = await first.enqueue({ task: 'persist me', idempotencyKey: 'stable-1' });
  const claim = await first.claim({ id: 'worker-a' });
  await first.complete(mission.id, 'worker-a', { ok: true });

  const restarted = await MissionCoordinator.open({ store });
  assert.equal(restarted.get(mission.id).status, 'completed');
  assert.deepEqual(restarted.get(mission.id).result, { ok: true });
  assert.equal((await restarted.enqueue({ task: 'retry', idempotencyKey: 'stable-1' })).id, mission.id);
  assert.equal(claim.id, mission.id);
});

test('running work is recovered safely on coordinator restart', async t => {
  const { store } = await fixture(t);
  const first = await MissionCoordinator.open({ store, queueOptions: { maxAttempts: 3 } });
  const mission = await first.enqueue({ task: 'restart recovery' });
  await first.claim({ id: 'old-worker' });

  const restarted = await MissionCoordinator.open({ store, queueOptions: { maxAttempts: 3 } });
  assert.equal(restarted.get(mission.id).status, 'queued');
  assert.equal(restarted.get(mission.id).workerId, null);
  const reclaimed = await restarted.claim({ id: 'new-worker' });
  assert.equal(reclaimed.id, mission.id);
  assert.equal(reclaimed.attempts, 2);
});

test('concurrent mutations are serialized and persisted without lost missions', async t => {
  const { store } = await fixture(t);
  const coordinator = await MissionCoordinator.open({ store });
  const created = await Promise.all(Array.from({ length: 20 }, (_, index) =>
    coordinator.enqueue({ task: `job-${index}`, idempotencyKey: `job-${index}` })
  ));
  assert.equal(new Set(created.map(item => item.id)).size, 20);
  assert.equal(coordinator.stats().total, 20);

  const restarted = await MissionCoordinator.open({ store });
  assert.equal(restarted.stats().total, 20);
});

test('persistence failure poisons coordinator and later mutations fail closed', async () => {
  let saves = 0;
  const store = {
    load: async () => ({ version: 1, missions: [] }),
    save: async () => {
      saves += 1;
      if (saves >= 2) throw new Error('disk unavailable');
    }
  };
  const coordinator = await MissionCoordinator.open({ store });
  await coordinator.enqueue({ task: 'first durable mutation' });
  await assert.rejects(() => coordinator.enqueue({ task: 'second mutation' }), /mission persistence failed: disk unavailable/);
  assert.equal(coordinator.healthy, false);
  await assert.rejects(() => coordinator.enqueue({ task: 'must not continue' }), /fail-closed after persistence error/);
  assert.equal(saves, 2);
});
