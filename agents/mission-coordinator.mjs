import { MissionQueue } from './mission-queue.mjs';

export class MissionCoordinator {
  static async open({ store, queueOptions = {} } = {}) {
    if (!store?.load || !store?.save) throw new Error('store with load/save is required');
    const snapshot = await store.load();
    return new MissionCoordinator({ store, queue: new MissionQueue({ ...queueOptions, snapshot }) });
  }

  constructor({ store, queue }) {
    if (!store?.save) throw new Error('store with save is required');
    if (!queue) throw new Error('queue is required');
    this.store = store;
    this.queue = queue;
    this.persistenceError = null;
    this.tail = Promise.resolve();
  }

  get healthy() { return this.persistenceError === null; }

  async enqueue(input) { return this.#mutate(() => this.queue.enqueue(input)); }
  async claim(worker) { return this.#mutate(() => this.queue.claim(worker)); }
  async heartbeat(id, workerId) { return this.#mutate(() => this.queue.heartbeat(id, workerId)); }
  async complete(id, workerId, result = null) { return this.#mutate(() => this.queue.complete(id, workerId, result)); }
  async fail(id, workerId, error) { return this.#mutate(() => this.queue.fail(id, workerId, error)); }
  async cancel(id, reason = 'cancelled') { return this.#mutate(() => this.queue.cancel(id, reason)); }
  async requeueExpired() { return this.#mutate(() => { this.queue.requeueExpired(); return this.queue.stats(); }); }

  get(id) { return this.queue.get(id); }
  list(options = {}) { return this.queue.list(options); }
  stats() { return this.queue.stats(); }
  snapshot() { return this.queue.snapshot(); }

  async flush() {
    await this.tail;
    this.#assertHealthy();
    return this.store.save(this.queue.snapshot().missions);
  }

  async #mutate(operation) {
    const run = this.tail.then(async () => {
      this.#assertHealthy();
      const result = operation();
      try {
        await this.store.save(this.queue.snapshot().missions);
      } catch (error) {
        this.persistenceError = error instanceof Error ? error : new Error(String(error));
        throw new Error(`mission persistence failed: ${this.persistenceError.message}`, { cause: this.persistenceError });
      }
      return result;
    });
    this.tail = run.catch(() => {});
    return run;
  }

  #assertHealthy() {
    if (this.persistenceError) {
      throw new Error(`mission coordinator is fail-closed after persistence error: ${this.persistenceError.message}`, { cause: this.persistenceError });
    }
  }
}
