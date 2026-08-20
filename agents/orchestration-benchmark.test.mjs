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
  evaluateFleetTopologies,
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

test('bounded topology evaluator chooses the smallest zero-penalty two-worker layout', async t => {
  const { missions } = await runtimeFixture(t);
  const topologies = [
    {
      id: 'one-worker',
      workers: [{ id: 'all', capabilities: ['orchestrator', 'planner', 'coder', 'system', 'qa'] }]
    },
    {
      id: 'two-worker-fused',
      workers: [
        { id: 'coord-code-qa', capabilities: ['orchestrator', 'planner', 'coder', 'qa'] },
        { id: 'system', capabilities: ['system'] }
      ]
    },
    {
      id: 'three-worker-shared-specialist',
      workers: [
        { id: 'coord', capabilities: ['orchestrator', 'planner'] },
        { id: 'specialist', capabilities: ['coder', 'system'] },
        { id: 'qa', capabilities: ['qa'] }
      ]
    },
    {
      id: 'four-worker',
      workers: [
        { id: 'coord', capabilities: ['orchestrator', 'planner'] },
        { id: 'coder', capabilities: ['coder'] },
        { id: 'system', capabilities: ['system'] },
        { id: 'qa', capabilities: ['qa'] }
      ]
    }
  ];

  const evaluation = evaluateFleetTopologies(missions, DURATIONS, topologies, {
    readiness: { minSpeedup: 1.25, maxLatencyPenaltyRatio: 0.1, maxQueueDelayMs: 10, maxFleetSize: 4 }
  });

  assert.equal(evaluation.evaluated, 4);
  assert.equal(evaluation.eligible, 2);
  assert.equal(evaluation.winner.id, 'two-worker-fused');
  assert.deepEqual(evaluation.ranking, ['two-worker-fused', 'four-worker']);
  assert.equal(evaluation.winner.metrics.constrainedLatencyMs, 210);
  assert.equal(evaluation.winner.metrics.latencyPenaltyMs, 0);
  assert.equal(evaluation.winner.metrics.maxQueueDelayMs, 0);
  assert.equal(evaluation.winner.metrics.peakConcurrentWorkers, 2);

  const one = evaluation.results.find(result => result.id === 'one-worker');
  assert.equal(one.eligible, false);
  assert.equal(one.metrics.constrainedLatencyMs, 290);
  assert.equal(one.readiness.checks.latencyGain, false);

  const shared = evaluation.results.find(result => result.id === 'three-worker-shared-specialist');
  assert.equal(shared.eligible, false);
  assert.equal(shared.metrics.constrainedLatencyMs, 290);
  assert.equal(shared.readiness.checks.contentionBudget, false);
});

test('bounded topology evaluator rejects faster layouts that violate trust-boundary co-residency', async t => {
  const { missions } = await runtimeFixture(t);
  const evaluation = evaluateFleetTopologies(missions, DURATIONS, [
    {
      id: 'fused-fast-but-forbidden',
      workers: [
        { id: 'coord-code-qa', capabilities: ['orchestrator', 'planner', 'coder', 'qa'] },
        { id: 'system', capabilities: ['system'] }
      ]
    },
    {
      id: 'isolated-four-worker',
      workers: [
        { id: 'coord', capabilities: ['orchestrator', 'planner'] },
        { id: 'coder', capabilities: ['coder'] },
        { id: 'system', capabilities: ['system'] },
        { id: 'qa', capabilities: ['qa'] }
      ]
    }
  ], {
    readiness: { minSpeedup: 1.25, maxLatencyPenaltyRatio: 0.1, maxQueueDelayMs: 10, maxFleetSize: 4 },
    forbiddenCapabilityPairs: [['coder', 'qa']]
  });

  assert.equal(evaluation.winner.id, 'isolated-four-worker');
  const rejected = evaluation.results.find(result => result.id === 'fused-fast-but-forbidden');
  assert.equal(rejected.eligible, false);
  assert.equal(rejected.error, 'trust-boundary constraint violation');
  assert.deepEqual(rejected.constraints.violations, [{ workerId: 'coord-code-qa', capabilities: ['coder', 'qa'] }]);
});

test('bounded topology evaluator is deterministic and fail-closed on invalid bounds', async t => {
  const { missions } = await runtimeFixture(t);
  const layouts = [
    { id: 'b', workers: [{ id: 'all-b', capabilities: ['orchestrator', 'planner', 'coder', 'system', 'qa'] }] },
    { id: 'a', workers: [{ id: 'all-a', capabilities: ['orchestrator', 'planner', 'coder', 'system', 'qa'] }] }
  ];
  const evaluation = evaluateFleetTopologies(missions, DURATIONS, layouts, {
    readiness: { minSpeedup: 1, maxLatencyPenaltyRatio: 1, maxQueueDelayMs: 100, maxFleetSize: 2 }
  });
  assert.deepEqual(evaluation.ranking, ['a', 'b']);
  assert.throws(() => evaluateFleetTopologies(missions, DURATIONS, layouts, { maxTopologies: 1 }), /topology count exceeds/);
  assert.throws(() => evaluateFleetTopologies(missions, DURATIONS, layouts, { forbiddenCapabilityPairs: [['coder']] }), /exactly two capabilities/);
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
