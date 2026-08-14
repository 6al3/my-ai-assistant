import { listMissions, claimNextMission, completeMission, failMission, heartbeatMission, recoverExpiredLeases } from '../agents/mission-queue.mjs';
import { reserveWorker, releaseWorker } from './scheduler.mjs';
import { reapStaleWorkers } from './worker-registry.mjs';

const CAP_MAP = {
  coder: 'coding',
  system: 'system',
  files: 'files',
  web: 'web',
  memory: 'memory',
  media: 'media',
  audit: 'audit',
  planner: 'planning',
  qa: 'qa',
  orchestrator: 'orchestration'
};

export function requiredCapabilities(mission) {
  const ids = mission?.plan?.agents?.map(a => a.id) || [];
  return [...new Set(ids.map(id => CAP_MAP[id]).filter(Boolean))];
}

export function dispatchNext(leaseMs) {
  recoverExpiredLeases();
  reapStaleWorkers();
  const next = listMissions().find(m => m.status === 'queued');
  if (!next) return { status: 'idle', reason: 'no_queued_missions' };

  const capabilities = requiredCapabilities(next);
  const worker = reserveWorker(capabilities);
  if (!worker) return { status: 'waiting', reason: 'no_compatible_worker', missionId: next.id, capabilities };

  try {
    const mission = claimNextMission(worker.id, leaseMs);
    if (!mission) {
      releaseWorker(worker.id);
      return { status: 'idle', reason: 'mission_claim_race' };
    }
    return { status: 'dispatched', worker, mission, capabilities };
  } catch (error) {
    releaseWorker(worker.id);
    throw error;
  }
}

export function heartbeatDispatch({ missionId, workerId, leaseToken, leaseMs }) {
  return heartbeatMission(missionId, workerId, leaseToken, leaseMs);
}

export function completeDispatch({ missionId, workerId, leaseToken, result = {} }) {
  try {
    return completeMission(missionId, result, workerId, leaseToken);
  } finally {
    releaseWorker(workerId);
  }
}

export function failDispatch({ missionId, workerId, leaseToken, error }) {
  try {
    return failMission(missionId, error, workerId, leaseToken);
  } finally {
    releaseWorker(workerId);
  }
}
