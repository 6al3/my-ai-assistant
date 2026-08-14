import { listWorkers, markWorkerLoad } from './worker-registry.mjs';

function normalizedLoad(worker) {
  return worker.maxConcurrent > 0 ? worker.activeJobs / worker.maxConcurrent : 1;
}

export function rankWorkers(requiredCapabilities = []) {
  const required = [...new Set(requiredCapabilities.map(String))];
  return listWorkers({ includeOffline: false })
    .filter(worker => worker.activeJobs < worker.maxConcurrent)
    .map(worker => {
      const matched = required.filter(cap => worker.capabilities.includes(cap));
      const fullMatch = matched.length === required.length;
      const score = (fullMatch ? 1000 : 0) + matched.length * 100 - normalizedLoad(worker) * 50;
      return { worker, matched, fullMatch, score };
    })
    .filter(item => required.length === 0 || item.fullMatch)
    .sort((a, b) => b.score - a.score || a.worker.id.localeCompare(b.worker.id));
}

export function selectWorker(requiredCapabilities = []) {
  return rankWorkers(requiredCapabilities)[0]?.worker || null;
}

export function reserveWorker(requiredCapabilities = []) {
  const worker = selectWorker(requiredCapabilities);
  if (!worker) return null;
  return markWorkerLoad(worker.id, 1);
}

export function releaseWorker(workerId) {
  return markWorkerLoad(workerId, -1);
}
