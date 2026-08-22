import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { buildOrchestrationCalibrationPlan, createOrchestrationCalibrationHooks } from './qubes-orchestration-calibration-workload.mjs';

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

function parseJsonObject(value, label) {
  let parsed;
  try {
    parsed = JSON.parse(nonEmpty(value, label));
  } catch (error) {
    throw new Error(`${label} must be valid JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${label} must be a JSON object`);
  return parsed;
}

function parseJsonArray(value, label) {
  let parsed;
  try {
    parsed = JSON.parse(nonEmpty(value, label));
  } catch (error) {
    throw new Error(`${label} must be valid JSON: ${error.message}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error(`${label} must be a non-empty JSON array`);
  return parsed;
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
  const workerId = safeName(worker?.id, 'worker.id');
  const qube = safeName(worker?.qube ?? workerId, `worker ${workerId} qube`);
  const qrexecService = safeName(service, 'qrexec resource service');
  const timeout = positiveInteger(timeoutMs, 'probe timeoutMs', 60000);
  let result;
  try {
    result = await execFileFn('qrexec-client-vm', [qube, qrexecService], { timeout, maxBuffer: 64 * 1024, encoding: 'utf8' });
  } catch (error) {
    throw new Error(`resource probe failed for ${workerId}: ${error.message}`);
  }
  return parseResourceProbeResponse(result?.stdout ?? '');
}

export function buildQubesCalibrationRuntime({
  topology,
  missions,
  durationsMs,
  workloadId = 'synthetic-dag-v1',
  resourceService,
  workloadService,
  probeTimeoutMs = 5000,
  workloadTimeoutMs = 5000,
  reconciliationAttempts = 3,
  reconciliationDelayMs = 100,
  probeWorker = probeWorkerViaQrexec,
  sendWorkloadCommand
} = {}) {
  const normalizedTopology = validateCalibrationTopology(topology);
  if (!Array.isArray(missions) || missions.length === 0) throw new Error('calibration missions are required');
  if (!durationsMs || typeof durationsMs !== 'object' || Array.isArray(durationsMs)) throw new Error('calibration durationsMs are required');
  const qrexecResourceService = safeName(resourceService, 'qrexec resource service');
  const qrexecWorkloadService = safeName(workloadService, 'qrexec workload service');
  const probeTimeout = positiveInteger(probeTimeoutMs, 'probe timeoutMs', 60000);
  const workloadTimeout = positiveInteger(workloadTimeoutMs, 'workload timeoutMs', 60000);
  const plan = buildOrchestrationCalibrationPlan({ missions, durationsMs, topology: normalizedTopology, workloadId });
  const hookOptions = { service: qrexecWorkloadService, timeoutMs: workloadTimeout, reconciliationAttempts, reconciliationDelayMs };
  if (sendWorkloadCommand) hookOptions.sendCommand = sendWorkloadCommand;
  const hooks = createOrchestrationCalibrationHooks(plan, hookOptions);
  return {
    topology: normalizedTopology,
    plan,
    startWorkload: hooks.startWorkload,
    stopWorkload: hooks.stopWorkload,
    sampleWorker: worker => probeWorker(worker, { service: qrexecResourceService, timeoutMs: probeTimeout })
  };
}

export async function runQubesResourceCalibration({
  gitSha,
  topology,
  runId = randomUUID(),
  workloadId = 'synthetic-calibration-v1',
  sampleCount = 5,
  intervalMs = 1000,
  sampleWorker,
  startWorkload,
  stopWorkload,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
} = {}) {
  const expectedGitSha = nonEmpty(gitSha, 'gitSha');
  const normalizedTopology = validateCalibrationTopology(topology);
  const expectedRunId = safeName(runId, 'runId');
  const expectedWorkloadId = safeName(workloadId, 'workloadId');
  const samples = positiveInteger(sampleCount, 'sampleCount', 100);
  const interval = nonNegativeInteger(intervalMs, 'intervalMs', 60000);
  if (typeof sampleWorker !== 'function') throw new Error('sampleWorker is required');
  if ((startWorkload && typeof startWorkload !== 'function') || (stopWorkload && typeof stopWorkload !== 'function')) throw new Error('workload hooks must be functions');
  if ((startWorkload && !stopWorkload) || (!startWorkload && stopWorkload)) throw new Error('startWorkload and stopWorkload must be configured together');

  const events = [{ type: 'calibration_start', runId: expectedRunId, gitSha: expectedGitSha, topologyId: normalizedTopology.id, workloadId: expectedWorkloadId }];
  let workloadStarted = false;
  try {
    if (startWorkload) {
      await startWorkload({ runId: expectedRunId, workloadId: expectedWorkloadId, topology: normalizedTopology });
      workloadStarted = true;
      events.push({ type: 'calibration_workload_started', runId: expectedRunId, workloadId: expectedWorkloadId });
    }
    for (let round = 0; round < samples; round += 1) {
      const roundSamples = await Promise.all(normalizedTopology.workers.map(async worker => ({ worker, sample: await sampleWorker(worker, round) })));
      for (const { worker, sample } of roundSamples) {
        const parsed = parseResourceProbeResponse(JSON.stringify(sample));
        events.push({ type: 'worker_resource_sample', runId: expectedRunId, workerId: worker.id, capabilities: worker.capabilities, ramMb: parsed.ramMb, cpuPercent: parsed.cpuPercent, vcpus: parsed.vcpus });
      }
      if (round + 1 < samples && interval > 0) await sleep(interval);
    }
  } finally {
    if (workloadStarted) {
      await stopWorkload({ runId: expectedRunId, workloadId: expectedWorkloadId, topology: normalizedTopology });
      events.push({ type: 'calibration_workload_stopped', runId: expectedRunId, workloadId: expectedWorkloadId });
    }
  }
  events.push({ type: 'calibration_end', runId: expectedRunId });
  return events;
}

export function calibrationCliConfigFromEnv(env = process.env) {
  const gitSha = nonEmpty(env.DIG_GIT_SHA, 'DIG_GIT_SHA');
  const resourceService = safeName(env.DIG_QREXEC_RESOURCE_SERVICE, 'DIG_QREXEC_RESOURCE_SERVICE');
  const workloadService = safeName(env.DIG_QREXEC_WORKLOAD_SERVICE, 'DIG_QREXEC_WORKLOAD_SERVICE');
  const topology = parseJsonObject(env.DIG_CALIBRATION_TOPOLOGY_JSON, 'DIG_CALIBRATION_TOPOLOGY_JSON');
  const missions = parseJsonArray(env.DIG_CALIBRATION_MISSIONS_JSON, 'DIG_CALIBRATION_MISSIONS_JSON');
  const durationsMs = parseJsonObject(env.DIG_CALIBRATION_DURATIONS_JSON, 'DIG_CALIBRATION_DURATIONS_JSON');
  const runId = env.DIG_CALIBRATION_RUN_ID || randomUUID();
  const workloadId = env.DIG_CALIBRATION_WORKLOAD_ID || 'synthetic-dag-v1';
  const sampleCount = env.DIG_CALIBRATION_SAMPLE_COUNT ? Number(env.DIG_CALIBRATION_SAMPLE_COUNT) : 5;
  const intervalMs = env.DIG_CALIBRATION_INTERVAL_MS ? Number(env.DIG_CALIBRATION_INTERVAL_MS) : 1000;
  const probeTimeoutMs = env.DIG_CALIBRATION_PROBE_TIMEOUT_MS ? Number(env.DIG_CALIBRATION_PROBE_TIMEOUT_MS) : 5000;
  const workloadTimeoutMs = env.DIG_CALIBRATION_WORKLOAD_TIMEOUT_MS ? Number(env.DIG_CALIBRATION_WORKLOAD_TIMEOUT_MS) : 5000;
  const reconciliationAttempts = env.DIG_CALIBRATION_RECONCILIATION_ATTEMPTS ? Number(env.DIG_CALIBRATION_RECONCILIATION_ATTEMPTS) : 3;
  const reconciliationDelayMs = env.DIG_CALIBRATION_RECONCILIATION_DELAY_MS ? Number(env.DIG_CALIBRATION_RECONCILIATION_DELAY_MS) : 100;
  return { gitSha, resourceService, workloadService, topology, missions, durationsMs, runId, workloadId, sampleCount, intervalMs, probeTimeoutMs, workloadTimeoutMs, reconciliationAttempts, reconciliationDelayMs };
}

async function legacyMainDisabled() {
  throw new Error('legacy calibration CLI disabled; use agents/qubes-duration-bound-calibration-cli.mjs');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  legacyMainDisabled().catch(error => {
    process.stderr.write(`DIG resource calibration harness failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
