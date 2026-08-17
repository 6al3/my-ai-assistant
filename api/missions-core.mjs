import { createHash } from 'node:crypto';
import { MissionQueueStore } from '../agents/mission-queue-store.mjs';

const STATUSES = new Set(['queued', 'running', 'completed', 'failed', 'cancelled']);

function isoTimestamp(value) {
  if (!Number.isFinite(value) || value < 0) throw new Error('invalid mission timestamp');
  return new Date(value).toISOString();
}

export function sanitizeMissionForControlPlane(mission) {
  if (!mission || typeof mission !== 'object') throw new Error('invalid mission record');
  if (typeof mission.id !== 'string' || !mission.id.trim()) throw new Error('invalid mission id');
  if (!STATUSES.has(mission.status)) throw new Error('invalid mission status');
  if (!Array.isArray(mission.requiredCapabilities) || mission.requiredCapabilities.some(value => typeof value !== 'string')) {
    throw new Error('invalid mission capabilities');
  }
  if (!Number.isInteger(mission.attempts) || mission.attempts < 0) throw new Error('invalid mission attempts');

  const maxAttempts = Number.isInteger(mission.maxAttempts) && mission.maxAttempts > 0
    ? mission.maxAttempts
    : 3;
  const executionPhase = typeof mission.metadata?.executionPhase === 'string'
    ? mission.metadata.executionPhase
    : null;

  return {
    id: mission.id,
    status: mission.status,
    executionPhase,
    requiredCapabilities: [...new Set(mission.requiredCapabilities)].sort(),
    attempts: mission.attempts,
    maxAttempts,
    updatedAt: isoTimestamp(mission.updatedAt)
  };
}

export function buildMissionControlPlaneSnapshot(snapshot) {
  if (snapshot?.version !== 1 || !Array.isArray(snapshot.missions)) {
    throw new Error('unsupported mission telemetry snapshot');
  }

  const missions = snapshot.missions
    .map(sanitizeMissionForControlPlane)
    .sort((a, b) => a.id.localeCompare(b.id));
  const serialized = JSON.stringify(missions);
  const revision = createHash('sha256').update(serialized).digest('hex');

  return {
    ok: true,
    revision,
    count: missions.length,
    missions
  };
}

export async function loadMissionControlPlaneSnapshot(path) {
  if (typeof path !== 'string' || !path.trim()) throw new Error('mission telemetry store is not configured');
  const store = new MissionQueueStore(path.trim());
  return buildMissionControlPlaneSnapshot(await store.load());
}
