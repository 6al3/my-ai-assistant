export class WorkerRegistry {
  constructor({ ttlMs = 30_000, now = () => Date.now() } = {}) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('ttlMs must be > 0');
    this.ttlMs = ttlMs;
    this.now = now;
    this.workers = new Map();
  }

  register({ id, capabilities = [], maxConcurrent = 1, metadata = {} }) {
    if (!id) throw new Error('worker id is required');
    if (!Array.isArray(capabilities)) throw new Error('capabilities must be an array');
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) throw new Error('maxConcurrent must be >= 1');
    const timestamp = this.now();
    const worker = {
      id: String(id),
      capabilities: [...new Set(capabilities.map(String))],
      maxConcurrent,
      activeJobs: 0,
      metadata,
      status: 'online',
      registeredAt: timestamp,
      updatedAt: timestamp,
      expiresAt: timestamp + this.ttlMs
    };
    this.workers.set(worker.id, worker);
    return structuredClone(worker);
  }

  heartbeat(id, patch = {}) {
    const worker = this.workers.get(String(id));
    if (!worker) throw new Error('worker not found');
    if (Array.isArray(patch.capabilities)) worker.capabilities = [...new Set(patch.capabilities.map(String))];
    if (patch.maxConcurrent !== undefined) {
      if (!Number.isInteger(patch.maxConcurrent) || patch.maxConcurrent < 1) throw new Error('maxConcurrent must be >= 1');
      worker.maxConcurrent = patch.maxConcurrent;
    }
    const timestamp = this.now();
    worker.status = 'online';
    worker.updatedAt = timestamp;
    worker.expiresAt = timestamp + this.ttlMs;
    return structuredClone(worker);
  }

  reserve(requiredCapabilities = []) {
    this.reapExpired();
    const required = [...new Set(requiredCapabilities.map(String))];
    const candidates = [...this.workers.values()]
      .filter(w => w.status === 'online')
      .filter(w => w.activeJobs < w.maxConcurrent)
      .filter(w => required.every(cap => w.capabilities.includes(cap)))
      .sort((a, b) => (a.activeJobs / a.maxConcurrent) - (b.activeJobs / b.maxConcurrent) || a.id.localeCompare(b.id));
    const worker = candidates[0];
    if (!worker) return null;
    worker.activeJobs += 1;
    worker.updatedAt = this.now();
    return structuredClone(worker);
  }

  release(id) {
    const worker = this.workers.get(String(id));
    if (!worker) return null;
    worker.activeJobs = Math.max(0, worker.activeJobs - 1);
    worker.updatedAt = this.now();
    return structuredClone(worker);
  }

  reapExpired() {
    const now = this.now();
    let count = 0;
    for (const worker of this.workers.values()) {
      if (worker.status === 'online' && worker.expiresAt <= now) {
        worker.status = 'offline';
        worker.activeJobs = 0;
        worker.updatedAt = now;
        count += 1;
      }
    }
    return count;
  }

  get(id) {
    this.reapExpired();
    const worker = this.workers.get(String(id));
    return worker ? structuredClone(worker) : null;
  }

  list({ includeOffline = true } = {}) {
    this.reapExpired();
    return [...this.workers.values()]
      .filter(w => includeOffline || w.status === 'online')
      .map(w => structuredClone(w));
  }

  stats() {
    this.reapExpired();
    const workers = [...this.workers.values()];
    return {
      total: workers.length,
      online: workers.filter(w => w.status === 'online').length,
      offline: workers.filter(w => w.status === 'offline').length,
      activeJobs: workers.reduce((sum, w) => sum + w.activeJobs, 0),
      capacity: workers.filter(w => w.status === 'online').reduce((sum, w) => sum + w.maxConcurrent, 0)
    };
  }
}
