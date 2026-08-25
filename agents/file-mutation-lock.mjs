import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { durableAtomicWrite } from './durable-atomic-write.mjs';

const execFileAsync = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export async function processStartIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (!pidAlive(pid)) return null;

  if (process.platform === 'linux') {
    try {
      const statText = await readFile(`/proc/${pid}/stat`, 'utf8');
      const closeParen = statText.lastIndexOf(')');
      if (closeParen < 0) return null;
      const fields = statText.slice(closeParen + 2).trim().split(/\s+/);
      const startTicks = fields[19];
      return startTicks ? `linux-proc:${startTicks}` : null;
    } catch {
      return null;
    }
  }

  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      timeout: 1_000,
      maxBuffer: 4_096
    });
    const started = stdout.trim();
    return started ? `ps-lstart:${started}` : null;
  } catch {
    return null;
  }
}

async function moveAside(lockPath, token) {
  const tombstone = `${lockPath}.stale.${process.pid}.${token}`;
  try {
    await rename(lockPath, tombstone);
  } catch (error) {
    if (['ENOENT', 'EACCES', 'EPERM'].includes(error?.code)) return false;
    throw error;
  }
  await rm(tombstone, { recursive: true, force: true });
  return true;
}

export async function withFileMutationLock(lockPath, operation, {
  timeoutMs = 5_000,
  retryMs = 20,
  orphanGraceMs = 5_000,
  now = () => Date.now(),
  getProcessIdentity = processStartIdentity,
  isProcessAlive = pidAlive,
  onAcquired = null,
  onDirectoryCreated = null
} = {}) {
  if (!lockPath?.trim()) throw new Error('lock path is required');
  if (typeof operation !== 'function') throw new Error('lock operation is required');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('lock timeoutMs must be positive');
  if (!Number.isFinite(retryMs) || retryMs <= 0) throw new Error('lock retryMs must be positive');
  if (typeof getProcessIdentity !== 'function') throw new Error('getProcessIdentity must be a function');
  if (typeof isProcessAlive !== 'function') throw new Error('isProcessAlive must be a function');
  if (onAcquired !== null && typeof onAcquired !== 'function') throw new Error('lock onAcquired must be a function');
  if (onDirectoryCreated !== null && typeof onDirectoryCreated !== 'function') throw new Error('lock onDirectoryCreated must be a function');

  const ownerToken = randomUUID();
  const ownerPath = path.join(lockPath, 'owner.json');
  const startedAt = now();
  const processIdentity = await getProcessIdentity(process.pid);
  if (!processIdentity) throw new Error('unable to establish mutation lock process identity');

  while (true) {
    let createdDirectory = false;
    try {
      await mkdir(lockPath, { mode: 0o700 });
      createdDirectory = true;
      // Fault-injection/observability hook for the only legitimate ownerless-lock window:
      // the directory exists, but owner metadata has not yet been published.
      if (onDirectoryCreated) await onDirectoryCreated({ lockPath, ownerPath });
      // Publish owner metadata with the same durable atomic primitive used by mission state.
      // Contenders therefore observe either no owner.json yet or one complete JSON document,
      // never a partially-written owner identity that could create a false fail-closed error.
      await durableAtomicWrite(ownerPath, JSON.stringify({
        pid: process.pid,
        token: ownerToken,
        processIdentity,
        createdAt: now()
      }), { mode: 0o600 });
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        // If this acquisition created the directory but failed before publishing ownership,
        // no other writer can legitimately own it yet. Remove only this ownerless attempt so
        // callers do not have to wait for orphanGraceMs after a local publication failure.
        if (createdDirectory) await rm(lockPath, { recursive: true, force: true }).catch(() => {});
        throw error;
      }

      let reclaim = false;
      let ownerText;
      try {
        ownerText = await readFile(ownerPath, 'utf8');
      } catch (ownerReadError) {
        if (ownerReadError?.code !== 'ENOENT') {
          throw new Error('unable to read mutation lock owner metadata', { cause: ownerReadError });
        }
        // A process can create the lock directory just before atomically publishing owner.json.
        // Only a genuinely ownerless directory may use age-based orphan recovery.
        try {
          const info = await stat(lockPath);
          reclaim = now() - info.mtimeMs > orphanGraceMs;
        } catch (statError) {
          if (statError?.code !== 'ENOENT') throw statError;
        }
      }

      if (ownerText !== undefined) {
        let owner;
        try {
          owner = JSON.parse(ownerText);
        } catch (parseError) {
          throw new Error('invalid mutation lock owner metadata', { cause: parseError });
        }
        if (!Number.isInteger(owner.pid) || owner.pid <= 0 || typeof owner.token !== 'string' || !owner.token || typeof owner.processIdentity !== 'string' || !owner.processIdentity) {
          throw new Error('invalid mutation lock owner metadata');
        }
        const liveIdentity = await getProcessIdentity(owner.pid);
        if (liveIdentity === null) {
          // Identity lookup can fail for a live process because /proc or ps is restricted.
          // Reclaim only when liveness independently proves the PID is gone.
          reclaim = !isProcessAlive(owner.pid);
        } else {
          reclaim = liveIdentity !== owner.processIdentity;
        }
      }

      if (reclaim && await moveAside(lockPath, ownerToken)) continue;
      if (now() - startedAt >= timeoutMs) throw new Error(`timed out acquiring mutation lock: ${lockPath}`);
      await sleep(retryMs);
    }
  }

  try {
    const acquiredAt = now();
    if (onAcquired) await onAcquired({ waitMs: Math.max(0, acquiredAt - startedAt), acquiredAt });
    return await operation();
  } finally {
    try {
      const owner = JSON.parse(await readFile(ownerPath, 'utf8'));
      if (owner.token === ownerToken && owner.processIdentity === processIdentity) await moveAside(lockPath, ownerToken);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}
