import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { MissionCoordinator } from './mission-coordinator.mjs';

const SUPPORTED_EXECUTION_MODE = 'cooperative';

function validateExecutionMode(executionMode) {
  if (executionMode !== SUPPORTED_EXECUTION_MODE) {
    throw new Error(`executionMode must be ${SUPPORTED_EXECUTION_MODE}`);
  }
  return executionMode;
}

function validateLeaseTelemetry(onLeaseTelemetry) {
  if (onLeaseTelemetry != null && typeof onLeaseTelemetry !== 'function') {
    throw new Error('onLeaseTelemetry must be a function');
  }
  return onLeaseTelemetry ?? null;
}

export class WorkerRuntime {
  static async open({ store, workerId, capabilities = [], queueOptions = {}, sessionId = randomUUID(), heartbeatIntervalMs = null, executionMode = SUPPORTED_EXECUTION_MODE, onLeaseTelemetry = null } = {}) {
    if (!workerId?.trim()) throw new Error('workerId is required');
    validateExecutionMode(executionMode);
    validateLeaseTelemetry(onLeaseTelemetry);
    const leaseMs = Number.isFinite(queueOptions.leaseMs) && queueOptions.leaseMs > 0 ? queueOptions.leaseMs : 30_000;
    const resolvedHeartbeatIntervalMs = heartbeatIntervalMs ?? Math.max(10, Math.floor(leaseMs / 3));
    if (!Number.isFinite(resolvedHeartbeatIntervalMs) || resolvedHeartbeatIntervalMs <= 0 || resolvedHeartbeatIntervalMs >= leaseMs) {
      throw new Error('heartbeatIntervalMs must be positive and less than leaseMs');
    }
    const coordinator = await MissionCoordinator.open({ store, queueOptions });
    return new WorkerRuntime({ coordinator, workerId, capabilities, sessionId, heartbeatIntervalMs: resolvedHeartbeatIntervalMs, executionMode, onLeaseTelemetry });
  }

  constructor({ coordinator, workerId, capabilities = [], sessionId, heartbeatIntervalMs = 10_000, executionMode = SUPPORTED_EXECUTION_MODE, onLeaseTelemetry = null }) {
    if (!coordinator) throw new Error('coordinator is required');
    if (!workerId?.trim()) throw new Error('workerId is required');
    if (!sessionId?.trim()) throw new Error('sessionId is required');
    if (!Number.isFinite(heartbeatIntervalMs) || heartbeatIntervalMs <= 0) throw new Error('heartbeatIntervalMs must be positive');
    validateExecutionMode(executionMode);
    validateLeaseTelemetry(onLeaseTelemetry);
    this.coordinator = coordinator;
    this.workerId = workerId.trim();
    this.capabilities = [...new Set(capabilities)];
    this.sessionId = sessionId.trim();
    this.workerSessionId = `${this.workerId}@${this.sessionId}`;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.executionMode = executionMode;
    this.onLeaseTelemetry = onLeaseTelemetry;
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

  async #renewLease(missionId, phase) {
    const started = performance.now();
    const mission = await this.heartbeat(missionId);
    const durationMs = performance.now() - started;
    if (this.onLeaseTelemetry) {
      await this.onLeaseTelemetry({
        phase,
        missionId,
        workerId: this.workerId,
        workerSessionId: this.workerSessionId,
        durationMs
      });
    }
    return mission;
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
        inFlight = this.#renewLease(missionId, 'periodicHeartbeat')
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
    let terminalLeaseRefreshed = false;
    try {
      const result = await execute(mission, {
        heartbeat: () => this.heartbeat(mission.id),
        workerId: this.workerId,
        workerSessionId: this.workerSessionId,
        executionMode: this.executionMode
      });
      await automaticHeartbeat.stop();
      automaticHeartbeat.assertHealthy();
      await this.#renewLease(mission.id, 'terminalRenewal');
      terminalLeaseRefreshed = true;
      const completed = await this.complete(mission.id, result);
      return { status: 'completed', mission: completed };
    } catch (error) {
      await automaticHeartbeat.stop();
      let heartbeatHealthy = true;
      let heartbeatAwareError = (() => {
        try {
          automaticHeartbeat.assertHealthy();
          return error;
        } catch (heartbeatError) {
          heartbeatHealthy = false;
          return heartbeatError === error
            ? error
            : new AggregateError([error, heartbeatError], 'worker execution and automatic heartbeat both failed');
        }
      })();
      if (heartbeatHealthy && !terminalLeaseRefreshed) {
        try {
          await this.#renewLease(mission.id, 'terminalRenewal');
          terminalLeaseRefreshed = true;
        } catch (terminalHeartbeatError) {
          heartbeatAwareError = new AggregateError(
            [heartbeatAwareError, terminalHeartbeatError],
            'worker execution failed and terminal lease renewal failed'
          );
        }
      }
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
