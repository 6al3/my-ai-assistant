export class Dispatcher {
  constructor({ queue, registry }) {
    if (!queue || !registry) throw new Error('queue and registry are required');
    this.queue = queue;
    this.registry = registry;
  }

  dispatchNext() {
    this.queue.requeueExpired();
    this.registry.reapExpired();

    for (const worker of this.registry.available()) {
      const mission = this.queue.claim({ id: worker.id, capabilities: worker.capabilities });
      if (!mission) continue;
      const reserved = this.registry.acquire(worker.id);
      if (!reserved) {
        this.queue.fail(mission.id, worker.id, 'worker capacity race');
        continue;
      }
      return { status: 'dispatched', worker: reserved, mission };
    }

    return { status: 'idle' };
  }

  heartbeat({ missionId, workerId, workerPatch = {} }) {
    const worker = this.registry.heartbeat(workerId, workerPatch);
    const mission = this.queue.heartbeat(missionId, workerId);
    return { worker, mission };
  }

  complete({ missionId, workerId, result = null }) {
    try {
      return this.queue.complete(missionId, workerId, result);
    } finally {
      this.registry.release(workerId);
    }
  }

  fail({ missionId, workerId, error }) {
    try {
      return this.queue.fail(missionId, workerId, error);
    } finally {
      this.registry.release(workerId);
    }
  }

  recover() {
    const expiredMissions = this.queue.requeueExpired();
    const expiredWorkers = this.registry.reapExpired();
    return { expiredMissions, expiredWorkers };
  }

  stats() {
    return { missions: this.queue.stats(), workers: this.registry.stats() };
  }
}
