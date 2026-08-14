import { randomUUID } from 'node:crypto';
import { buildExecutionPlan } from './orchestrator.mjs';
import { loadMissionSnapshot, saveMissionSnapshot } from './mission-store.mjs';

const MAX_MISSIONS = 200;
const DEFAULT_LEASE_MS = Number(process.env.DIG_MISSION_LEASE_MS || 60_000);
const missions = new Map(loadMissionSnapshot().map(m => [m.id, m]));

function now() { return new Date().toISOString(); }
function nowMs() { return Date.now(); }
function clampPriority(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.trunc(n))) : 50;
}
function persist() { saveMissionSnapshot([...missions.values()]); }
function leaseExpiry(ms = DEFAULT_LEASE_MS) {
  return new Date(nowMs() + Math.max(1_000, Number(ms) || DEFAULT_LEASE_MS)).toISOString();
}

export function createMission({ goal, priority = 50, metadata = {}, maxAttempts = 3 }) {
  const text = String(goal || '').trim();
  if (!text) throw new Error('goal_required');
  const id = randomUUID();
  const plan = buildExecutionPlan(text);
  const mission = {
    id, goal: text, priority: clampPriority(priority), metadata, status: 'queued', plan,
    attempts: 0, maxAttempts: Math.max(1, Math.trunc(Number(maxAttempts) || 3)),
    createdAt: now(), updatedAt: now(), events: [{ at: now(), type: 'created' }]
  };
  missions.set(id, mission);
  trimQueue();
  persist();
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

function claimMission(live, workerId, leaseMs) {
  if (!live) return null;
  if (live.status !== 'queued') throw new Error('mission_not_queued');
  live.status = 'running';
  live.workerId = workerId;
  live.attempts += 1;
  live.startedAt = live.startedAt || now();
  live.leaseToken = randomUUID();
  live.leaseExpiresAt = leaseExpiry(leaseMs);
  live.updatedAt = now();
  live.events.push({ at: now(), type: 'claimed', workerId, leaseExpiresAt: live.leaseExpiresAt });
  persist();
  return structuredClone(live);
}

export function claimNextMission(workerId = 'local-worker', leaseMs = DEFAULT_LEASE_MS) {
  recoverExpiredLeases();
  const mission = listMissions().find(x => x.status === 'queued');
  return mission ? claimMission(missions.get(mission.id), workerId, leaseMs) : null;
}

export function claimMissionById(id, workerId = 'local-worker', leaseMs = DEFAULT_LEASE_MS) {
  recoverExpiredLeases();
  const live = missions.get(String(id));
  if (!live) throw new Error('mission_not_found');
  return claimMission(live, workerId, leaseMs);
}

export function heartbeatMission(id, workerId, leaseToken, leaseMs = DEFAULT_LEASE_MS) {
  const live = missions.get(id);
  if (!live) throw new Error('mission_not_found');
  assertLeaseOwner(live, workerId, leaseToken);
  live.leaseExpiresAt = leaseExpiry(leaseMs);
  live.updatedAt = now();
  live.events.push({ at: now(), type: 'heartbeat', workerId, leaseExpiresAt: live.leaseExpiresAt });
  persist();
  return structuredClone(live);
}

export function completeMission(id, result = {}, workerId, leaseToken) {
  const live = missions.get(id);
  if (!live) throw new Error('mission_not_found');
  if (live.status === 'running') assertLeaseOwner(live, workerId, leaseToken);
  clearLease(live);
  return transition(id, 'completed', { result, completedAt: now() }, 'completed');
}

export function failMission(id, error = 'unknown_error', workerId, leaseToken) {
  const live = missions.get(id);
  if (!live) throw new Error('mission_not_found');
  if (live.status === 'running') assertLeaseOwner(live, workerId, leaseToken);
  const retry = live.attempts < live.maxAttempts;
  clearLease(live);
  live.status = retry ? 'queued' : 'failed';
  live.lastError = String(error);
  live.updatedAt = now();
  live.events.push({ at: now(), type: retry ? 'retry_scheduled' : 'failed', error: live.lastError });
  persist();
  return structuredClone(live);
}

export function cancelMission(id) {
  const live = missions.get(id);
  if (!live) throw new Error('mission_not_found');
  clearLease(live);
  return transition(id, 'cancelled', { cancelledAt: now() }, 'cancelled');
}

export function recoverExpiredLeases(referenceTime = nowMs()) {
  let recovered = 0;
  for (const live of missions.values()) {
    if (live.status !== 'running' || !live.leaseExpiresAt) continue;
    if (Date.parse(live.leaseExpiresAt) > referenceTime) continue;
    const retry = live.attempts < live.maxAttempts;
    const priorWorker = live.workerId;
    clearLease(live);
    live.status = retry ? 'queued' : 'failed';
    live.lastError = 'worker_lease_expired';
    live.updatedAt = now();
    live.events.push({ at: now(), type: retry ? 'lease_recovered' : 'lease_exhausted', workerId: priorWorker });
    recovered += 1;
  }
  if (recovered) persist();
  return recovered;
}

function assertLeaseOwner(live, workerId, leaseToken) {
  if (live.status !== 'running') throw new Error('mission_not_running');
  if (!workerId || live.workerId !== workerId) throw new Error('worker_mismatch');
  if (!leaseToken || live.leaseToken !== leaseToken) throw new Error('lease_token_mismatch');
  if (!live.leaseExpiresAt || Date.parse(live.leaseExpiresAt) <= nowMs()) throw new Error('lease_expired');
}

function clearLease(live) {
  delete live.workerId;
  delete live.leaseToken;
  delete live.leaseExpiresAt;
}

function transition(id, status, patch, eventType) {
  const live = missions.get(id);
  if (!live) throw new Error('mission_not_found');
  Object.assign(live, patch, { status, updatedAt: now() });
  live.events.push({ at: now(), type: eventType });
  persist();
  return structuredClone(live);
}

function trimQueue() {
  if (missions.size <= MAX_MISSIONS) return;
  const removable = [...missions.values()]
    .filter(m => ['completed', 'failed', 'cancelled'].includes(m.status))
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  while (missions.size > MAX_MISSIONS && removable.length) missions.delete(removable.shift().id);
}
