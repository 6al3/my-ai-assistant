import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { DurableRequestJournal, digestWorkerCommand } from './durable-request-journal.mjs';
import { MissionQueueStore } from './mission-queue-store.mjs';
import { OrchestratedMissionRuntime } from './orchestrated-mission-runtime.mjs';
import { WorkerEnvelopeVerifier } from './worker-transport-envelope.mjs';

export async function runProcessCoordinator({
  storePath,
  requestJournalPath = null,
  transportSecret = null,
  input = process.stdin,
  output = process.stdout
} = {}) {
  if (!storePath) throw new Error('storePath is required');
  if ((requestJournalPath && !transportSecret) || (!requestJournalPath && transportSecret)) {
    throw new Error('requestJournalPath and transportSecret must be configured together');
  }

  const store = new MissionQueueStore(storePath);
  const runtime = await OrchestratedMissionRuntime.open({ store, queueOptions: { maxAttempts: 3 } });
  const journal = requestJournalPath ? await DurableRequestJournal.open(requestJournalPath) : null;
  const lines = readline.createInterface({ input, crlfDelay: Infinity });

  const reply = value => output.write(`${JSON.stringify(value)}\n`);
  const execute = async command => {
    switch (command?.op) {
      case 'submit': return runtime.submit(command.text, command.options ?? {});
      case 'claim': return runtime.claim(command.worker);
      case 'complete': return runtime.complete(command.id, command.workerId, command.result ?? null);
      case 'fail': return runtime.fail(command.id, command.workerId, command.error ?? 'synthetic failure');
      case 'get': return runtime.get(command.id);
      case 'stats': return runtime.stats();
      case 'completeAndExit': {
        const completed = await runtime.complete(command.id, command.workerId, command.result ?? null);
        await runtime.coordinator.flush();
        process.exitCode = 0;
        setImmediate(() => process.exit(0));
        return { exiting: true, completed };
      }
      case 'completeAndCrashBeforeJournalCommit': {
        const completed = await runtime.complete(command.id, command.workerId, command.result ?? null);
        await runtime.coordinator.flush();
        setImmediate(() => process.exit(86));
        return { exiting: true, completed };
      }
      default: throw new Error(`unknown op: ${command?.op}`);
    }
  };

  const authenticate = envelope => {
    // DurableRequestJournal is the replay authority. A short-lived verifier is
    // intentionally used only for MAC/timestamp authentication so retries with
    // the same requestId can be reconciled after process restart.
    const verifier = new WorkerEnvelopeVerifier({ secret: transportSecret });
    return verifier.verify(envelope);
  };

  const executeAuthenticated = async envelope => {
    const verified = authenticate(envelope);
    const command = { op: verified.op, ...(verified.body ?? {}) };
    const digest = digestWorkerCommand({ op: verified.op, body: verified.body ?? null });
    const existing = journal.get(verified.requestId);

    if (existing) {
      if (existing.digest !== digest) throw new Error('requestId reused with different command');
      if (existing.status === 'committed') return existing.response;
    } else {
      await journal.begin({ requestId: verified.requestId, digest });
    }

    const result = await execute(command);
    if (verified.op === 'completeAndCrashBeforeJournalCommit') return null;

    const response = { ok: true, result };
    await journal.commit(verified.requestId, response);
    return response;
  };

  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (journal) {
        const response = await executeAuthenticated(parsed);
        if (response) reply(response);
        continue;
      }

      if (parsed.op === 'completeAndExit') {
        await execute(parsed);
        continue;
      }
      reply({ ok: true, result: await execute(parsed) });
    } catch (error) {
      reply({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runProcessCoordinator({
    storePath: process.env.DIG_ORCHESTRATION_STORE,
    requestJournalPath: process.env.DIG_REQUEST_JOURNAL || null,
    transportSecret: process.env.DIG_TRANSPORT_SECRET || null
  }).catch(error => {
    process.stderr.write(`DIG orchestration coordinator failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
