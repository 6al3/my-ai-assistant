import { pathToFileURL } from 'node:url';
import { runProcessCoordinator } from './orchestration-process-coordinator.mjs';

export function loadQrexecCoordinatorConfig(env = process.env) {
  const storePath = env.DIG_ORCHESTRATION_STORE?.trim();
  const requestJournalPath = env.DIG_REQUEST_JOURNAL?.trim();
  const transportSecret = env.DIG_TRANSPORT_SECRET;

  if (!storePath) throw new Error('DIG_ORCHESTRATION_STORE is required');
  if (!requestJournalPath) throw new Error('DIG_REQUEST_JOURNAL is required');
  if (!transportSecret || Buffer.byteLength(transportSecret, 'utf8') < 32) {
    throw new Error('DIG_TRANSPORT_SECRET must be at least 32 bytes');
  }

  return {
    storePath,
    requestJournalPath,
    transportSecret,
    crashAfterRequestId: env.DIG_CRASH_AFTER_REQUEST_ID?.trim() || null,
    preserveRunningLeasesOnRestore: true
  };
}

export async function runQrexecCoordinatorService({ env = process.env, input = process.stdin, output = process.stdout } = {}) {
  const config = loadQrexecCoordinatorConfig(env);
  return runProcessCoordinator({ ...config, input, output });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runQrexecCoordinatorService().catch(error => {
    process.stderr.write(`DIG qrexec coordinator service failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
