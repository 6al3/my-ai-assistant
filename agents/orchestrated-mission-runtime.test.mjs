import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MissionQueueStore } from './mission-queue-store.mjs';
import { OrchestratedMissionRuntime } from './orchestrated-mission-runtime.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dig-orchestrated-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return new MissionQueueStore(path.join(root, 'missions.json'));
}

test('execution plan becomes durable capability-gated mission chain', async t => {
  const store = await fixture(t);
  const runtime = await OrchestratedMissionRuntime.open({ store });
  const submitted = await runtime.submit('debug and refactor this code project', { idempotencyKey: 'job-a' });
  assert.ok(submitted.missions.length >= 3);
  assert.equal(runtime.stats().total, submitted.missions.length);
  for (let i = 1; i < submitted.missions.length; i += 1) {
    assert.deepEqual(submitted.missions[i].dependsOn, [submitted.missions[i - 1].id]);
  }
  const restarted = await OrchestratedMissionRuntime.open({ store });
  assert.equal(restarted.stats().total, submitted.missions.length);
});

test('submission retry is idempotent across coordinator restart', async t => {
  const store = await fixture(t);
  const first = await OrchestratedMissionRuntime.open({ store });
  const a = await first.submit('debug code', { idempotencyKey: 'stable-submit' });
  const restarted = await OrchestratedMissionRuntime.open({ store });
  const b = await restarted.submit('debug code retry payload', { idempotencyKey: 'stable-submit' });
  assert.deepEqual(b.missions.map(x => x.id), a.missions.map(x => x.id));
  assert.equal(restarted.stats().total, a.missions.length);
});

test('worker capabilities and dependencies gate execution order', async t => {
  const store = await fixture(t);
  const runtime = await OrchestratedMissionRuntime.open({ store });
  const { missions } = await runtime.submit('debug code');
  const first = missions[0];
  assert.equal(await runtime.claim({ id: 'wrong', capabilities: ['qa'] }), null);
  const claimed = await runtime.claim({ id: 'right', capabilities: first.requiredCapabilities });
  assert.equal(claimed.id, first.id);
  const later = missions[1];
  assert.equal(await runtime.claim({ id: 'later', capabilities: later.requiredCapabilities }), null);
  await runtime.complete(first.id, 'right', { ok: true });
  assert.equal((await runtime.claim({ id: 'later', capabilities: later.requiredCapabilities })).id, later.id);
});