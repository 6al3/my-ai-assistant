import { randomUUID } from 'node:crypto';
import { buildExecutionPlan } from './orchestrator.mjs';

const MAX_MISSIONS = 200;
const missions = new Map();

function now() { return new Date().toISOString(); }
function clampPriority(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.trunc(n))) : 50;
}

export function createMission({ goal, priority = 50, metadata = {} }) {
  const text = String(goal || '').trim();
  if (!text) throw new Error('goal_required');
  const id = randomUUID();
  const plan = buildExecutionPlan(text);
  const mission = {
    id,
    goal: text,
    priority: clampPriority(priority),
    metadata,
    status: 'queued',
    plan,
    attempts: 0,
    maxAttempts: 3,
    createdAt: now(),
    updatedAt: now(),
    events: [{ at: now(), type: 'created' }]
  };
  missions.set(id, mission);
  trimQueue();
  return structuredClone(mission);
}

export function listMissions() {
  return [...missions.values()]
    .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt))
    .map(structuredClone);
}

export function getMission(id) {
  const mission = missions.get(id);
  return mission ? structuredClone(mission) : null;
}

export function claimNextMission(workerId = 'local-worker') {
  const mission = listMissions().find(x => x.status === 'queued');
  if (!mission) return null;
  const live = missions.get(mission.id);
  live.status = 'running';
  live.workerId = workerId;
  live.attempts += 1;
  live.startedAt = live.startedAt || now();
  live.updatedAt = now();
  live.events.push({ at: now(), type: 'claimed', workerId });
  return structuredClone(live);
}

export function completeMission(id, result = {}) {
  return transition(id, 'completed', { result, completedAt: now() }, 'completed');
}

export function failMission(id, error = 'unknown_error') {
  const live = missions.get(id);
  if (!live) throw new Error('mission_not_found');
  const retry = live.attempts < live.maxAttempts;
  live.status = retry ? 'queued' : 'failed';
  live.lastError = String(error);
  live.updatedAt = now();
  live.events.push({ at: now(), type: retry ? 'retry_scheduled' : 'failed', error: live.lastError });
  return structuredClone(live);
}

export function cancelMission(id) {
  return transition(id, 'cancelled', { cancelledAt: now() }, 'cancelled');
}

function transition(id, status, patch, eventType) {
  const live = missions.get(id);
  if (!live) throw new Error('mission_not_found');
  Object.assign(live, patch, { status, updatedAt: now() });
  live.events.push({ at: now(), type: eventType });
  return structuredClone(live);
}

function trimQueue() {
  if (missions.size <= MAX_MISSIONS) return;
  const removable = [...missions.values()]
    .filter(m => ['completed', 'failed', 'cancelled'].includes(m.status))
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  while (missions.size > MAX_MISSIONS && removable.length) missions.delete(removable.shift().id);
}
