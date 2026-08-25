import { performance } from 'node:perf_hooks';
import { MissionCoordinator } from './mission-coordinator.mjs';
import { MissionQueueStore } from './mission-queue-store.mjs';
import { DurableRequestJournal, digestWorkerCommand } from './durable-request-journal.mjs';
import { withFileMutationLock } from './file-mutation-lock.mjs';
import { WorkerRuntime } from './worker-runtime.mjs';

const [op, target, value, ...rest] = process.argv.slice(2);

function timedLockOptions(metrics) {
  return {
    onAcquired: ({ waitMs, ownerPublicationMs }) => {
      metrics.lockWaitMs = waitMs;
      metrics.ownerPublicationMs = ownerPublicationMs;
    }
  };
}

function timingMetrics() {
  return { lockWaitMs: null, ownerPublicationMs: null };
}

async function main() {
  if (op === 'enqueue') {
    const metrics = timingMetrics();
    const coordinator = await MissionCoordinator.open({
      store: new MissionQueueStore(target, { lockOptions: timedLockOptions(metrics) })
    });
    const started = performance.now();
    const mission = await coordinator.enqueue({ task: `process-${value}`, idempotencyKey: value });
    const durableCommitMs = performance.now() - started;
    process.stdout.write(JSON.stringify({ ok: true, id: mission.id, key: value, ...metrics, durableCommitMs }));
    return;
  }
  if (op === 'claim') {
    const metrics = timingMetrics();
    const coordinator = await MissionCoordinator.open({
      store: new MissionQueueStore(target, { lockOptions: timedLockOptions(metrics) }),
      queueOptions: { requireLeaseToken: true, preserveRunningLeasesOnRestore: true }
    });
    const started = performance.now();
    const mission = await coordinator.claim({ id: value });
    const durableCommitMs = performance.now() - started;
    process.stdout.write(JSON.stringify({
      ok: true,
      id: mission?.id ?? null,
      workerId: value,
      leaseToken: mission?.leaseToken ?? null,
      ...metrics,
      durableCommitMs
    }));
    return;
  }
  if (op === 'terminal-renewal') {
    const [workerId, leaseToken] = rest;
    if (!value) throw new Error('terminal-renewal mission id is required');
    if (!workerId) throw new Error('terminal-renewal worker id is required');
    if (!leaseToken) throw new Error('terminal-renewal lease token is required');
    const metrics = timingMetrics();
    const coordinator = await MissionCoordinator.open({
      store: new MissionQueueStore(target, { lockOptions: timedLockOptions(metrics) }),
      queueOptions: { requireLeaseToken: true, preserveRunningLeasesOnRestore: true }
    });
    const started = performance.now();
    const mission = await coordinator.heartbeat(value, workerId, leaseToken);
    const durableCommitMs = performance.now() - started;
    process.stdout.write(JSON.stringify({
      ok: true,
      id: mission.id,
      workerId,
      phase: 'terminalRenewal',
      source: 'coordinator-heartbeat-benchmark',
      ...metrics,
      durableCommitMs
    }));
    return;
  }
  if (op === 'worker-run-terminal') {
    const leaseMs = Number(rest[0] ?? 2_000);
    const heartbeatIntervalMs = Number(rest[1] ?? 500);
    const shouldFail = rest[2] === 'fail';
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error('worker-run-terminal leaseMs must be positive');
    if (!Number.isFinite(heartbeatIntervalMs) || heartbeatIntervalMs <= 0 || heartbeatIntervalMs >= leaseMs) {
      throw new Error('worker-run-terminal heartbeatIntervalMs must be positive and less than leaseMs');
    }
    const metrics = timingMetrics();
    let terminalRenewal = null;
    const runtime = await WorkerRuntime.open({
      store: new MissionQueueStore(target, { lockOptions: timedLockOptions(metrics) }),
      workerId: value,
      sessionId: `${value}-terminal-session`,
      queueOptions: { requireLeaseToken: true, preserveRunningLeasesOnRestore: true, leaseMs },
      heartbeatIntervalMs,
      onLeaseTelemetry: event => {
        if (event.phase !== 'terminalRenewal') return;
        terminalRenewal = {
          ok: true,
          id: event.missionId,
          workerId: event.workerId,
          workerSessionId: event.workerSessionId,
          phase: event.phase,
          source: 'worker-runtime',
          lockWaitMs: metrics.lockWaitMs,
          ownerPublicationMs: metrics.ownerPublicationMs,
          durableCommitMs: event.durationMs
        };
      }
    });
    const outcome = await runtime.runOnce(async mission => {
      if (shouldFail) throw new Error(`synthetic terminal failure for ${mission.id}`);
      return { completedBy: value, terminalPath: true };
    });
    if (!terminalRenewal) throw new Error('worker-run-terminal did not emit terminal renewal telemetry');
    process.stdout.write(JSON.stringify({
      ok: true,
      status: outcome.status,
      id: outcome.mission?.id ?? null,
      terminalRenewal
    }));
    return;
  }
  if (op === 'worker-run-long') {
    const durationMs = Number(rest[0]);
    const leaseMs = Number(rest[1]);
    const heartbeatIntervalMs = Number(rest[2]);
    if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error('worker-run-long durationMs must be positive');
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error('worker-run-long leaseMs must be positive');
    if (!Number.isFinite(heartbeatIntervalMs) || heartbeatIntervalMs <= 0 || heartbeatIntervalMs >= leaseMs) {
      throw new Error('worker-run-long heartbeatIntervalMs must be positive and less than leaseMs');
    }
    const runtime = await WorkerRuntime.open({
      store: new MissionQueueStore(target),
      workerId: value,
      sessionId: `${value}-session`,
      queueOptions: { requireLeaseToken: true, preserveRunningLeasesOnRestore: true, leaseMs },
      heartbeatIntervalMs
    });
    const outcome = await runtime.runOnce(async mission => {
      process.stdout.write(`CLAIMED:${mission.id}\n`);
      await new Promise(resolve => setTimeout(resolve, durationMs));
      return { completedBy: value, durationMs };
    });
    process.stdout.write(`RESULT:${JSON.stringify({ ok: true, status: outcome.status, id: outcome.mission?.id ?? null })}\n`);
    return;
  }
  if (op === 'journal-begin') {
    const metrics = timingMetrics();
    const journal = await DurableRequestJournal.open(target, { lockOptions: timedLockOptions(metrics) });
    const command = { op: 'synthetic', body: { key: value } };
    const started = performance.now();
    const entry = await journal.begin({ requestId: value, digest: digestWorkerCommand(command) });
    const durableCommitMs = performance.now() - started;
    process.stdout.write(JSON.stringify({ ok: true, requestId: entry.requestId, status: entry.status, ...metrics, durableCommitMs }));
    return;
  }
  if (op === 'journal-commit') {
    const metrics = timingMetrics();
    const journal = await DurableRequestJournal.open(target, { lockOptions: timedLockOptions(metrics) });
    const started = performance.now();
    const entry = await journal.commit(value, { ok: true, requestId: value });
    const durableCommitMs = performance.now() - started;
    process.stdout.write(JSON.stringify({ ok: true, requestId: entry.requestId, status: entry.status, ...metrics, durableCommitMs }));
    return;
  }
  if (op === 'hold-lock') {
    await withFileMutationLock(target, async () => {
      process.stdout.write('LOCKED\n');
      await new Promise(() => {});
    });
    return;
  }
  if (op === 'hold-ownerless-lock') {
    await withFileMutationLock(target, async () => {
      throw new Error('ownerless fault hook unexpectedly reached lock operation');
    }, {
      onDirectoryCreated: async () => {
        process.stdout.write('OWNERLESS\n');
        await new Promise(() => {});
      }
    });
    return;
  }
  throw new Error(`unsupported process worker operation: ${op}`);
}

main().catch(error => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
