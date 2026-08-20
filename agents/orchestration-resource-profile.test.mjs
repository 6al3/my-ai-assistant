import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MissionQueueStore } from './mission-queue-store.mjs';
import { OrchestratedMissionRuntime } from './orchestrated-mission-runtime.mjs';
import { evaluateResourceAwareFleetTopologies } from './orchestration-resource-profile.mjs';

const DURATIONS = { orchestrator: 20, planner: 30, coder: 80, system: 120, qa: 40 };

async function missionsFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dig-resource-bench-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = await OrchestratedMissionRuntime.open({ store: new MissionQueueStore(path.join(root, 'missions.json')) });
  return (await runtime.submit('plan project debug code and system reliability')).missions;
}

function topologies() {
  return [
    {
      id: 'one-worker-low-footprint',
      workers: [{ id: 'all', capabilities: ['orchestrator', 'planner', 'coder', 'system', 'qa'], resources: { ramMb: 1536, vcpus: 2 } }]
    },
    {
      id: 'two-worker-balanced',
      workers: [
        { id: 'coord-code-qa', capabilities: ['orchestrator', 'planner', 'coder', 'qa'], resources: { ramMb: 1536, vcpus: 2 } },
        { id: 'system', capabilities: ['system'], resources: { ramMb: 1024, vcpus: 1 } }
      ]
    },
    {
      id: 'four-worker-isolated',
      workers: [
        { id: 'coord', capabilities: ['orchestrator', 'planner'], resources: { ramMb: 1024, vcpus: 1 } },
        { id: 'coder', capabilities: ['coder'], resources: { ramMb: 1024, vcpus: 1 } },
        { id: 'system', capabilities: ['system'], resources: { ramMb: 1024, vcpus: 1 } },
        { id: 'qa', capabilities: ['qa'], resources: { ramMb: 1024, vcpus: 1 } }
      ]
    }
  ];
}

const READINESS = { minSpeedup: 1.25, maxLatencyPenaltyRatio: 0.1, maxQueueDelayMs: 10, maxFleetSize: 4 };

test('resource-aware evaluator chooses smallest ready topology inside Qubes budget', async t => {
  const missions = await missionsFixture(t);
  const evaluation = evaluateResourceAwareFleetTopologies(missions, DURATIONS, topologies(), {
    readiness: READINESS,
    resourceBudget: { maxRamMb: 3072, maxVcpus: 4, maxQubes: 3 }
  });

  assert.equal(evaluation.winner.id, 'two-worker-balanced');
  assert.deepEqual(evaluation.ranking, ['two-worker-balanced']);
  assert.equal(evaluation.winner.metrics.constrainedLatencyMs, 210);
  assert.equal(evaluation.winner.resources.qubes, 2);
  assert.equal(evaluation.winner.resources.totalRamMb, 2560);
  assert.equal(evaluation.winner.resources.totalVcpus, 3);

  const one = evaluation.results.find(item => item.id === 'one-worker-low-footprint');
  assert.equal(one.baseEligible, false);
  assert.equal(one.resourceGate.pass, true);
  assert.equal(one.eligible, false);

  const four = evaluation.results.find(item => item.id === 'four-worker-isolated');
  assert.equal(four.baseEligible, true);
  assert.equal(four.resourceGate.pass, false);
  assert.equal(four.resourceGate.checks.ramBudget, false);
  assert.equal(four.resourceGate.checks.qubeBudget, false);
});

test('trust isolation wins only when resource budget can afford it', async t => {
  const missions = await missionsFixture(t);
  const constrained = evaluateResourceAwareFleetTopologies(missions, DURATIONS, topologies(), {
    readiness: READINESS,
    forbiddenCapabilityPairs: [['coder', 'qa']],
    resourceBudget: { maxRamMb: 3072, maxVcpus: 4, maxQubes: 3 }
  });
  assert.equal(constrained.winner, null);
  assert.equal(constrained.eligible, 0);

  const expanded = evaluateResourceAwareFleetTopologies(missions, DURATIONS, topologies(), {
    readiness: READINESS,
    forbiddenCapabilityPairs: [['coder', 'qa']],
    resourceBudget: { maxRamMb: 4096, maxVcpus: 4, maxQubes: 4 }
  });
  assert.equal(expanded.winner.id, 'four-worker-isolated');
  assert.equal(expanded.winner.resources.totalRamMb, 4096);
});

test('resource-aware evaluator fails closed on missing or invalid resource profiles', async t => {
  const missions = await missionsFixture(t);
  assert.throws(
    () => evaluateResourceAwareFleetTopologies(missions, DURATIONS, [{ id: 'missing', workers: [{ id: 'all', capabilities: ['orchestrator', 'planner', 'coder', 'system', 'qa'] }] }], {
      readiness: READINESS,
      resourceBudget: { maxRamMb: 4096, maxVcpus: 4, maxQubes: 4 }
    }),
    /ramMb must be a positive finite number/
  );
  assert.throws(
    () => evaluateResourceAwareFleetTopologies(missions, DURATIONS, topologies(), {
      readiness: READINESS,
      resourceBudget: { maxRamMb: 0, maxVcpus: 4, maxQubes: 4 }
    }),
    /maxRamMb must be a positive finite number/
  );
});
