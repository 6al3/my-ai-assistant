import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const MUTATING = new Set(['claim', 'heartbeat', 'complete', 'fail', 'register']);

export class DurableRequestJournal {
  constructor({ filePath, lockTimeoutMs = 5_000, lockRetryMs = 5, staleLockMs = 30_000, now = () => Date.now() } = {}) {
    if (!filePath) throw new Error('filePath is required');
    this.filePath = path.resolve(filePath);
    this.lockPath = `${this.filePath}.lock`;
    this.lockTimeoutMs = lockTimeoutMs;
    this.lockRetryMs = lockRetryMs;
    this.staleLockMs = staleLockMs;
    this.now = now;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) this.#write({ version: 1, requests: {} });
  }

  async begin({ workerId, requestId, action }) {
    if (!workerId || !requestId || !action) throw new Error('workerId, requestId, and action are required');
    return this.#mutate(state => {
      const key = `${workerId}:${requestId}`;
      const existing = state.requests[key];
      if (existing) {
        if (existing.action !== action) throw new Error('requestId reused for a different action');
        return { existing: true, record: structuredClone(existing) };
      }
      const record = { workerId, requestId, action, status: 'in-progress', result: null, error: null, createdAt: this.now(), updatedAt: this.now() };
      state.requests[key] = record;
      return { existing: false, record: structuredClone(record) };
    });
  }

  async finish({ workerId, requestId, result }) {
    return this.#mutate(state => {
      const record = state.requests[`${workerId}:${requestId}`];
      if (!record) throw new Error('request journal entry not found');
      record.status = 'completed'; record.result = result ?? null; record.error = null; record.updatedAt = this.now();
      return structuredClone(record);
    });
  }

  async fail({ workerId, requestId, error }) {
    return this.#mutate(state => {
      const record = state.requests[`${workerId}:${requestId}`];
      if (!record) throw new Error('request journal entry not found');
      record.status = 'failed'; record.error = String(error ?? 'unknown failure'); record.updatedAt = this.now();
      return structuredClone(record);
    });
  }

  async get(workerId, requestId) {
    const record = this.#read().requests[`${workerId}:${requestId}`];
    return record ? structuredClone(record) : null;
  }

  #read() {
    const state = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    if (state?.version !== 1 || !state.requests || typeof state.requests !== 'object') throw new Error('invalid request journal');
    return state;
  }

  #write(state) {
    const tmp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
    try { fs.chmodSync(this.filePath, 0o600); } catch {}
  }

  async #mutate(fn) {
    const release = await this.#lock();
    try { const state = this.#read(); const out = fn(state); this.#write(state); return out; }
    finally { release(); }
  }

  async #lock() {
    const started = Date.now();
    while (true) {
      try {
        fs.mkdirSync(this.lockPath, { mode: 0o700 });
        let released = false;
        return () => { if (!released) { released = true; fs.rmSync(this.lockPath, { recursive: true, force: true }); } };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        try { const stat = fs.statSync(this.lockPath); if (Date.now() - stat.mtimeMs > this.staleLockMs) fs.rmSync(this.lockPath, { recursive: true, force: true }); }
        catch (statError) { if (statError.code !== 'ENOENT') throw statError; }
        if (Date.now() - started >= this.lockTimeoutMs) throw new Error('request journal lock timeout');
        await sleep(this.lockRetryMs);
      }
    }
  }
}

export class JournaledCoordinator {
  constructor({ coordinator, authenticator, journal } = {}) {
    if (!coordinator?.handleVerified || !authenticator?.verify || !journal) throw new Error('coordinator, authenticator, and journal are required');
    this.coordinator = coordinator;
    this.authenticator = authenticator;
    this.journal = journal;
  }

  async handle(envelope) {
    const request = await this.authenticator.verify(envelope);
    const { workerId, action, payload = {} } = request;
    if (action === 'request-status') {
      if (!payload.requestId) throw new Error('requestId is required');
      return this.journal.get(workerId, payload.requestId);
    }
    if (!MUTATING.has(action)) return this.coordinator.handleVerified(request);
    const requestId = payload.requestId;
    if (!requestId || typeof requestId !== 'string') throw new Error('mutating request requires requestId');
    const begun = await this.journal.begin({ workerId, requestId, action });
    if (begun.existing) {
      if (begun.record.status === 'completed') return begun.record.result;
      if (begun.record.status === 'failed') throw new Error(`previous request failed: ${begun.record.error}`);
      throw new Error('request outcome still in progress or ambiguous');
    }
    try {
      const result = await this.coordinator.handleVerified(request);
      await this.journal.finish({ workerId, requestId, result });
      return result;
    } catch (error) {
      await this.journal.fail({ workerId, requestId, error });
      throw error;
    }
  }
}
