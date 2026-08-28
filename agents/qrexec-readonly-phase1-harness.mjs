import { spawn } from 'node:child_process';

const DEFAULT_CLIENT = '/usr/bin/qrexec-client-vm';
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024;

function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required`);
  return value.trim();
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function normalizePayload(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  throw new Error('scenario payload must be a string, Buffer, or Uint8Array');
}

function countJsonFrames(buffer) {
  const text = buffer.toString('utf8').trim();
  if (!text) return 0;
  try {
    JSON.parse(text);
    return 1;
  } catch {
    return text.split(/\r?\n/).filter((line) => line.trim() !== '').length;
  }
}

/**
 * Build a process-per-call Qubes RPC invoker for read-only Phase-1 qualification.
 * No shell is involved. Only stdin/stdout cross the qrexec channel; remote stderr is
 * intentionally ignored to keep qualification evidence free of secrets and paths.
 */
export function createQrexecClientVmInvoker({
  coordinatorQube,
  scenarios,
  clientPath = DEFAULT_CLIENT,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  spawnImpl = spawn
} = {}) {
  const target = requiredString(coordinatorQube, 'coordinatorQube');
  requiredString(clientPath, 'clientPath');
  positiveInteger(timeoutMs, 'timeoutMs');
  positiveInteger(maxResponseBytes, 'maxResponseBytes');
  if (!scenarios || typeof scenarios !== 'object' || Array.isArray(scenarios)) throw new Error('scenarios is required');
  if (typeof spawnImpl !== 'function') throw new Error('spawnImpl must be a function');

  return async function invokeScenario(name) {
    const definition = scenarios[name];
    if (!definition || typeof definition !== 'object' || Array.isArray(definition)) throw new Error(`scenario ${name} is not configured`);
    const service = requiredString(definition.service, `scenario ${name}.service`);
    const payload = normalizePayload(definition.payload ?? '');

    return new Promise((resolve, reject) => {
      let settled = false;
      let oversized = false;
      let stdoutBytes = 0;
      const stdoutChunks = [];
      const child = spawnImpl(clientPath, [target, service], {
        shell: false,
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true
      });

      const finishReject = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      };

      const timer = setTimeout(() => {
        if (settled) return;
        child.kill('SIGKILL');
        finishReject(new Error(`scenario ${name} timed out`));
      }, timeoutMs);
      timer.unref?.();

      child.on('error', (error) => finishReject(new Error(`scenario ${name} qrexec invocation failed: ${error.code ?? 'spawn-error'}`)));
      child.stdout.on('data', (chunk) => {
        if (settled || oversized) return;
        stdoutBytes += chunk.length;
        if (stdoutBytes > maxResponseBytes) {
          oversized = true;
          child.kill('SIGKILL');
          return;
        }
        stdoutChunks.push(Buffer.from(chunk));
      });
      child.on('close', (code) => {
        if (settled) return;
        if (oversized) return finishReject(new Error(`scenario ${name} response exceeded ${maxResponseBytes} bytes`));
        settled = true;
        clearTimeout(timer);
        const responseBuffer = Buffer.concat(stdoutChunks);
        const responseText = responseBuffer.toString('utf8').trim();
        let response = null;
        if (responseText) {
          try { response = JSON.parse(responseText); }
          catch { response = responseText; }
        }
        resolve({
          exitCode: Number.isInteger(code) && code >= 0 && code <= 255 ? code : 255,
          response,
          responseBytes: responseBuffer.length,
          responseFrames: countJsonFrames(responseBuffer)
        });
      });

      child.stdin.on('error', () => {});
      child.stdin.end(payload);
    });
  };
}

export const QREXEC_READONLY_PHASE1_DEFAULTS = Object.freeze({
  clientPath: DEFAULT_CLIENT,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES
});
