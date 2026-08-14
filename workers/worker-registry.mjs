import { randomUUID } from 'node:crypto';

const DEFAULT_TTL_MS = 30_000;
const workers = new Map();

function nowMs() { return Date.now(); }

export function registerWorker(input = {}) {
  const id = String(input.id || randomUUID());
  const worker = {
    id,
    name: String(input.name || id),
    capabilities: [...new Set((input.capabilities || []).map(String))],
    maxConcurrent: Math.max(1, Number(input.maxConcurrent || 1)),
    activeJobs: Math.max(0, Number(input.activeJobs || 0)),
    metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : {},
    status: 'online',
    registeredAt: new Date().toISOString(),
    lastHeartbeatAt: new Date().toISOString(),
    expiresAt: nowMs() + Math.max(5_000, Number(input.ttlMs || DEFAULT_TTL_MS))
  };
  workers.set(id, worker);
  return structuredClone(worker);
}

export function heartbeatWorker(id, patch = {}) {
  const worker = workers.get(String(id));
  if (!worker) return null;
  if (Array.isArray(patch.capabilities)) worker.capabilities = [...new Set(patch.capabilities.map(String))];
  if (patch.activeJobs !== undefined) worker.activeJobs = Math.max(0, Number(patch.activeJobs));
  if (patch.maxConcurrent !== undefined) worker.maxConcurrent = Math.max(1, Number(patch.maxConcurrent));
  worker.status = 'online';
  worker.lastHeartbeatAt = new Date().toISOString();
  worker.expiresAt = nowMs() + Math.max(5_000, Number(patch.ttlMs || DEFAULT_TTL_MS));
  return structuredClone(worker);
}

export function markWorkerLoad(id, delta) {
  const worker = workers.get(String(id));
  if (!worker) return null;
  worker.activeJobs = Math.max(0, worker.activeJobs + Number(delta || 0));
  return structuredClone(worker);
}

export function reapStaleWorkers(at = nowMs()) {
  const stale = [];
  for (const worker of workers.values()) {
    if (worker.status === 'online' && worker.expiresAt <= at) {
      worker.status = 'offline';
      stale.push(structuredClone(worker));
    }
  }
  return stale;
}

export function listWorkers({ includeOffline = true } = {}) {
  reapStaleWorkers();
  return [...workers.values()]
    .filter(w => includeOffline || w.status === 'online')
    .map(w => structuredClone(w));
}

export function getWorker(id) {
  reapStaleWorkers();
  const worker = workers.get(String(id));
  return worker ? structuredClone(worker) : null;
}

export function resetWorkersForTest() {
  workers.clear();
}
