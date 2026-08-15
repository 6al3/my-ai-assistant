import { randomUUID } from 'node:crypto';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

export class MissionQueue {
  constructor({ maxAttempts = 3, leaseMs = 30_000, now = () => Date.now() } = {}) {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error('maxAttempts must be >= 1');
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error('leaseMs must be > 0');
    this.maxAttempts = maxAttempts;
    this.leaseMs = leaseMs;
    this.now = now;
    this.missions = new Map();
  }

  enqueue({ task, priority = 0, requiredCapabilities = [], metadata = {} }) {
    if (typeof task !== 'string' || !task.trim()) throw new Error('task is required');
    if (!Number.isFinite(priority)) throw new Error('priority must be a finite number');
    if (!Array.isArray(requiredCapabilities)) throw new Error('requiredCapabilities must be an array');
    const mission = {
      id: randomUUID(), task: task.trim(), priority,
      requiredCapabilities: [...new Set(requiredCapabilities)], metadata,
      status: 'queued', attempts: 0, workerId: null, leaseUntil: null,
      createdAt: this.now(), updatedAt: this.now(), result: null, error: null
    };
    this.missions.set(mission.id, mission);
    return structuredClone(mission);
  }

  claim(worker) {
    if (!worker?.id) throw new Error('worker id is required');
    this.requeueExpired();
    const capabilities = new Set(worker.capabilities ?? []);
    const eligible = [...this.missions.values()]
      .filter(m => m.status === 'queued' && m.requiredCapabilities.every(c => capabilities.has(c)))
      .sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    const mission = eligible[0];
    if (!mission) return null;
    mission.status = 'running';
    mission.workerId = worker.id;
    mission.attempts += 1;
    mission.leaseUntil = this.now() + this.leaseMs;
    mission.updatedAt = this.now();
    return structuredClone(mission);
  }

  heartbeat(id, workerId) {
    const mission = this.#ownedRunning(id, workerId);
    if (mission.leaseUntil <= this.now()) throw new Error('mission lease expired');
    mission.leaseUntil = this.now() + this.leaseMs;
    mission.updatedAt = this.now();
    return structuredClone(mission);
  }

  complete(id, workerId, result = null) {
    const mission = this.#ownedRunning(id, workerId);
    if (mission.leaseUntil <= this.now()) throw new Error('mission lease expired');
    mission.status = 'completed'; mission.result = result;
    mission.leaseUntil = null; mission.updatedAt = this.now();
    return structuredClone(mission);
  }

  fail(id, workerId, error) {
    const mission = this.#ownedRunning(id, workerId);
    if (mission.leaseUntil <= this.now()) throw new Error('mission lease expired');
    mission.error = String(error ?? 'unknown failure');
    mission.workerId = null; mission.leaseUntil = null; mission.updatedAt = this.now();
    mission.status = mission.attempts >= this.maxAttempts ? 'failed' : 'queued';
    return structuredClone(mission);
  }

  cancel(id, reason = 'cancelled') {
    const mission = this.missions.get(id);
    if (!mission) throw new Error('mission not found');
    if (TERMINAL.has(mission.status)) throw new Error(`mission is ${mission.status}`);
    mission.status = 'cancelled';
    mission.error = String(reason);
    mission.workerId = null; mission.leaseUntil = null; mission.updatedAt = this.now();
    return structuredClone(mission);
  }

  requeueExpired() {
    const now = this.now();
    let count = 0;
    for (const mission of this.missions.values()) {
      if (mission.status !== 'running' || mission.leaseUntil > now) continue;
      mission.workerId = null; mission.leaseUntil = null; mission.updatedAt = now;
      mission.error = 'worker lease expired';
      mission.status = mission.attempts >= this.maxAttempts ? 'failed' : 'queued';
      count += 1;
    }
    return count;
  }

  get(id) {
    const mission = this.missions.get(id);
    return mission ? structuredClone(mission) : null;
  }

  list({ status } = {}) {
    return [...this.missions.values()]
      .filter(m => !status || m.status === status)
      .map(m => structuredClone(m));
  }

  stats() {
    const stats = { total: this.missions.size, queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 };
    for (const m of this.missions.values()) stats[m.status] += 1;
    return stats;
  }

  #ownedRunning(id, workerId) {
    const mission = this.missions.get(id);
    if (!mission) throw new Error('mission not found');
    if (TERMINAL.has(mission.status)) throw new Error(`mission is ${mission.status}`);
    if (mission.status !== 'running' || mission.workerId !== workerId) throw new Error('mission is not owned by worker');
    return mission;
  }
}
