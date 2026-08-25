import { randomUUID } from 'node:crypto';
import { MissionCoordinator } from './mission-coordinator.mjs';

export class WorkerRuntime {
  static async open({ store, workerId, capabilities = [], queueOptions = {}, sessionId = randomUUID(), heartbeatIntervalMs = null } = {}) {
    if (!workerId?.trim()) throw new Error('workerId is required');
    const coordinator = await MissionCoordinator.open({ store, queueOptions });
    const leaseMs = Number.isFinite(queueOptions.leaseMs) && queueOptions.leaseMs > 0 ? queueOptions.leaseMs : 30_000;
    const resolvedHeartbeatIntervalMs = heartbeatIntervalMs ?? Math.max(10, Math.floor(leaseMs / 3));
    return new WorkerRuntime({ coordinator, workerId, capabilities, sessionId, heartbeatIntervalMs: resolvedHeartbeatIntervalMs });
  }

  constructor({ coordinator, workerId, capabilities = [], sessionId, heartbeatIntervalMs = 10_000 }) {
    if (!coordinator) throw new Error('coordinator is required');
    if (!workerId?.trim()) throw new Error('workerId is required');
    if (!sessionId?.trim()) throw new Error('sessionId is required');
    if (!Number.isFinite(heartbeatIntervalMs) || heartbeatIntervalMs <= 0) throw new Error('heartbeatIntervalMs must be positive');
    this.coordinator = coordinator;
    this.workerId = workerId.trim();
    this.capabilities = [...new Set(capabilities)];
    this.sessionId = sessionId.trim();
    this.workerSessionId = `${this.workerId}@${this.sessionId}`;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
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

  #startAutomaticHeartbeat(missionId) {
    let stopped = false;
    let timer = null;
    let inFlight = Promise.resolve();
    let heartbeatError = null;

    const schedule = () => {
      if (stopped || heartbeatError) return;
      timer = setTimeout(() => {
        if (stopped || heartbeatError) return;
        inFlight = this.heartbeat(missionId)
          .catch(error => {
            heartbeatError = error instanceof Error ? error : new Error(String(error));
          })
          .finally(() => {
            if (!stopped && !heartbeatError) schedule();
          });
      }, this.heartbeatIntervalMs);
      timer.unref?.();
    };

    schedule();

    return {
      stop: async () => {
        stopped = true;
        if (timer) clearTimeout(timer);
        await inFlight;
      },
      assertHealthy: () => {
        if (heartbeatError) throw new Error(`automatic mission heartbeat failed: ${heartbeatError.message}`, { cause: heartbeatError });
      }
    };
  }

  async runOnce(execute) {
    if (typeof execute !== 'function') throw new Error('execute function is required');
    const mission = await this.claim();
    if (!mission) return { status: 'idle', mission: null };
    const automaticHeartbeat = this.#startAutomaticHeartbeat(mission.id);
    try {
      const result = await execute(mission, {
        heartbeat: () => this.heartbeat(mission.id),
        workerId: this.workerId,
        workerSessionId: this.workerSessionId
      });
      await automaticHeartbeat.stop();
      automaticHeartbeat.assertHealthy();
      const completed = await this.complete(mission.id, result);
      return { status: 'completed', mission: completed };
    } catch (error) {
      await automaticHeartbeat.stop();
      const heartbeatAwareError = (() => {
        try {
          automaticHeartbeat.assertHealthy();
          return error;
        } catch (heartbeatError) {
          return heartbeatError === error
            ? error
            : new AggregateError([error, heartbeatError], 'worker execution and automatic heartbeat both failed');
        }
      })();
      try {
        const failed = await this.fail(mission.id, heartbeatAwareError instanceof Error ? heartbeatAwareError.message : String(heartbeatAwareError));
        return { status: failed.status, mission: failed, error: heartbeatAwareError };
      } catch (failError) {
        this.activeLeases.delete(mission.id);
        throw new AggregateError([heartbeatAwareError, failError], 'worker execution failed and mission failure could not be persisted');
      }
    }
  }
}