import assert from 'node:assert/strict';
import test from 'node:test';
import { collectDurationBoundQubesCalibration, runDurationBoundQubesCalibration } from './qubes-duration-bound-calibration.mjs';

const SHA = 'a'.repeat(40);
const topology = {
  id: 'two-worker-balanced',
  workers: [
    { id: 'coord-code-qa', capabilities: ['orchestrator', 'planner', 'coder', 'qa'] },
    { id: 'system', capabilities: ['system'] }
  ]
};

function runtime() {
  return {
    topology,
    plan: { durationMs: 210, workloadId: 'synthetic-dag-v1' },
    startWorkload: async () => {},
    stopWorkload: async () => {},
    sampleWorker: async worker => ({ ramMb: worker.id === 'system' ? 700 : 1200, cpuPercent: 40, vcpus: worker.id === 'system' ? 1 : 2 })
  };
}

test('derives a five-sample window that remains inside the 210ms DAG workload', async () => {
  const sleeps = [];
  const { events, policy } = await runDurationBoundQubesCalibration({
    gitSha: SHA,
    runtime: runtime(),
    runId: 'duration-bound-1',
    sampleCount: 5,
    sleep: async ms => sleeps.push(ms)
  });
  assert.equal(policy.intervalMs, 52);
  assert.equal(policy.lastSampleOffsetMs, 208);
  assert.deepEqual(sleeps, [52, 52, 52, 52]);
  const offsets = [...new Set(events.filter(event => event.type === 'worker_resource_sample').map(event => event.sampleOffsetMs))];
  assert.deepEqual(offsets, [0, 52, 104, 156, 208]);
  const report = collectDurationBoundQubesCalibration(events, {
    expectedGitSha: SHA,
    expectedTopologyId: topology.id,
    expectedWorkloadId: 'synthetic-dag-v1',
    workloadDurationMs: 210,
    sampleCount: 5,
    minSamplesPerWorker: 5
  });
  assert.equal(report.workloadBound, true);
  assert.equal(report.workers.length, 2);
});

test('rejects an explicit interval that would sample after the workload', async () => {
  await assert.rejects(() => runDurationBoundQubesCalibration({
    gitSha: SHA,
    runtime: runtime(),
    runId: 'duration-bound-bad',
    sampleCount: 5,
    requestedIntervalMs: 1000
  }), /sampling window exceeds active workload/);
});

test('collector fails closed on missing, late, or mismatched sample timing evidence', async () => {
  const { events } = await runDurationBoundQubesCalibration({ gitSha: SHA, runtime: runtime(), runId: 'duration-bound-2', sampleCount: 5, sleep: async () => {} });
  const sampleIndex = events.findIndex(event => event.type === 'worker_resource_sample');
  const missing = events.map(event => ({ ...event }));
  delete missing[sampleIndex].sampleOffsetMs;
  assert.throws(() => collectDurationBoundQubesCalibration(missing, { expectedGitSha: SHA, expectedTopologyId: topology.id, expectedWorkloadId: 'synthetic-dag-v1', workloadDurationMs: 210, sampleCount: 5 }), /sampleOffsetMs is required/);

  const late = events.map(event => ({ ...event }));
  for (const event of late) if (event.type === 'worker_resource_sample' && event.sampleOffsetMs === 208) event.sampleOffsetMs = 210;
  assert.throws(() => collectDurationBoundQubesCalibration(late, { expectedGitSha: SHA, expectedTopologyId: topology.id, expectedWorkloadId: 'synthetic-dag-v1', workloadDurationMs: 210, sampleCount: 5 }), /outside active workload window/);

  const mismatch = events.map(event => event.type === 'worker_resource_sample' ? { ...event, workloadDurationMs: 211 } : { ...event });
  assert.throws(() => collectDurationBoundQubesCalibration(mismatch, { expectedGitSha: SHA, expectedTopologyId: topology.id, expectedWorkloadId: 'synthetic-dag-v1', workloadDurationMs: 210, sampleCount: 5 }), /workload duration mismatch/);
});
