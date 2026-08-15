import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class TransactionalMissionStore {
  constructor({ filePath, lockTimeoutMs = 5_000, lockRetryMs = 5, staleLockMs = 30_000 } = {}) {
    if (!filePath) throw new Error('filePath is required');
    this.filePath = path.resolve(filePath);
    this.lockPath = `${this.filePath}.lock`;
    this.lockTimeoutMs = lockTimeoutMs;
    this.lockRetryMs = lockRetryMs;
    this.staleLockMs = staleLockMs;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) this.#write({ version: 1, missions: [], requests: {} });
  }

  read() {
    return structuredClone(this.#read());
  }

  async transaction(fn, { beforeCommit } = {}) {
    if (typeof fn !== 'function') throw new Error('transaction callback is required');
    const release = await this.#lock();
    try {
      const state = this.#read();
      const working = structuredClone(state);
      const result = await fn(working);
      this.#validate(working);
      if (beforeCommit) await beforeCommit(structuredClone(working));
      this.#write(working);
      return result;
    } finally {
      release();
    }
  }

  async mutateRequest({ workerId, requestId, action, mutation, now = Date.now() }) {
    if (!workerId || !requestId || !action) throw new Error('workerId, requestId, and action are required');
    if (typeof mutation !== 'function') throw new Error('mutation callback is required');

    const outcome = await this.transaction(async state => {
      const key = `${workerId}:${requestId}`;
      const existing = state.requests[key];
      if (existing) {
        if (existing.action !== action) return { ok: false, error: 'requestId reused for a different action' };
        if (existing.status === 'completed') return { ok: true, result: structuredClone(existing.result) };
        if (existing.status === 'failed') return { ok: false, error: `previous request failed: ${existing.error}` };
        return { ok: false, error: 'request outcome is ambiguous' };
      }

      const record = {
        workerId,
        requestId,
        action,
        status: 'in-progress',
        result: null,
        error: null,
        createdAt: now,
        updatedAt: now
      };
      state.requests[key] = record;

      try {
        const result = await mutation(state.missions, state);
        record.status = 'completed';
        record.result = result ?? null;
        record.updatedAt = now;
        return { ok: true, result: structuredClone(result ?? null) };
      } catch (error) {
        record.status = 'failed';
        record.error = String(error?.message ?? error ?? 'unknown failure');
        record.updatedAt = now;
        return { ok: false, error: record.error };
      }
    });

    if (!outcome.ok) throw new Error(outcome.error);
    return outcome.result;
  }

  getRequest(workerId, requestId) {
    const record = this.#read().requests[`${workerId}:${requestId}`];
    return record ? structuredClone(record) : null;
  }

  #validate(state) {
    if (state?.version !== 1) throw new Error('invalid transactional store version');
    if (!Array.isArray(state.missions)) throw new Error('invalid transactional missions');
    if (!state.requests || typeof state.requests !== 'object' || Array.isArray(state.requests)) throw new Error('invalid transactional requests');
  }

  #read() {
    const state = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    this.#validate(state);
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
        fs.writeFileSync(path.join(this.lockPath, 'owner.json'), JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }), { mode: 0o600 });
        let released = false;
        return () => {
          if (released) return;
          released = true;
          fs.rmSync(this.lockPath, { recursive: true, force: true });
        };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        this.#breakStaleLock();
        if (Date.now() - started >= this.lockTimeoutMs) throw new Error('transactional store lock timeout');
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
}
