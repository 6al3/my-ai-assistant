import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MissionQueueStore } from './mission-queue-store.mjs';
import { OrchestratedMissionRuntime } from './orchestrated-mission-runtime.mjs';
import { benchmarkOrchestrationGraph, evaluateOrchestrationReadiness } from './orchestration-benchmark.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dig-orchestration-bench-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return new MissionQueueStore(path.join(root, 'missions.json'));
}

test('fan-out benchmark measures actual runtime DAG critical path and resource pressure', async t => {
  const runtime = await OrchestratedMissionRuntime.open({ store: await fixture(t) });
  const { missions } = await runtime.submit('plan project debug code and system reliability');
  const metrics = benchmarkOrchestrationGraph(missions, {
    orchestrator: 20,
    planner: 30,
    coder: 80,
    system: 120,
    qa: 40
  });

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
