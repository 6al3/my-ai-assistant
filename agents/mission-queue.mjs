import { randomUUID } from 'node:crypto';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

export class MissionQueue {
  constructor({ maxAttempts = 3, leaseMs = 30_000, now = () => Date.now() } = {}) {
    this.maxAttempts = maxAttempts;
    this.leaseMs = leaseMs;
    this.now = now;
    this.missions = new Map();
  }

  enqueue({ task, priority = 0, requiredCapabilities = [], metadata = {} }) {
    if (!task?.trim()) throw new Error('task is required');
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
      .sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
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
    mission.leaseUntil = this.now() + this.leaseMs;
    mission.updatedAt = this.now();
    return structuredClone(mission);
  }

  complete(id, workerId, result = null) {
    const mission = this.#ownedRunning(id, workerId);
    mission.status = 'completed'; mission.result = result;
    mission.leaseUntil = null; mission.updatedAt = this.now();
    return structuredClone(mission);
  }

  fail(id, workerId, error) {
    const mission = this.#ownedRunning(id, workerId);
    mission.error = String(error ?? 'unknown failure');
    mission.workerId = null; mission.leaseUntil = null; mission.updatedAt = this.now();
    mission.status = mission.attempts >= this.maxAttempts ? 'failed' : 'queued';
    return structuredClone(mission);
  }

  requeueExpired() {
    const now = this.now();
    for (const mission of this.missions.values()) {
      if (mission.status !== 'running' || mission.leaseUntil > now) continue;
      mission.workerId = null; mission.leaseUntil = null; mission.updatedAt = now;
      mission.error = 'worker lease expired';
      mission.status = mission.attempts >= this.maxAttempts ? 'failed' : 'queued';
    }
  }

  get(id) {
    const mission = this.missions.get(id);
    return mission ? structuredClone(mission) : null;
  }

  list({ status } = {}) {
    return [...this.missions.values()]
      .filter(m => !status || m.status === status)
      .map(structuredClone);
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
