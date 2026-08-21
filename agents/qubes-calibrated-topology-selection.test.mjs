import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MissionQueueStore } from './mission-queue-store.mjs';
import { OrchestratedMissionRuntime } from './orchestrated-mission-runtime.mjs';
import { evaluateCalibratedQubesTopologies } from './qubes-calibrated-topology-selection.mjs';

const SHA = 'a'.repeat(40);
const DURATIONS = { orchestrator: 20, planner: 30, coder: 80, system: 120, qa: 40 };
const READINESS = { minSpeedup: 1.25, maxLatencyPenaltyRatio: 0.1, maxQueueDelayMs: 10, maxFleetSize: 4 };

async function missionsFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dig-calibrated-selection-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = await OrchestratedMissionRuntime.open({ store: new MissionQueueStore(path.join(root, 'missions.json')) });
  return (await runtime.submit('plan project debug code and system reliability')).missions;
}

function candidates() {
  return [
    { id: 'two-worker-balanced', workers: [
      { id: 'coord-code-qa', capabilities: ['orchestrator', 'planner', 'coder', 'qa'] },
      { id: 'system', capabilities: ['system'] }
    ] },
    { id: 'four-worker-isolated', workers: [
      { id: 'coord', capabilities: ['orchestrator', 'planner'] },
      { id: 'coder', capabilities: ['coder'] },
      { id: 'system', capabilities: ['system'] },
      { id: 'qa', capabilities: ['qa'] }
    ] }
  ];
}

function calibration(topology, { probeLatencyP95Ms, ramMb = 700, vcpus = 1 } = {}) {
  return {
    topologyId: topology.id,
    gitSha: SHA,
    runId: `cal-${topology.id}`,
    workloadId: 'canonical-dag',
    digest: topology.id.padEnd(64, '0').slice(0, 64),
    workers: topology.workers.map(worker => ({
      id: worker.id,
      capabilities: [...worker.capabilities].sort(),
      resources: { ramMb, vcpus, cpuP95Percent: 50, probeLatencyP95Ms },
      sampleCount: 5
    }))
  };
}

test('measured probe latency can reject balanced topology and select stable isolated topology', async t => {
  const missions = await missionsFixture(t);
  const [two, four] = candidates();
  const evaluation = evaluateCalibratedQubesTopologies(missions, DURATIONS, [two, four], [
    calibration(two, { probeLatencyP95Ms: 18, ramMb: 900 }),
    calibration(four, { probeLatencyP95Ms: 4, ramMb: 700 })
  ], {
    expectedGitSha: SHA,
    readiness: READINESS,
    resourceBudget: { maxRamMb: 4096, maxVcpus: 6, maxQubes: 4, maxProbeLatencyP95Ms: 10 }
  });

  assert.equal(evaluation.winner.id, 'four-worker-isolated');
  const balanced = evaluation.results.find(result => result.id === 'two-worker-balanced');
  assert.equal(balanced.baseEligible, true);
  assert.equal(balanced.resourceGate.checks.probeLatencyBudget, false);
  assert.equal(balanced.resources.maxProbeLatencyP95Ms, 18);
  assert.equal(evaluation.winner.resources.maxProbeLatencyP95Ms, 4);
});

test('fails closed on missing, duplicate, wrong-SHA, or unexpected calibration', async t => {
  const missions = await missionsFixture(t);
  const [two, four] = candidates();
  const twoCal = calibration(two, { probeLatencyP95Ms: 4 });
  const fourCal = calibration(four, { probeLatencyP95Ms: 4 });
  const options = { expectedGitSha: SHA, readiness: READINESS, resourceBudget: { maxRamMb: 4096, maxVcpus: 6, maxQubes: 4, maxProbeLatencyP95Ms: 10 } };

  assert.throws(() => evaluateCalibratedQubesTopologies(missions, DURATIONS, [two, four], [twoCal], options), /missing calibration/);
  assert.throws(() => evaluateCalibratedQubesTopologies(missions, DURATIONS, [two], [twoCal, twoCal], options), /duplicate calibration/);
  assert.throws(() => evaluateCalibratedQubesTopologies(missions, DURATIONS, [two], [{ ...twoCal, gitSha: 'b'.repeat(40) }], options), /git SHA mismatch/);
  assert.throws(() => evaluateCalibratedQubesTopologies(missions, DURATIONS, [two], [twoCal, fourCal], options), /unexpected topologies/);
});
