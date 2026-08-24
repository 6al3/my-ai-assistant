import { performance } from 'node:perf_hooks';
import { MissionCoordinator } from './mission-coordinator.mjs';
import { MissionQueueStore } from './mission-queue-store.mjs';
import { DurableRequestJournal, digestWorkerCommand } from './durable-request-journal.mjs';
import { withFileMutationLock } from './file-mutation-lock.mjs';

const [op, target, value] = process.argv.slice(2);

function timedLockOptions(metrics) {
  return {
    onAcquired: ({ waitMs }) => { metrics.lockWaitMs = waitMs; }
  };
}

async function main() {
  if (op === 'enqueue') {
    const metrics = { lockWaitMs: null };
    const coordinator = await MissionCoordinator.open({
      store: new MissionQueueStore(target, { lockOptions: timedLockOptions(metrics) })
    });
    const started = performance.now();
    const mission = await coordinator.enqueue({ task: `process-${value}`, idempotencyKey: value });
    const durableCommitMs = performance.now() - started;
    process.stdout.write(JSON.stringify({ ok: true, id: mission.id, key: value, lockWaitMs: metrics.lockWaitMs, durableCommitMs }));
    return;
  }
  if (op === 'claim') {
    const metrics = { lockWaitMs: null };
    const coordinator = await MissionCoordinator.open({
      store: new MissionQueueStore(target, { lockOptions: timedLockOptions(metrics) }),
      queueOptions: { requireLeaseToken: true, preserveRunningLeasesOnRestore: true }
    });
    const started = performance.now();
    const mission = await coordinator.claim({ id: value });
    const durableCommitMs = performance.now() - started;
    process.stdout.write(JSON.stringify({ ok: true, id: mission?.id ?? null, workerId: value, lockWaitMs: metrics.lockWaitMs, durableCommitMs }));
    return;
  }
  if (op === 'journal-begin') {
    const metrics = { lockWaitMs: null };
    const journal = await DurableRequestJournal.open(target, { lockOptions: timedLockOptions(metrics) });
    const command = { op: 'synthetic', body: { key: value } };
    const started = performance.now();
    const entry = await journal.begin({ requestId: value, digest: digestWorkerCommand(command) });
    const durableCommitMs = performance.now() - started;
    process.stdout.write(JSON.stringify({ ok: true, requestId: entry.requestId, lockWaitMs: metrics.lockWaitMs, durableCommitMs }));
    return;
  }
  if (op === 'hold-lock') {
    await withFileMutationLock(target, async () => {
      process.stdout.write('LOCKED\n');
      await new Promise(() => {});
    });
    return;
  }
  throw new Error(`unsupported process worker operation: ${op}`);
}

main().catch(error => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
