import { spawn } from 'node:child_process';

const SAFE_QUBE = /^[A-Za-z0-9_.-]{1,63}$/;
const SAFE_SERVICE = /^[A-Za-z0-9_.+-]{1,127}$/;

function validateName(value, pattern, label) {
  const text = String(value ?? '');
  if (!pattern.test(text)) throw new Error(`invalid ${label}: ${text}`);
  return text;
}

export function createQrexecClientVmExchange({
  target,
  service,
  executable = '/usr/bin/qrexec-client-vm',
  executableArgs = [],
  timeoutMs = 15_000,
  maxResponseBytes = 1024 * 1024,
  maxStderrBytes = 16 * 1024,
  env = process.env
} = {}) {
  const targetName = validateName(target, SAFE_QUBE, 'target qube');
  const serviceName = validateName(service, SAFE_SERVICE, 'qrexec service');
  if (typeof executable !== 'string' || executable.length === 0) throw new Error('executable is required');
  if (!Array.isArray(executableArgs) || executableArgs.some(arg => typeof arg !== 'string')) throw new Error('executableArgs must be strings');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('timeoutMs must be a positive integer');
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) throw new Error('maxResponseBytes must be a positive integer');
  if (!Number.isSafeInteger(maxStderrBytes) || maxStderrBytes < 0) throw new Error('maxStderrBytes must be a non-negative integer');

  return async function exchange(frameBytes) {
    if (!Buffer.isBuffer(frameBytes) && !(frameBytes instanceof Uint8Array)) throw new Error('frameBytes must be bytes');
    const request = Buffer.from(frameBytes);

    return new Promise((resolve, reject) => {
      const child = spawn(executable, [...executableArgs, targetName, serviceName], {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false
      });
      const stdout = [];
      const stderr = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      let timer = null;

      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        fn(value);
      };

      const fail = error => {
        if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
        finish(reject, error);
      };

      child.once('error', error => fail(new Error(`qrexec-client-vm spawn failed: ${error.message}`)));
      child.stdout.on('data', chunk => {
        const bytes = Buffer.from(chunk);
        stdoutBytes += bytes.length;
        if (stdoutBytes > maxResponseBytes) {
          fail(new Error(`qrexec response exceeds ${maxResponseBytes} bytes`));
          return;
        }
        stdout.push(bytes);
      });
      child.stderr.on('data', chunk => {
        if (maxStderrBytes === 0 || stderrBytes >= maxStderrBytes) return;
        const bytes = Buffer.from(chunk);
        const keep = bytes.subarray(0, Math.max(0, maxStderrBytes - stderrBytes));
        stderrBytes += keep.length;
        stderr.push(keep);
      });
      child.once('close', (code, signal) => {
        if (settled) return;
        if (code !== 0) {
          const detail = Buffer.concat(stderr).toString('utf8').trim();
          const suffix = detail ? `: ${detail}` : '';
          finish(reject, new Error(`qrexec-client-vm failed (${signal ?? code})${suffix}`));
          return;
        }
        finish(resolve, Buffer.concat(stdout));
      });

      timer = setTimeout(() => {
        fail(new Error(`qrexec-client-vm timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();

      child.stdin.end(request, error => {
        if (error) fail(new Error(`qrexec request write failed: ${error.message}`));
      });
    });
  };
}
