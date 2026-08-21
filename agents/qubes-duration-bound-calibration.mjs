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

function validateProbeEnvelope({ workerId, startedOffsetMs, completedOffsetMs, workloadDurationMs, maxProbeLatencyMs }) {
  if (!Number.isInteger(startedOffsetMs) || startedOffsetMs < 0) throw new Error(`worker ${workerId} probe start offset must be a non-negative integer`);
  if (!Number.isInteger(completedOffsetMs) || completedOffsetMs < startedOffsetMs) throw new Error(`worker ${workerId} probe completion offset is invalid`);
  if (completedOffsetMs >= workloadDurationMs) throw new Error(`worker ${workerId} probe envelope ends outside active workload window`);
  const probeLatencyMs = completedOffsetMs - startedOffsetMs;
  if (maxProbeLatencyMs != null && probeLatencyMs > maxProbeLatencyMs) throw new Error(`worker ${workerId} probe latency ${probeLatencyMs}ms exceeds budget ${maxProbeLatencyMs}ms`);
  return probeLatencyMs;
}

export async function runDurationBoundQubesCalibration({
  gitSha,
  runtime,
  runId,
  sampleCount = 5,
  requestedIntervalMs = null,
  reserveMs = 1,
  maxProbeLatencyMs = null,
  sleep,
  now = () => Date.now()
} = {}) {
  if (!runtime?.plan || !runtime?.topology) throw new Error('calibration runtime with plan and topology is required');
  const workloadDurationMs = positiveInteger(runtime.plan.durationMs, 'runtime.plan.durationMs');
  if (maxProbeLatencyMs != null) positiveInteger(maxProbeLatencyMs, 'maxProbeLatencyMs');
  const policy = deriveDurationBoundSampling({ workloadDurationMs, sampleCount, requestedIntervalMs, reserveMs });
  const startedAt = now();
  const sampleTimings = new Map();

  const sampleWorker = async (worker, round) => {
    const startedOffsetMs = now() - startedAt;
    const sample = await runtime.sampleWorker(worker, round);
    const completedOffsetMs = now() - startedAt;
    const probeLatencyMs = validateProbeEnvelope({ workerId: worker.id, startedOffsetMs, completedOffsetMs, workloadDurationMs, maxProbeLatencyMs });
    sampleTimings.set(timingKey(round, worker.id), { startedOffsetMs, completedOffsetMs, probeLatencyMs });
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
  const probeLatenciesByWorkerMs = buildWorkerOffsetMap(runtime.topology);
  let sampleIndex = 0;
  const workerCount = runtime.topology.workers.length;
  const annotated = events.map(event => {
    if (event.type !== 'worker_resource_sample') return event;
    const round = Math.floor(sampleIndex / workerCount);
    sampleIndex += 1;
    const timing = sampleTimings.get(timingKey(round, event.workerId));
    if (!timing) throw new Error(`missing observed sample timing for ${event.workerId} round ${round}`);
    const workerOffsets = observedWorkerOffsetsMs.get(event.workerId);
    const workerLatencies = probeLatenciesByWorkerMs.get(event.workerId);
    if (!workerOffsets || !workerLatencies) throw new Error(`unexpected worker timing evidence: ${event.workerId}`);
    workerOffsets.push(timing.completedOffsetMs);
    workerLatencies.push(timing.probeLatencyMs);
    return {
      ...event,
      sampleStartedOffsetMs: timing.startedOffsetMs,
      sampleOffsetMs: timing.completedOffsetMs,
      probeLatencyMs: timing.probeLatencyMs,
      workloadDurationMs
    };
  });

  for (const [workerId, offsets] of observedWorkerOffsetsMs) {
    try {
      validateSampleOffsets(offsets, policy);
    } catch (error) {
      throw new Error(`worker ${workerId} timing evidence invalid: ${error.message}`);
    }
  }

  const observedRoundOffsetsMs = Array.from({ length: policy.sampleCount }, (_, round) => {
    const offsets = runtime.topology.workers.map(worker => sampleTimings.get(timingKey(round, worker.id))?.completedOffsetMs);
    if (offsets.some(offset => !Number.isInteger(offset))) throw new Error(`missing observed sample timing for round ${round}`);
    return Math.max(...offsets);
  });

  return {
    events: annotated,
    policy,
    observedRoundOffsetsMs,
    observedWorkerOffsetsMs: Object.fromEntries([...observedWorkerOffsetsMs].map(([workerId, offsets]) => [workerId, [...offsets]])),
    probeLatenciesByWorkerMs: Object.fromEntries([...probeLatenciesByWorkerMs].map(([workerId, latencies]) => [workerId, [...latencies]]))
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
  maxProbeLatencyMs = null,
  minSamplesPerWorker = 3
} = {}) {
  if (maxProbeLatencyMs != null) positiveInteger(maxProbeLatencyMs, 'maxProbeLatencyMs');
  const policy = deriveDurationBoundSampling({ workloadDurationMs, sampleCount, requestedIntervalMs, reserveMs });
  const offsetsByWorker = new Map();
  for (const event of events ?? []) {
    if (event?.type !== 'worker_resource_sample') continue;
    if (!Number.isInteger(event.sampleStartedOffsetMs) || event.sampleStartedOffsetMs < 0) throw new Error('resource sampleStartedOffsetMs is required');
    if (!Number.isInteger(event.sampleOffsetMs) || event.sampleOffsetMs < 0) throw new Error('resource sampleOffsetMs is required');
    if (event.workloadDurationMs !== policy.workloadDurationMs) throw new Error('resource sample workload duration mismatch');
    const workerId = typeof event.workerId === 'string' && event.workerId.trim() ? event.workerId : null;
    if (!workerId) throw new Error('resource sample workerId is required');
    const probeLatencyMs = validateProbeEnvelope({
      workerId,
      startedOffsetMs: event.sampleStartedOffsetMs,
      completedOffsetMs: event.sampleOffsetMs,
      workloadDurationMs: policy.workloadDurationMs,
      maxProbeLatencyMs
    });
    if (event.probeLatencyMs !== probeLatencyMs) throw new Error(`worker ${workerId} probe latency evidence mismatch`);
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
    requireProbeLatencyEvidence: true,
    minSamplesPerWorker
  });
}
