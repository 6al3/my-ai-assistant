import { randomUUID } from 'node:crypto';
import { MissionCoordinator } from './mission-coordinator.mjs';

export class WorkerRuntime {
  static async open({ store, workerId, capabilities = [], queueOptions = {}, sessionId = randomUUID() } = {}) {
    if (!workerId?.trim()) throw new Error('workerId is required');
    const coordinator = await MissionCoordinator.open({ store, queueOptions });
    return new WorkerRuntime({ coordinator, workerId, capabilities, sessionId });
  }

  constructor({ coordinator, workerId, capabilities = [], sessionId }) {
    if (!coordinator) throw new Error('coordinator is required');
    if (!workerId?.trim()) throw new Error('workerId is required');
    if (!sessionId?.trim()) throw new Error('sessionId is required');
    this.coordinator = coordinator;
    this.workerId = workerId.trim();
    this.capabilities = [...new Set(capabilities)];
    this.sessionId = sessionId.trim();
    this.workerSessionId = `${this.workerId}@${this.sessionId}`;
    this.activeLeases = new Map();
  }

  async claim() {
    const mission = await this.coordinator.claim({ id: this.workerSessionId, capabilities: this.capabilities });
    if (mission?.id) {
      if (typeof mission.leaseToken !== 'string' || !mission.leaseToken) {
        throw new Error('claimed mission is missing lease fencing token');
      }
      this.activeLeases.set(mission.id, mission.leaseToken);
    }
    return mission;
  }

  #leaseToken(missionId) {
    const token = this.activeLeases.get(missionId);
    if (typeof token !== 'string' || !token) throw new Error('mission lease token is not held by this worker runtime');
    return token;
  }

  async heartbeat(missionId) {
    return this.coordinator.heartbeat(missionId, this.workerSessionId, this.#leaseToken(missionId));
  }

  async complete(missionId, result = null) {
    const completed = await this.coordinator.complete(missionId, this.workerSessionId, result, this.#leaseToken(missionId));
    this.activeLeases.delete(missionId);
    return completed;
  }

  async fail(missionId, error) {
    const failed = await this.coordinator.fail(missionId, this.workerSessionId, error, this.#leaseToken(missionId));
    this.activeLeases.delete(missionId);
    return failed;
  }

  async runOnce(execute) {
    if (typeof execute !== 'function') throw new Error('execute function is required');
    const mission = await this.claim();
    if (!mission) return { status: 'idle', mission: null };
    try {
      const result = await execute(mission, {
        heartbeat: () => this.heartbeat(mission.id),
        workerId: this.workerId,
        workerSessionId: this.workerSessionId
      });
      const completed = await this.complete(mission.id, result);
      return { status: 'completed', mission: completed };
    } catch (error) {
      try {
        const failed = await this.fail(mission.id, error instanceof Error ? error.message : String(error));
        return { status: failed.status, mission: failed, error };
      } catch (failError) {
        this.activeLeases.delete(mission.id);
        throw new AggregateError([error, failError], 'worker execution failed and mission failure could not be persisted');
      }
    }
  }
}
