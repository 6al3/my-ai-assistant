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

test('derives a five-sample window and records observed timing inside the 210ms DAG workload', async () => {
  const clock = virtualClock();
  const { events, policy, observedRoundOffsetsMs, observedWorkerOffsetsMs } = await runDurationBoundQubesCalibration({
    gitSha: SHA,
    runtime: runtime(),
    runId: 'duration-bound-1',
    sampleCount: 5,
    sleep: clock.sleep,
    now: clock.now
  });
  assert.equal(policy.intervalMs, 52);
  assert.equal(policy.lastSampleOffsetMs, 208);
  assert.deepEqual(observedRoundOffsetsMs, [0, 52, 104, 156, 208]);
  assert.deepEqual(observedWorkerOffsetsMs['coord-code-qa'], [0, 52, 104, 156, 208]);
  assert.deepEqual(observedWorkerOffsetsMs.system, [0, 52, 104, 156, 208]);
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

test('fails closed when real sampling drifts beyond the active workload despite a safe planned interval', async () => {
  let current = 1000;
  let sleeps = 0;
  await assert.rejects(() => runDurationBoundQubesCalibration({
    gitSha: SHA,
    runtime: runtime(),
    runId: 'duration-bound-drift',
    sampleCount: 5,
    now: () => current,
    sleep: async ms => {
      sleeps += 1;
      current += ms + (sleeps === 4 ? 10 : 0);
    }
  }), /outside active workload window/);
});

test('fails closed when one worker response completes outside the workload even if another worker completes on time', async () => {
  let current = 1000;
  const delayedRuntime = runtime();
  delayedRuntime.sampleWorker = async worker => {
    if (worker.id === 'system') {
      await delayUntilImmediate();
      current = 1220;
    }
    return { ramMb: 700, cpuPercent: 40, vcpus: 1 };
  };
  await assert.rejects(() => runDurationBoundQubesCalibration({
    gitSha: SHA,
    runtime: delayedRuntime,
    runId: 'duration-bound-worker-skew',
    sampleCount: 1,
    now: () => current,
    sleep: async () => {}
  }), /worker system timing evidence invalid: sample offset 220ms is outside active workload window/);
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

test('collector validates timing independently per worker', async () => {
  const clock = virtualClock();
  const { events } = await runDurationBoundQubesCalibration({ gitSha: SHA, runtime: runtime(), runId: 'duration-bound-per-worker', sampleCount: 5, sleep: clock.sleep, now: clock.now });
  const skewed = events.map(event => event.type === 'worker_resource_sample' && event.workerId === 'system' && event.sampleOffsetMs === 208
    ? { ...event, sampleOffsetMs: 210 }
    : { ...event });
  assert.throws(() => collectDurationBoundQubesCalibration(skewed, {
    expectedGitSha: SHA,
    expectedTopologyId: topology.id,
    expectedWorkloadId: 'synthetic-dag-v1',
    workloadDurationMs: 210,
    sampleCount: 5
  }), /worker system timing evidence invalid: sample offset 210ms is outside active workload window/);
});

test('collector fails closed on missing, late, or mismatched sample timing evidence', async () => {
  const clock = virtualClock();
  const { events } = await runDurationBoundQubesCalibration({ gitSha: SHA, runtime: runtime(), runId: 'duration-bound-2', sampleCount: 5, sleep: clock.sleep, now: clock.now });
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
