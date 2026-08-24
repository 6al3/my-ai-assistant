import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { durableAtomicWrite } from './durable-atomic-write.mjs';
import { withFileMutationLock } from './file-mutation-lock.mjs';

const VERSION = 1;

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function digestWorkerCommand({ op, body = null } = {}) {
  if (!op?.trim()) throw new Error('journal command op is required');
  return createHash('sha256').update(canonical([op.trim(), body])).digest('hex');
}

export class DurableRequestJournal {
  static async open(path, { lockOptions = {}, writer = durableAtomicWrite } = {}) {
    if (!path) throw new Error('journal path is required');
    const journal = new DurableRequestJournal(path, { lockOptions, writer });
    await journal.#loadExact();
    return journal;
  }

  constructor(path, { lockOptions = {}, writer = durableAtomicWrite } = {}) {
    if (typeof writer !== 'function') throw new Error('journal writer must be a function');
    this.path = path;
    this.lockPath = `${path}.lock`;
    this.lockOptions = lockOptions;
    this.writer = writer;
    this.entries = new Map();
    this.tail = Promise.resolve();
  }

  get(requestId) {
    const entry = this.entries.get(requestId);
    return entry ? structuredClone(entry) : null;
  }

  async begin({ requestId, digest }) {
    if (!requestId?.trim()) throw new Error('journal requestId is required');
    if (!/^[0-9a-f]{64}$/i.test(digest ?? '')) throw new Error('journal digest is invalid');
    return this.#mutate(async () => {
      const existing = this.entries.get(requestId);
      if (existing) {
        if (existing.digest !== digest) throw new Error('requestId reused with different command');
        return structuredClone(existing);
      }

      const before = this.#snapshotEntries();
      const entry = { requestId, digest, status: 'pending', response: null, createdAt: Date.now(), committedAt: null };
      this.entries.set(requestId, entry);
      await this.#saveOrRollback(before);
      return structuredClone(entry);
    });
  }

  async commit(requestId, response) {
    return this.#mutate(async () => {
      const entry = this.entries.get(requestId);
      if (!entry) throw new Error('journal request not found');
      if (entry.status === 'committed') return structuredClone(entry);

      const before = this.#snapshotEntries();
      entry.status = 'committed';
      entry.response = structuredClone(response);
      entry.committedAt = Date.now();
      await this.#saveOrRollback(before);
      return structuredClone(entry);
    });
  }

  async #loadExact() {
    const loaded = new Map();
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8'));
      if (raw.version !== VERSION || !Array.isArray(raw.entries)) throw new Error('unsupported request journal state');
      for (const entry of raw.entries) {
        if (!entry?.requestId || !entry?.digest || !['pending', 'committed'].includes(entry.status)) throw new Error('invalid request journal state');
        if (loaded.has(entry.requestId)) throw new Error('duplicate request journal entry');
        loaded.set(entry.requestId, structuredClone(entry));
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    this.entries = loaded;
  }

  #snapshotEntries() {
    return new Map([...this.entries].map(([requestId, entry]) => [requestId, structuredClone(entry)]));
  }

  #restoreEntries(snapshot) {
    this.entries = new Map([...snapshot].map(([requestId, entry]) => [requestId, structuredClone(entry)]));
  }

  async #saveOrRollback(snapshot) {
    try {
      await this.#save();
    } catch (error) {
      this.#restoreEntries(snapshot);
      throw error;
    }
  }

  async #save() {
    const payload = JSON.stringify({ version: VERSION, savedAt: Date.now(), entries: [...this.entries.values()] }, null, 2);
    await this.writer(this.path, payload);
  }

  #mutate(operation) {
    const run = this.tail.then(() => withFileMutationLock(this.lockPath, async () => {
      await this.#loadExact();
      return operation();
    }, this.lockOptions));
    this.tail = run.catch(() => {});
    return run;
  }
}
