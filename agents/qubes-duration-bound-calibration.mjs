import { deriveDurationBoundSampling, validateSampleOffsets } from './qubes-calibration-sampling-window.mjs';
import { runQubesResourceCalibration } from './qubes-resource-calibration-harness.mjs';
import { collectQubesResourceCalibration } from './qubes-resource-calibration.mjs';

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

export async function runDurationBoundQubesCalibration({
  gitSha,
  runtime,
  runId,
  sampleCount = 5,
  requestedIntervalMs = null,
  reserveMs = 1,
  sleep,
  now = () => Date.now()
} = {}) {
  if (!runtime?.plan || !runtime?.topology) throw new Error('calibration runtime with plan and topology is required');
  const workloadDurationMs = positiveInteger(runtime.plan.durationMs, 'runtime.plan.durationMs');
  const policy = deriveDurationBoundSampling({ workloadDurationMs, sampleCount, requestedIntervalMs, reserveMs });
  const startedAt = now();
  const offsets = [];
  const sampleWorker = async (worker, round) => {
    const offsetMs = now() - startedAt;
    if (!Number.isInteger(offsetMs) || offsetMs < 0) throw new Error('observed sample offset must be a non-negative integer');
    offsets[round] = offsets[round] === undefined ? offsetMs : Math.min(offsets[round], offsetMs);
    return runtime.sampleWorker(worker, round);
  };
  const events = await runQubesResourceCalibration({
    gitSha,
    topology: runtime.topology,
    runId,
    workloadId: runtime.plan.workloadId,
    sampleCount: policy.sampleCount,
    intervalMs: policy.intervalMs,
    sampleWorker,
    startWorkload: runtime.startWorkload,
    stopWorkload: runtime.stopWorkload,
    sleep
  });
  validateSampleOffsets(offsets, policy);
  const annotated = events.map(event => {
    if (event.type !== 'worker_resource_sample') return event;
    const round = annotatedRoundIndex(event, runtime.topology.workers.length, events);
    const sampleOffsetMs = offsets[round];
    if (!Number.isInteger(sampleOffsetMs)) throw new Error(`missing observed sample timing for round ${round}`);
    return { ...event, sampleOffsetMs, workloadDurationMs };
  });
  return { events: annotated, policy, observedRoundOffsetsMs: [...offsets] };
}

function annotatedRoundIndex(target, workerCount, events) {
  let sampleIndex = 0;
  for (const event of events) {
    if (event.type !== 'worker_resource_sample') continue;
    if (event === target) return Math.floor(sampleIndex / workerCount);
    sampleIndex += 1;
  }
  throw new Error('resource sample not found in event stream');
}

export function collectDurationBoundQubesCalibration(events, {
  expectedGitSha,
  expectedTopologyId,
  expectedWorkloadId,
  workloadDurationMs,
  sampleCount = 5,
  requestedIntervalMs = null,
  reserveMs = 1,
  minSamplesPerWorker = 3
} = {}) {
  const policy = deriveDurationBoundSampling({ workloadDurationMs, sampleCount, requestedIntervalMs, reserveMs });
  const offsets = [];
  for (const event of events ?? []) {
    if (event?.type !== 'worker_resource_sample') continue;
    if (!Number.isInteger(event.sampleOffsetMs) || event.sampleOffsetMs < 0) throw new Error('resource sampleOffsetMs is required');
    if (event.workloadDurationMs !== policy.workloadDurationMs) throw new Error('resource sample workload duration mismatch');
    if (!offsets.includes(event.sampleOffsetMs)) offsets.push(event.sampleOffsetMs);
  }
  offsets.sort((a, b) => a - b);
  validateSampleOffsets(offsets, policy);
  return collectQubesResourceCalibration(events, {
    expectedGitSha,
    expectedTopologyId,
    expectedWorkloadId,
    requireWorkloadEvidence: true,
    minSamplesPerWorker
  });
}
