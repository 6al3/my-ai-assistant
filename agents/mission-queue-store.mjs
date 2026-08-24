import { readFile } from 'node:fs/promises';
import { durableAtomicWrite } from './durable-atomic-write.mjs';

const VERSION = 1;

export class MissionQueueStore {
  constructor(path) {
    if (!path) throw new Error('store path is required');
    this.path = path;
  }

  async load() {
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8'));
      if (raw.version !== VERSION || !Array.isArray(raw.missions)) throw new Error('unsupported mission queue state');
      return raw;
    } catch (error) {
      if (error?.code === 'ENOENT') return { version: VERSION, missions: [] };
      throw error;
    }
  }

  async save(missions) {
    const payload = JSON.stringify({ version: VERSION, savedAt: Date.now(), missions }, null, 2);
    await durableAtomicWrite(this.path, payload);
  }
}
