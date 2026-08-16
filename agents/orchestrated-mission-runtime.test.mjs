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

const byAgent = missions => new Map(missions.map(mission => [mission.metadata.agentId, mission]));

test('execution plan becomes durable coordination -> fan-out -> QA join graph', async t => {
  const store = await fixture(t);
  const runtime = await OrchestratedMissionRuntime.open({ store });
  const submitted = await runtime.submit('plan project debug code and system reliability', { idempotencyKey: 'job-a' });
  const missions = byAgent(submitted.missions);
  const orchestrator = missions.get('orchestrator');
  const planner = missions.get('planner');
  const coder = missions.get('coder');
  const system = missions.get('system');
  const qa = missions.get('qa');

  assert.ok(orchestrator && planner && coder && system && qa);
  assert.deepEqual(orchestrator.dependsOn, []);
  assert.deepEqual(planner.dependsOn, [orchestrator.id]);
  assert.deepEqual(coder.dependsOn, [planner.id]);
  assert.deepEqual(system.dependsOn, [planner.id]);
  assert.deepEqual(new Set(qa.dependsOn), new Set([coder.id, system.id]));
  assert.equal(coder.metadata.executionPhase, 'parallel-work');
  assert.equal(system.metadata.executionPhase, 'parallel-work');
  assert.equal(qa.metadata.executionPhase, 'review');
  assert.equal(runtime.stats().total, submitted.missions.length);

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

test('specialists become concurrently claimable after coordination while QA waits for all', async t => {
  const store = await fixture(t);
  const runtime = await OrchestratedMissionRuntime.open({ store });
  const submitted = await runtime.submit('plan project debug code and system reliability');
  const missions = byAgent(submitted.missions);
  const orchestrator = missions.get('orchestrator');
  const planner = missions.get('planner');
  const coder = missions.get('coder');
  const system = missions.get('system');
  const qa = missions.get('qa');

  assert.equal((await runtime.claim({ id: 'orchestrator-w', capabilities: ['orchestrator'] })).id, orchestrator.id);
  await runtime.complete(orchestrator.id, 'orchestrator-w', { ok: true });
  assert.equal((await runtime.claim({ id: 'planner-w', capabilities: ['planner'] })).id, planner.id);
  await runtime.complete(planner.id, 'planner-w', { ok: true });

  const [coderClaim, systemClaim] = await Promise.all([
    runtime.claim({ id: 'coder-w', capabilities: ['coder'] }),
    runtime.claim({ id: 'system-w', capabilities: ['system'] })
  ]);
  assert.equal(coderClaim.id, coder.id);
  assert.equal(systemClaim.id, system.id);
  assert.equal(await runtime.claim({ id: 'qa-w', capabilities: ['qa'] }), null);

  await runtime.complete(coder.id, 'coder-w', { ok: true });
  assert.equal(await runtime.claim({ id: 'qa-w', capabilities: ['qa'] }), null);
  await runtime.complete(system.id, 'system-w', { ok: true });
  assert.equal((await runtime.claim({ id: 'qa-w', capabilities: ['qa'] })).id, qa.id);
});

test('failed parallel specialist prevents QA and propagates review cancellation', async t => {
  const store = await fixture(t);
  const runtime = await OrchestratedMissionRuntime.open({ store, queueOptions: { maxAttempts: 1 } });
  const submitted = await runtime.submit('plan project debug code and system reliability');
  const missions = byAgent(submitted.missions);
  const orchestrator = missions.get('orchestrator');
  const planner = missions.get('planner');
  const coder = missions.get('coder');
  const qa = missions.get('qa');

  await runtime.claim({ id: 'orchestrator-w', capabilities: ['orchestrator'] });
  await runtime.complete(orchestrator.id, 'orchestrator-w');
  await runtime.claim({ id: 'planner-w', capabilities: ['planner'] });
  await runtime.complete(planner.id, 'planner-w');
  await runtime.claim({ id: 'coder-w', capabilities: ['coder'] });
  await runtime.fail(coder.id, 'coder-w', 'synthetic coder failure');

  assert.equal(runtime.get(coder.id).status, 'failed');
  assert.equal(runtime.get(qa.id).status, 'cancelled');
  assert.equal(await runtime.claim({ id: 'qa-w', capabilities: ['qa'] }), null);
});
