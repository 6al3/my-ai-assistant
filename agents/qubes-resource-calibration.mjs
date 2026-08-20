import { createHash } from 'node:crypto';

function finiteNonNegative(value, label) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative finite number`);
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

function nonEmpty(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function percentile(values, p) {
  if (!values.length) throw new Error('percentile requires samples');
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
}

export function collectQubesResourceCalibration(events = [], {
  expectedGitSha,
  expectedTopologyId,
  minSamplesPerWorker = 3
} = {}) {
  nonEmpty(expectedGitSha, 'expectedGitSha');
  nonEmpty(expectedTopologyId, 'expectedTopologyId');
  positiveInteger(minSamplesPerWorker, 'minSamplesPerWorker');
  if (!Array.isArray(events) || events.length === 0) throw new Error('resource calibration events are required');

  let started = false;
  let ended = false;
  let runId = null;
  const samples = new Map();
  const workerProfiles = new Map();

  for (const event of events) {
    if (!event || typeof event !== 'object') throw new Error('resource calibration event must be an object');
    if (ended) throw new Error('resource calibration event observed after calibration_end');
    if (event.type === 'calibration_start') {
      if (started) throw new Error('duplicate calibration_start');
      started = true;
      runId = nonEmpty(event.runId, 'runId');
      if (nonEmpty(event.gitSha, 'gitSha') !== expectedGitSha) throw new Error('resource calibration git SHA mismatch');
      if (nonEmpty(event.topologyId, 'topologyId') !== expectedTopologyId) throw new Error('resource calibration topology mismatch');
      continue;
    }
    if (!started) throw new Error('resource calibration event observed before calibration_start');
    if (event.runId !== runId) throw new Error('resource calibration runId mismatch');
    if (event.type === 'worker_resource_sample') {
      const workerId = nonEmpty(event.workerId, 'workerId');
      const capabilities = [...new Set((event.capabilities ?? []).map(value => nonEmpty(value, 'capability')))].sort();
      if (!capabilities.length) throw new Error('worker capabilities are required');
      const ramMb = finiteNonNegative(event.ramMb, 'ramMb');
      const cpuPercent = finiteNonNegative(event.cpuPercent, 'cpuPercent');
      const vcpus = positiveInteger(event.vcpus, 'vcpus');
      const signature = JSON.stringify({ capabilities, vcpus });
      if (workerProfiles.has(workerId) && workerProfiles.get(workerId) !== signature) throw new Error(`worker ${workerId} profile changed during calibration`);
      workerProfiles.set(workerId, signature);
      const list = samples.get(workerId) ?? [];
      list.push({ ramMb, cpuPercent, vcpus, capabilities });
      samples.set(workerId, list);
      continue;
    }
    if (event.type === 'calibration_end') {
      ended = true;
      continue;
    }
    throw new Error(`unsupported resource calibration event type: ${event.type}`);
  }

  if (!ended) throw new Error('resource calibration did not end');
  const workers = [];
  for (const [workerId, list] of [...samples.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (list.length < minSamplesPerWorker) throw new Error(`worker ${workerId} has insufficient resource samples`);
    workers.push({
      id: workerId,
      capabilities: list[0].capabilities,
      resources: {
        ramMb: Math.ceil(percentile(list.map(item => item.ramMb), 0.95)),
        vcpus: list[0].vcpus,
        cpuP95Percent: percentile(list.map(item => item.cpuPercent), 0.95)
      },
      sampleCount: list.length
    });
  }
  if (!workers.length) throw new Error('resource calibration has no worker samples');
  const digest = createHash('sha256').update(JSON.stringify({ runId, expectedGitSha, expectedTopologyId, workers })).digest('hex');
  return { schemaVersion: 1, runId, gitSha: expectedGitSha, topologyId: expectedTopologyId, workers, digest };
}

export function applyQubesResourceCalibration(topology, calibration) {
  if (topology?.id !== calibration?.topologyId) throw new Error('topology/calibration mismatch');
  const measured = new Map(calibration.workers.map(worker => [worker.id, worker]));
  const workers = (topology.workers ?? []).map(worker => {
    const sample = measured.get(worker.id);
    if (!sample) throw new Error(`missing calibration for worker ${worker.id}`);
    const expected = [...new Set(worker.capabilities ?? [])].sort();
    if (JSON.stringify(expected) !== JSON.stringify(sample.capabilities)) throw new Error(`capability profile mismatch for worker ${worker.id}`);
    return { ...worker, resources: { ramMb: sample.resources.ramMb, vcpus: sample.resources.vcpus, cpuP95Percent: sample.resources.cpuP95Percent } };
  });
  if (workers.length !== measured.size) throw new Error('calibration contains unexpected workers');
  return { ...topology, workers, calibration: { runId: calibration.runId, gitSha: calibration.gitSha, digest: calibration.digest } };
}
