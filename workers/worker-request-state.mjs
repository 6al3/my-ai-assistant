import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class WorkerRequestState {
  constructor({ filePath, lockTimeoutMs = 5_000, lockRetryMs = 5, staleLockMs = 30_000, now = () => Date.now() } = {}) {
    if (!filePath) throw new Error('filePath is required');
    this.filePath = path.resolve(filePath);
    this.lockPath = `${this.filePath}.lock`;
    this.lockTimeoutMs = lockTimeoutMs;
    this.lockRetryMs = lockRetryMs;
    this.staleLockMs = staleLockMs;
    this.now = now;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) this.#write({ version: 1, pending: {} });
  }

  async reserve({ action, payload = {}, requestId = randomUUID() } = {}) {
    if (!action) throw new Error('action is required');
    if (!requestId || typeof requestId !== 'string') throw new Error('requestId must be a non-empty string');
    const release = await this.#lock();
    try {
      const state = this.#read();
      if (state.pending[requestId]) throw new Error('requestId already pending');
      const record = { requestId, action, payload: structuredClone(payload), createdAt: this.now(), updatedAt: this.now() };
      state.pending[requestId] = record;
      this.#write(state);
      return structuredClone(record);
    } finally { release(); }
  }

  get(requestId) {
    const record = this.#read().pending[requestId];
    return record ? structuredClone(record) : null;
  }

  listPending() {
    return Object.values(this.#read().pending).map(structuredClone);
  }

  async clear(requestId) {
    const release = await this.#lock();
    try {
      const state = this.#read();
      if (!state.pending[requestId]) return false;
      delete state.pending[requestId];
      this.#write(state);
      return true;
    } finally { release(); }
  }

  #read() {
    const state = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    if (state?.version !== 1 || !state.pending || typeof state.pending !== 'object' || Array.isArray(state.pending)) throw new Error('invalid worker request state');
    return state;
  }

  #write(state) {
    const tmp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
    try { fs.chmodSync(this.filePath, 0o600); } catch {}
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
        try {
          const stat = fs.statSync(this.lockPath);
          if (Date.now() - stat.mtimeMs > this.staleLockMs) fs.rmSync(this.lockPath, { recursive: true, force: true });
        } catch (statError) { if (statError.code !== 'ENOENT') throw statError; }
        if (Date.now() - started >= this.lockTimeoutMs) throw new Error('worker request state lock timeout');
        await sleep(this.lockRetryMs);
      }
    }
  }
}
