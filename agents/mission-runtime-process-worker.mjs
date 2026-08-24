import { MissionCoordinator } from './mission-coordinator.mjs';
import { MissionQueueStore } from './mission-queue-store.mjs';
import { DurableRequestJournal } from './durable-request-journal.mjs';
import { withFileMutationLock } from './file-mutation-lock.mjs';

const [op, target, value] = process.argv.slice(2);

async function main() {
  if (op === 'enqueue') {
    const coordinator = await MissionCoordinator.open({ store: new MissionQueueStore(target) });
    const mission = await coordinator.enqueue({ task: `process-${value}`, idempotencyKey: value });
    process.stdout.write(JSON.stringify({ ok: true, id: mission.id, key: value }));
    return;
  }
  if (op === 'claim') {
    const coordinator = await MissionCoordinator.open({
      store: new MissionQueueStore(target),
      queueOptions: { requireLeaseToken: true, preserveRunningLeasesOnRestore: true }
    });
    const mission = await coordinator.claim({ id: value });
    process.stdout.write(JSON.stringify({ ok: true, id: mission?.id ?? null, workerId: value }));
    return;
  }
  if (op === 'journal-begin') {
    const journal = await DurableRequestJournal.open(target);
    const entry = await journal.begin(value, { op: 'synthetic', key: value });
    process.stdout.write(JSON.stringify({ ok: true, requestId: entry.requestId }));
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
