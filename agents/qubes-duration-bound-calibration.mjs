import { deriveDurationBoundSampling, validateSampleOffsets } from './qubes-calibration-sampling-window.mjs';
import { runQubesResourceCalibration } from './qubes-resource-calibration-harness.mjs';
import { collectQubesResourceCalibration } from './qubes-resource-calibration.mjs';

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

function timingKey(round, workerId) {
  return `${round}:${workerId}`;
}

function buildWorkerOffsetMap(topology) {
  return new Map(topology.workers.map(worker => [worker.id, []]));
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
  const sampleCompletionOffsets = new Map();

  const sampleWorker = async (worker, round) => {
    const sample = await runtime.sampleWorker(worker, round);
    const offsetMs = now() - startedAt;
    if (!Number.isInteger(offsetMs) || offsetMs < 0) throw new Error('observed sample offset must be a non-negative integer');
    sampleCompletionOffsets.set(timingKey(round, worker.id), offsetMs);
    return sample;
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

  const observedWorkerOffsetsMs = buildWorkerOffsetMap(runtime.topology);
  let sampleIndex = 0;
  const workerCount = runtime.topology.workers.length;
  const annotated = events.map(event => {
    if (event.type !== 'worker_resource_sample') return event;
    const round = Math.floor(sampleIndex / workerCount);
    sampleIndex += 1;
    const sampleOffsetMs = sampleCompletionOffsets.get(timingKey(round, event.workerId));
    if (!Number.isInteger(sampleOffsetMs)) throw new Error(`missing observed sample timing for ${event.workerId} round ${round}`);
    const workerOffsets = observedWorkerOffsetsMs.get(event.workerId);
    if (!workerOffsets) throw new Error(`unexpected worker timing evidence: ${event.workerId}`);
    workerOffsets.push(sampleOffsetMs);
    return { ...event, sampleOffsetMs, workloadDurationMs };
  });

  for (const [workerId, offsets] of observedWorkerOffsetsMs) {
    try {
      validateSampleOffsets(offsets, policy);
    } catch (error) {
      throw new Error(`worker ${workerId} timing evidence invalid: ${error.message}`);
    }
  }

  const observedRoundOffsetsMs = Array.from({ length: policy.sampleCount }, (_, round) => {
    const offsets = runtime.topology.workers.map(worker => sampleCompletionOffsets.get(timingKey(round, worker.id)));
    if (offsets.some(offset => !Number.isInteger(offset))) throw new Error(`missing observed sample timing for round ${round}`);
    return Math.max(...offsets);
  });

  return {
    events: annotated,
    policy,
    observedRoundOffsetsMs,
    observedWorkerOffsetsMs: Object.fromEntries([...observedWorkerOffsetsMs].map(([workerId, offsets]) => [workerId, [...offsets]]))
  };
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
  const offsetsByWorker = new Map();
  for (const event of events ?? []) {
    if (event?.type !== 'worker_resource_sample') continue;
    if (!Number.isInteger(event.sampleOffsetMs) || event.sampleOffsetMs < 0) throw new Error('resource sampleOffsetMs is required');
    if (event.workloadDurationMs !== policy.workloadDurationMs) throw new Error('resource sample workload duration mismatch');
    const workerId = typeof event.workerId === 'string' && event.workerId.trim() ? event.workerId : null;
    if (!workerId) throw new Error('resource sample workerId is required');
    if (!offsetsByWorker.has(workerId)) offsetsByWorker.set(workerId, []);
    offsetsByWorker.get(workerId).push(event.sampleOffsetMs);
  }
  if (!offsetsByWorker.size) throw new Error('duration-bound resource samples are required');
  for (const [workerId, offsets] of offsetsByWorker) {
    try {
      validateSampleOffsets(offsets, policy);
    } catch (error) {
      throw new Error(`worker ${workerId} timing evidence invalid: ${error.message}`);
    }
  }
  return collectQubesResourceCalibration(events, {
    expectedGitSha,
    expectedTopologyId,
    expectedWorkloadId,
    requireWorkloadEvidence: true,
    minSamplesPerWorker
  });
}
