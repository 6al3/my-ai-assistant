import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);

function nonEmpty(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function safeName(value, label) {
  const normalized = nonEmpty(value, label);
  if (!/^[A-Za-z0-9_.-]+$/.test(normalized)) throw new Error(`${label} contains unsupported characters`);
  return normalized;
}

function positiveInteger(value, label, max) {
  if (!Number.isInteger(value) || value <= 0 || value > max) throw new Error(`${label} must be an integer between 1 and ${max}`);
  return value;
}

function nonNegativeInteger(value, label, max) {
  if (!Number.isInteger(value) || value < 0 || value > max) throw new Error(`${label} must be an integer between 0 and ${max}`);
  return value;
}

export function validateCalibrationTopology(topology) {
  if (!topology || typeof topology !== 'object') throw new Error('topology is required');
  const id = nonEmpty(topology.id, 'topology.id');
  if (!Array.isArray(topology.workers) || topology.workers.length === 0) throw new Error('topology workers are required');
  const ids = new Set();
  const workers = topology.workers.map(worker => {
    const workerId = safeName(worker?.id, 'worker.id');
    if (ids.has(workerId)) throw new Error(`duplicate worker id: ${workerId}`);
    ids.add(workerId);
    const qube = safeName(worker?.qube ?? workerId, `worker ${workerId} qube`);
    const capabilities = [...new Set((worker?.capabilities ?? []).map(value => safeName(value, `worker ${workerId} capability`)))].sort();
    if (!capabilities.length) throw new Error(`worker ${workerId} capabilities are required`);
    return { id: workerId, qube, capabilities };
  });
  return { id, workers };
}

export function parseResourceProbeResponse(text) {
  let value;
  try {
    value = JSON.parse(nonEmpty(text, 'resource probe response'));
  } catch (error) {
    throw new Error(`invalid resource probe JSON: ${error.message}`);
  }
  if (!Number.isFinite(value.ramMb) || value.ramMb < 0) throw new Error('resource probe ramMb is invalid');
  if (!Number.isFinite(value.cpuPercent) || value.cpuPercent < 0 || value.cpuPercent > 100) throw new Error('resource probe cpuPercent is invalid');
  if (!Number.isInteger(value.vcpus) || value.vcpus <= 0) throw new Error('resource probe vcpus is invalid');
  return { ramMb: value.ramMb, cpuPercent: value.cpuPercent, vcpus: value.vcpus };
}

export async function probeWorkerViaQrexec(worker, {
  service,
  execFileFn = execFileAsync,
  timeoutMs = 5000
} = {}) {
  const qrexecService = safeName(service, 'qrexec resource service');
  const timeout = positiveInteger(timeoutMs, 'probe timeoutMs', 60000);
  let result;
  try {
    result = await execFileFn('qrexec-client-vm', [worker.qube, qrexecService], { timeout, maxBuffer: 64 * 1024, encoding: 'utf8' });
  } catch (error) {
    throw new Error(`resource probe failed for ${worker.id}: ${error.message}`);
  }
  return parseResourceProbeResponse(result?.stdout ?? '');
}

export async function runQubesResourceCalibration({
  gitSha,
  topology,
  runId = randomUUID(),
  sampleCount = 5,
  intervalMs = 1000,
  sampleWorker,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
} = {}) {
  const expectedGitSha = nonEmpty(gitSha, 'gitSha');
  const normalizedTopology = validateCalibrationTopology(topology);
  const expectedRunId = safeName(runId, 'runId');
  const samples = positiveInteger(sampleCount, 'sampleCount', 100);
  const interval = nonNegativeInteger(intervalMs, 'intervalMs', 60000);
  if (typeof sampleWorker !== 'function') throw new Error('sampleWorker is required');

  const events = [{ type: 'calibration_start', runId: expectedRunId, gitSha: expectedGitSha, topologyId: normalizedTopology.id }];
  for (let round = 0; round < samples; round += 1) {
    const roundSamples = await Promise.all(normalizedTopology.workers.map(async worker => ({ worker, sample: await sampleWorker(worker, round) })));
    for (const { worker, sample } of roundSamples) {
      const parsed = parseResourceProbeResponse(JSON.stringify(sample));
      events.push({
        type: 'worker_resource_sample',
        runId: expectedRunId,
        workerId: worker.id,
        capabilities: worker.capabilities,
        ramMb: parsed.ramMb,
        cpuPercent: parsed.cpuPercent,
        vcpus: parsed.vcpus
      });
    }
    if (round + 1 < samples && interval > 0) await sleep(interval);
  }
  events.push({ type: 'calibration_end', runId: expectedRunId });
  return events;
}

async function main() {
  const gitSha = nonEmpty(process.env.DIG_GIT_SHA, 'DIG_GIT_SHA');
  const service = safeName(process.env.DIG_QREXEC_RESOURCE_SERVICE, 'DIG_QREXEC_RESOURCE_SERVICE');
  const topology = JSON.parse(nonEmpty(process.env.DIG_CALIBRATION_TOPOLOGY_JSON, 'DIG_CALIBRATION_TOPOLOGY_JSON'));
  const runId = process.env.DIG_CALIBRATION_RUN_ID || randomUUID();
  const sampleCount = process.env.DIG_CALIBRATION_SAMPLE_COUNT ? Number(process.env.DIG_CALIBRATION_SAMPLE_COUNT) : 5;
  const intervalMs = process.env.DIG_CALIBRATION_INTERVAL_MS ? Number(process.env.DIG_CALIBRATION_INTERVAL_MS) : 1000;
  const timeoutMs = process.env.DIG_CALIBRATION_PROBE_TIMEOUT_MS ? Number(process.env.DIG_CALIBRATION_PROBE_TIMEOUT_MS) : 5000;
  const events = await runQubesResourceCalibration({
    gitSha,
    topology,
    runId,
    sampleCount,
    intervalMs,
    sampleWorker: worker => probeWorkerViaQrexec(worker, { service, timeoutMs })
  });
  for (const event of events) process.stdout.write(`${JSON.stringify(event)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`DIG resource calibration harness failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
