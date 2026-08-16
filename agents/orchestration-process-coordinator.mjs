import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { MissionQueueStore } from './mission-queue-store.mjs';
import { OrchestratedMissionRuntime } from './orchestrated-mission-runtime.mjs';

export async function runProcessCoordinator({ storePath, input = process.stdin, output = process.stdout } = {}) {
  if (!storePath) throw new Error('storePath is required');
  const store = new MissionQueueStore(storePath);
  const runtime = await OrchestratedMissionRuntime.open({ store, queueOptions: { maxAttempts: 3 } });
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
      default: throw new Error(`unknown op: ${command?.op}`);
    }
  };

  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      const command = JSON.parse(line);
      if (command.op === 'completeAndExit') {
        await execute(command);
        continue;
      }
      reply({ ok: true, result: await execute(command) });
    } catch (error) {
      reply({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runProcessCoordinator({ storePath: process.env.DIG_ORCHESTRATION_STORE }).catch(error => {
    process.stderr.write(`DIG orchestration coordinator failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
