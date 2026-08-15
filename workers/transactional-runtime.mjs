import { randomUUID } from 'node:crypto';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const MISSION_MUTATIONS = new Set(['claim', 'heartbeat', 'complete', 'fail']);

export class TransactionalWorkerRuntime {
  constructor({ store, authenticator, registry = null, maxAttempts = 3, leaseMs = 30_000, now = () => Date.now() } = {}) {
    if (!store?.mutateRequest || !store?.getRequest) throw new Error('transactional store is required');
    if (!authenticator?.verify) throw new Error('authenticator is required');
    this.store = store;
    this.authenticator = authenticator;
    this.registry = registry;
    this.maxAttempts = maxAttempts;
    this.leaseMs = leaseMs;
    this.now = now;
  }

  async handle(envelope) {
    const request = await this.authenticator.verify(envelope);
    const { workerId, action, payload = {} } = request;

    if (action === 'request-status') {
      if (!payload.requestId) throw new Error('requestId is required');
      return this.store.getRequest(workerId, payload.requestId);
    }

    if (!MISSION_MUTATIONS.has(action)) throw new Error(`unsupported transactional action: ${action}`);
    const requestId = payload.requestId;
    if (!requestId || typeof requestId !== 'string') throw new Error('mutating request requires requestId');

    let capabilities = payload.capabilities ?? [];
    if (this.registry) {
      const worker = await this.registry.get(workerId);
      if (!worker) throw new Error('worker not registered');
      if (worker.status !== 'online') throw new Error('worker is offline');
      capabilities = worker.capabilities ?? [];
      if (action === 'heartbeat') await this.registry.heartbeat(workerId);
    }

    return this.store.mutateRequest({
      workerId,
      requestId,
      action,
      now: this.now(),
      mutation: missions => this.#mutateMission(missions, { workerId, action, payload, capabilities })
    });
  }

  #mutateMission(missions, { workerId, action, payload, capabilities }) {
    if (action === 'claim') {
      this.#requeueExpired(missions);
      const have = new Set(capabilities);
      const eligible = missions
        .filter(m => m.status === 'queued')
        .filter(m => (m.requiredCapabilities ?? []).every(c => have.has(c)))
        .filter(m => (m.dependsOn ?? []).every(id => missions.find(x => x.id === id)?.status === 'completed'))
        .sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
      const mission = eligible[0];
      if (!mission) return null;
      const now = this.now();
      mission.status = 'running';
      mission.workerId = workerId;
      mission.attempts = (mission.attempts ?? 0) + 1;
      mission.leaseEpoch = (mission.leaseEpoch ?? 0) + 1;
      mission.leaseToken = `${mission.leaseEpoch}:${randomUUID()}`;
      mission.leaseUntil = now + this.leaseMs;
      mission.updatedAt = now;
      return structuredClone(mission);
    }

    const mission = missions.find(m => m.id === payload.missionId);
    if (!mission) throw new Error('mission not found');
    this.#assertOwned(mission, workerId, payload.leaseToken);
    const now = this.now();

    if (action === 'heartbeat') {
      mission.leaseUntil = now + this.leaseMs;
      mission.updatedAt = now;
    } else if (action === 'complete') {
      mission.status = 'completed';
      mission.result = payload.result ?? null;
      mission.workerId = null;
      mission.leaseUntil = null;
      mission.leaseToken = null;
      mission.updatedAt = now;
    } else if (action === 'fail') {
      mission.error = String(payload.error ?? 'unknown failure');
      mission.workerId = null;
      mission.leaseUntil = null;
      mission.leaseToken = null;
      mission.updatedAt = now;
      mission.status = (mission.attempts ?? 0) >= this.maxAttempts ? 'failed' : 'queued';
    }
    return structuredClone(mission);
  }

  #assertOwned(mission, workerId, leaseToken) {
    if (TERMINAL.has(mission.status)) throw new Error(`mission is ${mission.status}`);
    if (mission.status !== 'running' || mission.workerId !== workerId) throw new Error('mission is not owned by worker');
    if (!leaseToken || mission.leaseToken !== leaseToken) throw new Error('stale or invalid lease token');
    if (mission.leaseUntil <= this.now()) throw new Error('mission lease expired');
  }

  #requeueExpired(missions) {
    const now = this.now();
    for (const mission of missions) {
      if (mission.status !== 'running' || mission.leaseUntil > now) continue;
      mission.workerId = null;
      mission.leaseUntil = null;
      mission.leaseToken = null;
      mission.updatedAt = now;
      mission.error = 'worker lease expired';
      mission.status = (mission.attempts ?? 0) >= this.maxAttempts ? 'failed' : 'queued';
    }
  }
}
