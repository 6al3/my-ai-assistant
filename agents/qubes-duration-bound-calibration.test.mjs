import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as delayUntilImmediate } from 'node:timers/promises';
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

function virtualClock(start = 1000) {
  let current = start;
  return {
    now: () => current,
    sleep: async ms => { current += ms; }
  };
}

test('records per-worker probe envelopes inside the 210ms DAG workload', async () => {
  const clock = virtualClock();
  const { events, policy, observedRoundOffsetsMs, probeLatenciesByWorkerMs } = await runDurationBoundQubesCalibration({
    gitSha: SHA, runtime: runtime(), runId: 'duration-bound-1', sampleCount: 5, sleep: clock.sleep, now: clock.now
  });
  assert.equal(policy.intervalMs, 52);
  assert.equal(policy.lastSampleOffsetMs, 208);
  assert.deepEqual(observedRoundOffsetsMs, [0, 52, 104, 156, 208]);
  assert.deepEqual(probeLatenciesByWorkerMs['coord-code-qa'], [0, 0, 0, 0, 0]);
  for (const event of events.filter(event => event.type === 'worker_resource_sample')) {
    assert.equal(event.sampleStartedOffsetMs, event.sampleOffsetMs);
    assert.equal(event.probeLatencyMs, 0);
  }
  const report = collectDurationBoundQubesCalibration(events, {
    expectedGitSha: SHA, expectedTopologyId: topology.id, expectedWorkloadId: 'synthetic-dag-v1', workloadDurationMs: 210, sampleCount: 5, minSamplesPerWorker: 5
  });
  assert.equal(report.workloadBound, true);
});

test('fails closed when one worker completion leaves the active workload', async () => {
  let current = 1000;
  const delayedRuntime = runtime();
  delayedRuntime.sampleWorker = async worker => {
    if (worker.id === 'system') { await delayUntilImmediate(); current = 1220; }
    return { ramMb: 700, cpuPercent: 40, vcpus: 1 };
  };
  await assert.rejects(() => runDurationBoundQubesCalibration({
    gitSha: SHA, runtime: delayedRuntime, runId: 'late-worker', sampleCount: 1, now: () => current, sleep: async () => {}
  }), /worker system probe envelope ends outside active workload window/);
});

test('fails closed when probe latency exceeds its budget while still inside workload', async () => {
  let current = 1000;
  const delayedRuntime = runtime();
  delayedRuntime.sampleWorker = async worker => {
    if (worker.id === 'system') current += 12;
    return { ramMb: 700, cpuPercent: 40, vcpus: 1 };
  };
  await assert.rejects(() => runDurationBoundQubesCalibration({
    gitSha: SHA, runtime: delayedRuntime, runId: 'slow-probe', sampleCount: 1, maxProbeLatencyMs: 10, now: () => current, sleep: async () => {}
  }), /probe latency 12ms exceeds budget 10ms/);
});

test('collector rejects forged or over-budget probe envelope evidence', async () => {
  const clock = virtualClock();
  const { events } = await runDurationBoundQubesCalibration({ gitSha: SHA, runtime: runtime(), runId: 'collector', sampleCount: 5, sleep: clock.sleep, now: clock.now });
  const sampleIndex = events.findIndex(event => event.type === 'worker_resource_sample');
  const forged = events.map(event => ({ ...event }));
  forged[sampleIndex].probeLatencyMs = 9;
  assert.throws(() => collectDurationBoundQubesCalibration(forged, {
    expectedGitSha: SHA, expectedTopologyId: topology.id, expectedWorkloadId: 'synthetic-dag-v1', workloadDurationMs: 210, sampleCount: 5
  }), /probe latency evidence mismatch/);

  const slow = events.map(event => ({ ...event }));
  slow[sampleIndex].sampleStartedOffsetMs = 0;
  slow[sampleIndex].sampleOffsetMs = 11;
  slow[sampleIndex].probeLatencyMs = 11;
  assert.throws(() => collectDurationBoundQubesCalibration(slow, {
    expectedGitSha: SHA, expectedTopologyId: topology.id, expectedWorkloadId: 'synthetic-dag-v1', workloadDurationMs: 210, sampleCount: 5, maxProbeLatencyMs: 10
  }), /probe latency 11ms exceeds budget 10ms/);
});

test('rejects explicit interval that would sample after workload', async () => {
  await assert.rejects(() => runDurationBoundQubesCalibration({ gitSha: SHA, runtime: runtime(), runId: 'bad', sampleCount: 5, requestedIntervalMs: 1000 }), /sampling window exceeds active workload/);
});
