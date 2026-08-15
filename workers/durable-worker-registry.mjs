import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class DurableWorkerRegistry {
  constructor({ filePath, ttlMs = 30_000, lockTimeoutMs = 5_000, lockRetryMs = 5, staleLockMs = 30_000, now = () => Date.now() } = {}) {
    if (!filePath) throw new Error('filePath is required');
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('ttlMs must be > 0');
    this.filePath = path.resolve(filePath);
    this.lockPath = `${this.filePath}.lock`;
    this.ttlMs = ttlMs;
    this.lockTimeoutMs = lockTimeoutMs;
    this.lockRetryMs = lockRetryMs;
    this.staleLockMs = staleLockMs;
    this.now = now;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) this.#write({ version: 1, workers: {} });
  }

  async register({ id, capabilities = [], maxConcurrent = 1, metadata = {} }) {
    if (!id) throw new Error('worker id is required');
    if (!Array.isArray(capabilities)) throw new Error('capabilities must be an array');
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) throw new Error('maxConcurrent must be >= 1');
    return this.#mutate(state => {
      const now = this.now();
      const previous = state.workers[String(id)];
      const worker = {
        id: String(id), capabilities: [...new Set(capabilities.map(String))], maxConcurrent,
        metadata: structuredClone(metadata), status: 'online', registeredAt: previous?.registeredAt ?? now,
        updatedAt: now, expiresAt: now + this.ttlMs, lastCounter: previous?.lastCounter ?? 0,
        credentialGeneration: previous?.credentialGeneration ?? 1
      };
      state.workers[worker.id] = worker;
      return structuredClone(worker);
    });
  }

  async heartbeat(id) {
    return this.#mutate(state => {
      const worker = state.workers[String(id)];
      if (!worker) throw new Error('worker not registered');
      const now = this.now();
      worker.status = 'online'; worker.updatedAt = now; worker.expiresAt = now + this.ttlMs;
      return structuredClone(worker);
    });
  }

  async acceptCounter(id, counter) {
    if (!Number.isSafeInteger(counter) || counter < 1) throw new Error('worker counter must be a positive safe integer');
    return this.#mutate(state => {
      const worker = state.workers[String(id)];
      if (!worker) throw new Error('worker not registered');
      if (counter <= worker.lastCounter) throw new Error('worker request replay or counter regression detected');
      worker.lastCounter = counter;
      worker.updatedAt = this.now();
      return counter;
    });
  }

  async rotateCredential(id) {
    return this.#mutate(state => {
      const worker = state.workers[String(id)];
      if (!worker) throw new Error('worker not registered');
      const now = this.now();
      worker.credentialGeneration = (worker.credentialGeneration ?? 1) + 1;
      worker.lastCounter = 0;
      worker.status = 'online';
      worker.updatedAt = now;
      worker.expiresAt = now + this.ttlMs;
      return { id: worker.id, credentialGeneration: worker.credentialGeneration, lastCounter: 0, status: worker.status };
    });
  }

  async get(id) {
    const state = this.#read();
    const worker = state.workers[String(id)];
    if (!worker) return null;
    const copy = structuredClone(worker);
    if (copy.status === 'online' && copy.expiresAt <= this.now()) copy.status = 'offline';
    return copy;
  }

  async list() {
    const state = this.#read();
    return Promise.all(Object.keys(state.workers).sort().map(id => this.get(id)));
  }

  #read() {
    const state = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    if (state?.version !== 1 || !state.workers || typeof state.workers !== 'object') throw new Error('invalid durable worker registry');
    return state;
  }

  #write(state) {
    const tmp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, this.filePath);
  }

  async #mutate(fn) {
    const release = await this.#lock();
    try {
      const state = this.#read();
      const result = fn(state);
      this.#write(state);
      return result;
    } finally { release(); }
  }

  async #lock() {
    const started = Date.now();
    while (true) {
      try {
        fs.mkdirSync(this.lockPath);
        fs.writeFileSync(path.join(this.lockPath, 'owner.json'), JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }));
        let released = false;
        return () => { if (!released) { released = true; fs.rmSync(this.lockPath, { recursive: true, force: true }); } };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        try {
          const stat = fs.statSync(this.lockPath);
          if (Date.now() - stat.mtimeMs > this.staleLockMs) fs.rmSync(this.lockPath, { recursive: true, force: true });
        } catch (statError) { if (statError.code !== 'ENOENT') throw statError; }
        if (Date.now() - started >= this.lockTimeoutMs) throw new Error('worker registry lock timeout');
        await sleep(this.lockRetryMs);
      }
    }
  }
}
