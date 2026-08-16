import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { WorkerAuthenticator } from './worker-protocol.mjs';
import { WorkerCounterState, PersistentWorkerSigner } from './worker-counter-state.mjs';
import { WorkerRequestState } from './worker-request-state.mjs';
import { QubesWorkerClient } from './qubes-worker-client.mjs';
import { createQrexecClientVmExchange } from './qrexec-client-vm-exchange.mjs';

function absolute(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
  return path.resolve(value);
}

function readSecret(filePath) {
  const resolved = absolute(filePath, 'worker secret file');
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error('worker secret must be a file');
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new Error('worker secret permissions are too broad');
  const secret = fs.readFileSync(resolved, 'utf8').trim();
  if (secret.length < 32) throw new Error('worker secret is too short');
  return secret;
}

export async function runRealQrexecAcceptance({
  workerId,
  workerSecretFile,
  counterFile,
  requestFile,
  target,
  service,
  executable = '/usr/bin/qrexec-client-vm',
  timeoutMs = 15_000
} = {}) {
  if (!/^[A-Za-z0-9_.-]{1,63}$/.test(String(workerId ?? ''))) throw new Error('invalid workerId');
  const secret = readSecret(workerSecretFile);
  const authenticator = new WorkerAuthenticator({ secrets: { [workerId]: secret } });
  const signer = new PersistentWorkerSigner({
    workerId,
    authenticator,
    counterState: new WorkerCounterState({ filePath: absolute(counterFile, 'counterFile') })
  });
  const requestState = new WorkerRequestState({ filePath: absolute(requestFile, 'requestFile') });
  const exchange = createQrexecClientVmExchange({ target, service, executable, timeoutMs });
  const client = new QubesWorkerClient({ signer, requestState, exchange });

  const pendingBefore = requestState.listPending().length;
  const recoveryStartedAt = performance.now();
  const recovered = pendingBefore ? await client.recoverPending() : [];
  const recoveryMs = performance.now() - recoveryStartedAt;

  const probeId = `acceptance-probe-${Date.now()}`;
  const probeStartedAt = performance.now();
  const status = await client.requestStatus(probeId);
  const probeRoundTripMs = performance.now() - probeStartedAt;
  if (status !== null) throw new Error('acceptance probe requestId unexpectedly exists');

  const unresolved = recovered.filter(item => item.state === 'unresolved').length;
  return {
    readiness: unresolved === 0 ? 'transport-auth-ready' : 'recovery-pending',
    workerId: String(workerId),
    target: String(target),
    service: String(service),
    pendingBefore,
    recovered: recovered.length,
    unresolved,
    probeRoundTripMs,
    recoveryMs,
    mutationPerformed: false
  };
}

async function main() {
  const required = [
    'DIG_WORKER_ID', 'DIG_WORKER_SECRET_FILE', 'DIG_WORKER_COUNTER_FILE', 'DIG_WORKER_REQUEST_FILE',
    'DIG_QREXEC_TARGET', 'DIG_QREXEC_SERVICE'
  ];
  for (const name of required) if (!process.env[name]) throw new Error(`${name} is required`);
  const result = await runRealQrexecAcceptance({
    workerId: process.env.DIG_WORKER_ID,
    workerSecretFile: process.env.DIG_WORKER_SECRET_FILE,
    counterFile: process.env.DIG_WORKER_COUNTER_FILE,
    requestFile: process.env.DIG_WORKER_REQUEST_FILE,
    target: process.env.DIG_QREXEC_TARGET,
    service: process.env.DIG_QREXEC_SERVICE,
    executable: process.env.DIG_QREXEC_CLIENT_VM ?? '/usr/bin/qrexec-client-vm',
    timeoutMs: process.env.DIG_QREXEC_TIMEOUT_MS ? Number(process.env.DIG_QREXEC_TIMEOUT_MS) : 15_000
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    process.stderr.write(`DIG real-qrexec acceptance failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
