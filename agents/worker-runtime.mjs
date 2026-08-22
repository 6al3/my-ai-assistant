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
  }

  async claim() {
    return this.coordinator.claim({ id: this.workerSessionId, capabilities: this.capabilities });
  }

  async heartbeat(missionId) {
    return this.coordinator.heartbeat(missionId, this.workerSessionId);
  }

  async complete(missionId, result = null) {
    return this.coordinator.complete(missionId, this.workerSessionId, result);
  }

  async fail(missionId, error) {
    return this.coordinator.fail(missionId, this.workerSessionId, error);
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
      const failed = await this.fail(mission.id, error instanceof Error ? error.message : String(error));
      return { status: failed.status, mission: failed, error };
    }
  }
}
