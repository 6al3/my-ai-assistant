import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class WorkerCounterState {
  constructor({ filePath, lockTimeoutMs = 5_000, lockRetryMs = 5, staleLockMs = 30_000 } = {}) {
    if (!filePath) throw new Error('filePath is required');
    this.filePath = path.resolve(filePath);
    this.lockPath = `${this.filePath}.lock`;
    this.lockTimeoutMs = lockTimeoutMs;
    this.lockRetryMs = lockRetryMs;
    this.staleLockMs = staleLockMs;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) this.#write({ version: 1, nextCounter: 1 });
  }

  async reserve() {
    const release = await this.#lock();
    try {
      const state = this.#read();
      const counter = state.nextCounter;
      if (!Number.isSafeInteger(counter) || counter < 1 || counter >= Number.MAX_SAFE_INTEGER) throw new Error('worker counter exhausted or invalid');
      state.nextCounter = counter + 1;
      this.#write(state);
      return counter;
    } finally { release(); }
  }

  peek() { return this.#read().nextCounter; }

  #read() {
    const state = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    if (state?.version !== 1 || !Number.isSafeInteger(state.nextCounter) || state.nextCounter < 1) throw new Error('invalid worker counter state');
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
        if (Date.now() - started >= this.lockTimeoutMs) throw new Error('worker counter lock timeout');
        await sleep(this.lockRetryMs);
      }
    }
  }
}

export class PersistentWorkerSigner {
  constructor({ workerId, authenticator, counterState } = {}) {
    if (!workerId || !authenticator || !counterState) throw new Error('workerId, authenticator, and counterState are required');
    this.workerId = String(workerId);
    this.authenticator = authenticator;
    this.counterState = counterState;
  }

  async sign({ action, payload = {}, timestamp, nonce } = {}) {
    if (!action) throw new Error('action is required');
    const counter = await this.counterState.reserve();
    return this.authenticator.sign({ workerId: this.workerId, action, payload, timestamp, nonce, counter });
  }
}
