import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MissionQueueStore } from './mission-queue-store.mjs';
import { OrchestratedMissionRuntime } from './orchestrated-mission-runtime.mjs';
import {
  benchmarkOrchestrationGraph,
  benchmarkOrchestrationFleet,
  evaluateFleetReadiness,
  evaluateOrchestrationReadiness
} from './orchestration-benchmark.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dig-orchestration-bench-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return new MissionQueueStore(path.join(root, 'missions.json'));
}

const DURATIONS = {
  orchestrator: 20,
  planner: 30,
  coder: 80,
  system: 120,
  qa: 40
};

async function runtimeFixture(t) {
  const runtime = await OrchestratedMissionRuntime.open({ store: await fixture(t) });
  const submitted = await runtime.submit('plan project debug code and system reliability');
  return { runtime, ...submitted };
}

test('fan-out benchmark measures actual runtime DAG critical path and resource pressure', async t => {
  const { missions } = await runtimeFixture(t);
  const metrics = benchmarkOrchestrationGraph(missions, DURATIONS);

  assert.equal(metrics.missionCount, 5);
  assert.equal(metrics.serialLatencyMs, 290);
  assert.equal(metrics.fanoutLatencyMs, 210);
  assert.equal(metrics.latencySavedMs, 80);
  assert.equal(metrics.totalWorkMs, 290);
  assert.equal(metrics.peakConcurrency, 2);
  assert.ok(metrics.speedup > 1.38 && metrics.speedup < 1.39);

  const gate = evaluateOrchestrationReadiness(metrics, { minSpeedup: 1.25, maxPeakConcurrency: 2 });
  assert.equal(gate.pass, true);
  assert.deepEqual(gate.checks, { latencyGain: true, concurrencyBudget: true, noExtraWork: true });
});

test('worker-fleet benchmark preserves fan-out when specialist capacity is independent', async t => {
  const { missions } = await runtimeFixture(t);
  const metrics = benchmarkOrchestrationFleet(missions, DURATIONS, [
    { id: 'coord', capabilities: ['orchestrator', 'planner'] },
    { id: 'coder-worker', capabilities: ['coder'] },
    { id: 'system-worker', capabilities: ['system'] },
    { id: 'qa-worker', capabilities: ['qa'] }
  ]);

  assert.equal(metrics.fleetSize, 4);
  assert.equal(metrics.unconstrainedLatencyMs, 210);
  assert.equal(metrics.constrainedLatencyMs, 210);
  assert.equal(metrics.latencyPenaltyMs, 0);
  assert.equal(metrics.totalQueueDelayMs, 0);
  assert.equal(metrics.maxQueueDelayMs, 0);
  assert.equal(metrics.peakConcurrentWorkers, 2);
  assert.ok(metrics.constrainedSpeedup > 1.38 && metrics.constrainedSpeedup < 1.39);
  assert.equal(metrics.timing[missions.find(mission => mission.metadata.agentId === 'coder').id].workerId, 'coder-worker');
  assert.equal(metrics.timing[missions.find(mission => mission.metadata.agentId === 'system').id].workerId, 'system-worker');

  const gate = evaluateFleetReadiness(metrics, {
    minSpeedup: 1.25,
    maxLatencyPenaltyRatio: 0.1,
    maxQueueDelayMs: 10,
    maxFleetSize: 4
  });
  assert.equal(gate.pass, true);
  assert.deepEqual(gate.checks, {
    latencyGain: true,
    contentionBudget: true,
    queueDelayBudget: true,
    fleetBudget: true,
    noExtraWork: true
  });
});

test('worker-fleet benchmark exposes contention when specialists share one worker', async t => {
  const { missions } = await runtimeFixture(t);
  const metrics = benchmarkOrchestrationFleet(missions, DURATIONS, [
    { id: 'coord', capabilities: ['orchestrator', 'planner'] },
    { id: 'specialist', capabilities: ['coder', 'system'] },
    { id: 'qa-worker', capabilities: ['qa'] }
  ]);

  assert.equal(metrics.fleetSize, 3);
  assert.equal(metrics.unconstrainedLatencyMs, 210);
  assert.equal(metrics.constrainedLatencyMs, 290);
  assert.equal(metrics.latencyPenaltyMs, 80);
  assert.ok(metrics.latencyPenaltyRatio > 0.38 && metrics.latencyPenaltyRatio < 0.39);
  assert.equal(metrics.totalQueueDelayMs, 80);
  assert.equal(metrics.maxQueueDelayMs, 80);
  assert.equal(metrics.constrainedSpeedup, 1);
  assert.equal(metrics.workerUtilization.specialist.busyMs, 200);
  assert.equal(metrics.workerUtilization.specialist.missionCount, 2);

  const gate = evaluateFleetReadiness(metrics, {
    minSpeedup: 1.2,
    maxLatencyPenaltyRatio: 0.25,
    maxQueueDelayMs: 50,
    maxFleetSize: 4
  });
  assert.equal(gate.pass, false);
  assert.equal(gate.checks.latencyGain, false);
  assert.equal(gate.checks.contentionBudget, false);
  assert.equal(gate.checks.queueDelayBudget, false);
  assert.equal(gate.checks.fleetBudget, true);
  assert.equal(gate.checks.noExtraWork, true);
});

test('worker-fleet benchmark fails closed on missing capability coverage or invalid fleet', async t => {
  const { missions } = await runtimeFixture(t);
  assert.throws(
    () => benchmarkOrchestrationFleet(missions, DURATIONS, [
      { id: 'coord', capabilities: ['orchestrator', 'planner'] },
      { id: 'coder-worker', capabilities: ['coder'] },
      { id: 'qa-worker', capabilities: ['qa'] }
    ]),
    /no worker satisfies mission .* capabilities: system/
  );
  assert.throws(() => benchmarkOrchestrationFleet(missions, DURATIONS, []), /worker fleet is required/);
  assert.throws(
    () => benchmarkOrchestrationFleet(missions, DURATIONS, [
      { id: 'duplicate', capabilities: ['orchestrator', 'planner', 'coder', 'system', 'qa'] },
      { id: 'duplicate', capabilities: ['qa'] }
    ]),
    /duplicate worker id/
  );
});

test('readiness gate fails when latency gain is too small or concurrency budget is exceeded', () => {
  const metrics = {
    speedup: 1.05,
    peakConcurrency: 3,
    totalWorkMs: 100,
    serialLatencyMs: 100
  };
  const gate = evaluateOrchestrationReadiness(metrics, { minSpeedup: 1.15, maxPeakConcurrency: 2 });
  assert.equal(gate.pass, false);
  assert.equal(gate.checks.latencyGain, false);
  assert.equal(gate.checks.concurrencyBudget, false);
  assert.equal(gate.checks.noExtraWork, true);
});

test('benchmark rejects missing dependencies, dependency cycles, and incomplete duration fixtures', () => {
  assert.throws(
    () => benchmarkOrchestrationGraph([{ id: 'a', dependsOn: ['missing'], metadata: { agentId: 'a' } }], { a: 1 }),
    /missing dependency mission/
  );

  assert.throws(
    () => benchmarkOrchestrationGraph([
      { id: 'a', dependsOn: ['b'], metadata: { agentId: 'a' } },
      { id: 'b', dependsOn: ['a'], metadata: { agentId: 'b' } }
    ], { a: 1, b: 1 }),
    /dependency cycle detected/
  );

  assert.throws(
    () => benchmarkOrchestrationGraph([{ id: 'a', dependsOn: [], metadata: { agentId: 'a' } }], {}),
    /missing duration/
  );
});
