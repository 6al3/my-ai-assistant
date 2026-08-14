import { listMissions, claimMissionById, completeMission, failMission, heartbeatMission, recoverExpiredLeases } from '../agents/mission-queue.mjs';
import { reserveWorker, releaseWorker } from './scheduler.mjs';
import { reapStaleWorkers } from './worker-registry.mjs';

const CAP_MAP = {
  coder: 'coding', system: 'system', files: 'files', web: 'web', memory: 'memory',
  media: 'media', audit: 'audit', planner: 'planning', qa: 'qa', orchestrator: 'orchestration'
};

export function requiredCapabilities(mission) {
  const ids = mission?.plan?.agents?.map(a => a.id) || [];
  return [...new Set(ids.map(id => CAP_MAP[id]).filter(Boolean))];
}

export function dispatchNext(leaseMs) {
  recoverExpiredLeases();
  reapStaleWorkers();
  const queued = listMissions().filter(m => m.status === 'queued');
  if (!queued.length) return { status: 'idle', reason: 'no_queued_missions' };

  const skipped = [];
  for (const candidate of queued) {
    const capabilities = requiredCapabilities(candidate);
    const worker = reserveWorker(capabilities);
    if (!worker) {
      skipped.push({ missionId: candidate.id, capabilities });
      continue;
    }

    try {
      const mission = claimMissionById(candidate.id, worker.id, leaseMs);
      return { status: 'dispatched', worker, mission, capabilities, skipped };
    } catch (error) {
      releaseWorker(worker.id);
      if (error?.message === 'mission_not_queued') continue;
      throw error;
    }
  }

  return { status: 'waiting', reason: 'no_compatible_worker', skipped };
}

export function heartbeatDispatch({ missionId, workerId, leaseToken, leaseMs }) {
  return heartbeatMission(missionId, workerId, leaseToken, leaseMs);
}

export function completeDispatch({ missionId, workerId, leaseToken, result = {} }) {
  try { return completeMission(missionId, result, workerId, leaseToken); }
  finally { releaseWorker(workerId); }
}

export function failDispatch({ missionId, workerId, leaseToken, error }) {
  try { return failMission(missionId, error, workerId, leaseToken); }
  finally { releaseWorker(workerId); }
}
