import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class DurableMissionQueue {
  constructor({ filePath, maxAttempts = 3, leaseMs = 30_000, lockTimeoutMs = 5_000, lockRetryMs = 10, staleLockMs = 30_000, now = () => Date.now() } = {}) {
    if (!filePath) throw new Error('filePath is required');
    this.filePath = path.resolve(filePath);
    this.lockPath = `${this.filePath}.lock`;
    this.maxAttempts = maxAttempts;
    this.leaseMs = leaseMs;
    this.lockTimeoutMs = lockTimeoutMs;
    this.lockRetryMs = lockRetryMs;
    this.staleLockMs = staleLockMs;
    this.now = now;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) this.#writeState({ version: 1, missions: [] });
  }

  async enqueue({ task, priority = 0, requiredCapabilities = [], dependsOn = [], metadata = {} }) {
    if (!task?.trim()) throw new Error('task is required');
    return this.#mutate(state => {
      const dependencies = [...new Set(dependsOn)];
      for (const id of dependencies) if (!state.missions.some(m => m.id === id)) throw new Error(`dependency not found: ${id}`);
      const now = this.now();
      const mission = {
        id: randomUUID(), task: task.trim(), priority,
        requiredCapabilities: [...new Set(requiredCapabilities)], dependsOn: dependencies, metadata,
        status: 'queued', attempts: 0, workerId: null, leaseUntil: null,
        leaseEpoch: 0, leaseToken: null,
        createdAt: now, updatedAt: now, result: null, error: null
      };
      state.missions.push(mission);
      return structuredClone(mission);
    });
  }

  async claim(worker) {
    if (!worker?.id) throw new Error('worker id is required');
    return this.#mutate(state => {
      this.#requeueExpiredInState(state);
      const capabilities = new Set(worker.capabilities ?? []);
      const eligible = state.missions
        .filter(m => m.status === 'queued')
        .filter(m => m.requiredCapabilities.every(c => capabilities.has(c)))
        .filter(m => this.#dependenciesCompleted(state, m))
        .sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
      const mission = eligible[0];
      if (!mission) return null;
      const now = this.now();
      mission.status = 'running'; mission.workerId = worker.id; mission.attempts += 1;
      mission.leaseEpoch = (mission.leaseEpoch ?? 0) + 1;
      mission.leaseToken = `${mission.leaseEpoch}:${randomUUID()}`;
      mission.leaseUntil = now + this.leaseMs; mission.updatedAt = now;
      return structuredClone(mission);
    });
  }

  async heartbeat(id, workerId, leaseToken) {
    return this.#mutate(state => {
      const mission = this.#ownedRunning(state, id, workerId, leaseToken);
      const now = this.now();
      mission.leaseUntil = now + this.leaseMs; mission.updatedAt = now;
      return structuredClone(mission);
    });
  }

  async complete(id, workerId, leaseToken, result = null) {
    return this.#mutate(state => {
      const mission = this.#ownedRunning(state, id, workerId, leaseToken);
      mission.status = 'completed'; mission.result = result; mission.leaseUntil = null; mission.updatedAt = this.now();
      mission.workerId = null; mission.leaseToken = null;
      return structuredClone(mission);
    });
  }

  async fail(id, workerId, leaseToken, error) {
    return this.#mutate(state => {
      const mission = this.#ownedRunning(state, id, workerId, leaseToken);
      mission.error = String(error ?? 'unknown failure'); mission.workerId = null; mission.leaseUntil = null; mission.leaseToken = null; mission.updatedAt = this.now();
      mission.status = mission.attempts >= this.maxAttempts ? 'failed' : 'queued';
      return structuredClone(mission);
    });
  }

  async requeueExpired() { return this.#mutate(state => this.#requeueExpiredInState(state)); }

  async get(id) {
    const state = this.#readState();
    const mission = state.missions.find(m => m.id === id);
    return mission ? structuredClone(mission) : null;
  }

  async list({ status } = {}) {
    const state = this.#readState();
    return state.missions.filter(m => !status || m.status === status).map(structuredClone);
  }

  async stats() {
    const state = this.#readState();
    const stats = { total: state.missions.length, queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0, blocked: 0 };
    for (const m of state.missions) {
      stats[m.status] += 1;
      if (m.status === 'queued' && !this.#dependenciesCompleted(state, m)) stats.blocked += 1;
    }
    return stats;
  }

  #readState() {
    const raw = fs.readFileSync(this.filePath, 'utf8');
    const state = JSON.parse(raw);
    if (state?.version !== 1 || !Array.isArray(state.missions)) throw new Error('invalid durable mission store');
    for (const mission of state.missions) {
      if (!Number.isInteger(mission.leaseEpoch) || mission.leaseEpoch < 0) mission.leaseEpoch = 0;
      if (!('leaseToken' in mission)) mission.leaseToken = null;
    }
    return state;
  }

  #writeState(state) {
    const tmp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, this.filePath);
  }

  async #mutate(fn) {
    const release = await this.#acquireLock();
    try {
      const state = this.#readState();
      const result = fn(state);
      this.#writeState(state);
      return result;
    } finally {
      release();
    }
  }

  async #acquireLock() {
    const started = Date.now();
    while (true) {
      try {
        fs.mkdirSync(this.lockPath);
        fs.writeFileSync(path.join(this.lockPath, 'owner.json'), JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }));
        let released = false;
        return () => {
          if (released) return;
          released = true;
          fs.rmSync(this.lockPath, { recursive: true, force: true });
        };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        this.#breakStaleLock();
        if (Date.now() - started >= this.lockTimeoutMs) throw new Error('mission store lock timeout');
        await sleep(this.lockRetryMs);
      }
    }
  }

  #breakStaleLock() {
    try {
      const stat = fs.statSync(this.lockPath);
      if (Date.now() - stat.mtimeMs > this.staleLockMs) fs.rmSync(this.lockPath, { recursive: true, force: true });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  #requeueExpiredInState(state) {
    const now = this.now();
    let changed = 0;
    for (const mission of state.missions) {
      if (mission.status !== 'running' || mission.leaseUntil > now) continue;
      mission.workerId = null; mission.leaseUntil = null; mission.leaseToken = null; mission.updatedAt = now; mission.error = 'worker lease expired';
      mission.status = mission.attempts >= this.maxAttempts ? 'failed' : 'queued';
      changed += 1;
    }
    return changed;
  }

  #dependenciesCompleted(state, mission) {
    return mission.dependsOn.every(id => state.missions.find(m => m.id === id)?.status === 'completed');
  }

  #ownedRunning(state, id, workerId, leaseToken) {
    const mission = state.missions.find(m => m.id === id);
    if (!mission) throw new Error('mission not found');
    if (TERMINAL.has(mission.status)) throw new Error(`mission is ${mission.status}`);
    if (mission.status !== 'running' || mission.workerId !== workerId) throw new Error('mission is not owned by worker');
    if (!leaseToken || mission.leaseToken !== leaseToken) throw new Error('stale or invalid lease token');
    if (mission.leaseUntil <= this.now()) throw new Error('mission lease expired');
    return mission;
  }
}
