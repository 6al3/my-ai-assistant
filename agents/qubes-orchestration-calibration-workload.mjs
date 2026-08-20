import { spawn } from 'node:child_process';
import { benchmarkOrchestrationFleet } from './orchestration-benchmark.mjs';

function nonEmpty(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}
function safeName(value, label) {
  const normalized = nonEmpty(value, label);
  if (!/^[A-Za-z0-9_.-]+$/.test(normalized)) throw new Error(`${label} contains unsupported characters`);
  return normalized;
}

export function buildOrchestrationCalibrationPlan({ missions, durationsMs, topology, workloadId = 'synthetic-dag-v1' } = {}) {
  if (!topology || !Array.isArray(topology.workers) || topology.workers.length === 0) throw new Error('topology workers are required');
  const id = nonEmpty(topology.id, 'topology.id');
  const expectedWorkloadId = safeName(workloadId, 'workloadId');
  const metrics = benchmarkOrchestrationFleet(missions, durationsMs, topology.workers);
  const workerById = new Map(topology.workers.map(worker => [worker.id, worker]));
  const assignments = new Map(topology.workers.map(worker => [worker.id, []]));
  for (const [missionId, timing] of Object.entries(metrics.timing)) {
    if (!workerById.has(timing.workerId)) throw new Error(`benchmark assigned unknown worker: ${timing.workerId}`);
    assignments.get(timing.workerId).push({ missionId, startMs: timing.startMs, durationMs: timing.durationMs });
  }
  const workers = topology.workers.map(worker => ({
    workerId: safeName(worker.id, 'worker.id'),
    qube: safeName(worker.qube ?? worker.id, `worker ${worker.id} qube`),
    capabilities: [...new Set(worker.capabilities ?? [])].map(value => safeName(value, `worker ${worker.id} capability`)).sort(),
    schedule: assignments.get(worker.id).sort((a, b) => a.startMs - b.startMs || a.missionId.localeCompare(b.missionId))
  }));
  return { version: 1, topologyId: id, workloadId: expectedWorkloadId, durationMs: metrics.constrainedLatencyMs, metrics: { constrainedLatencyMs: metrics.constrainedLatencyMs, maxQueueDelayMs: metrics.maxQueueDelayMs, peakConcurrentWorkers: metrics.peakConcurrentWorkers }, workers };
}

async function runWithInput(command, args, { input, timeout, maxBuffer = 64 * 1024 } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => { if (!settled) child.kill('SIGKILL'); }, timeout);
    const append = (current, chunk) => {
      const next = current + chunk.toString('utf8');
      if (Buffer.byteLength(next) > maxBuffer) throw new Error('workload service output exceeded maxBuffer');
      return next;
    };
    child.stdout.on('data', chunk => { try { stdout = append(stdout, chunk); } catch (error) { child.kill('SIGKILL'); reject(error); } });
    child.stderr.on('data', chunk => { try { stderr = append(stderr, chunk); } catch (error) { child.kill('SIGKILL'); reject(error); } });
    child.on('error', error => { settled = true; clearTimeout(timer); reject(error); });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`process exited ${code}: ${stderr.trim()}`)); else resolve({ stdout, stderr });
    });
    child.stdin.end(input);
  });
}

export async function sendWorkloadCommandViaQrexec(worker, command, { service, execFileFn = runWithInput, timeoutMs = 5000 } = {}) {
  const qube = safeName(worker?.qube ?? worker?.workerId, 'worker qube');
  const qrexecService = safeName(service, 'qrexec workload service');
  if (!command || typeof command !== 'object') throw new Error('workload command is required');
  const timeout = Number(timeoutMs);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 60000) throw new Error('workload timeoutMs is invalid');
  const input = `${JSON.stringify(command)}\n`;
  let result;
  try { result = await execFileFn('qrexec-client-vm', [qube, qrexecService], { timeout, maxBuffer: 64 * 1024, encoding: 'utf8', input }); }
  catch (error) { throw new Error(`workload command failed for ${qube}: ${error.message}`); }
  let response;
  try { response = JSON.parse(String(result?.stdout ?? '').trim()); } catch { throw new Error(`workload service returned invalid JSON for ${qube}`); }
  if (response?.ok !== true) throw new Error(`workload service rejected command for ${qube}`);
  return response;
}

export function createOrchestrationCalibrationHooks(plan, { service, sendCommand = sendWorkloadCommandViaQrexec, timeoutMs = 5000 } = {}) {
  if (!plan || plan.version !== 1 || !Array.isArray(plan.workers) || plan.workers.length === 0) throw new Error('valid workload plan is required');
  const qrexecService = safeName(service, 'qrexec workload service');
  return {
    startWorkload: async ({ runId, workloadId, topology }) => {
      if (workloadId !== plan.workloadId || topology?.id !== plan.topologyId) throw new Error('calibration workload binding mismatch');
      await Promise.all(plan.workers.map(worker => sendCommand(worker, { action: 'start', runId: safeName(runId, 'runId'), workloadId: plan.workloadId, durationMs: plan.durationMs, schedule: worker.schedule }, { service: qrexecService, timeoutMs })));
    },
    stopWorkload: async ({ runId, workloadId, topology }) => {
      if (workloadId !== plan.workloadId || topology?.id !== plan.topologyId) throw new Error('calibration workload binding mismatch');
      const results = await Promise.allSettled(plan.workers.map(worker => sendCommand(worker, { action: 'stop', runId: safeName(runId, 'runId'), workloadId: plan.workloadId }, { service: qrexecService, timeoutMs })));
      const failed = results.filter(result => result.status === 'rejected');
      if (failed.length) throw new AggregateError(failed.map(result => result.reason), 'failed to stop synthetic workload on all workers');
    }
  };
}
