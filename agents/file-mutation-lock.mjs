import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

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
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
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
  getProcessIdentity = processStartIdentity
} = {}) {
  if (!lockPath?.trim()) throw new Error('lock path is required');
  if (typeof operation !== 'function') throw new Error('lock operation is required');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('lock timeoutMs must be positive');
  if (!Number.isFinite(retryMs) || retryMs <= 0) throw new Error('lock retryMs must be positive');
  if (typeof getProcessIdentity !== 'function') throw new Error('getProcessIdentity must be a function');

  const ownerToken = randomUUID();
  const ownerPath = path.join(lockPath, 'owner.json');
  const startedAt = now();
  const processIdentity = await getProcessIdentity(process.pid);
  if (!processIdentity) throw new Error('unable to establish mutation lock process identity');

  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      await writeFile(ownerPath, JSON.stringify({
        pid: process.pid,
        token: ownerToken,
        processIdentity,
        createdAt: now()
      }), { mode: 0o600 });
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;

      let reclaim = false;
      try {
        const owner = JSON.parse(await readFile(ownerPath, 'utf8'));
        if (!Number.isInteger(owner.pid) || owner.pid <= 0 || typeof owner.token !== 'string' || !owner.token || typeof owner.processIdentity !== 'string' || !owner.processIdentity) {
          throw new Error('invalid mutation lock owner metadata');
        }
        const liveIdentity = await getProcessIdentity(owner.pid);
        reclaim = liveIdentity === null || liveIdentity !== owner.processIdentity;
      } catch (ownerError) {
        if (ownerError?.message === 'invalid mutation lock owner metadata') {
          throw ownerError;
        }
        try {
          const info = await stat(lockPath);
          reclaim = now() - info.mtimeMs > orphanGraceMs;
        } catch (statError) {
          if (statError?.code !== 'ENOENT') throw statError;
        }
      }

      if (reclaim && await moveAside(lockPath, ownerToken)) continue;
      if (now() - startedAt >= timeoutMs) throw new Error(`timed out acquiring mutation lock: ${lockPath}`);
      await sleep(retryMs);
    }
  }

  try {
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
