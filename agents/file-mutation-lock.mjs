import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

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
  now = () => Date.now()
} = {}) {
  if (!lockPath?.trim()) throw new Error('lock path is required');
  if (typeof operation !== 'function') throw new Error('lock operation is required');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('lock timeoutMs must be positive');
  if (!Number.isFinite(retryMs) || retryMs <= 0) throw new Error('lock retryMs must be positive');

  const ownerToken = randomUUID();
  const ownerPath = path.join(lockPath, 'owner.json');
  const startedAt = now();

  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      await writeFile(ownerPath, JSON.stringify({ pid: process.pid, token: ownerToken, createdAt: now() }), { mode: 0o600 });
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;

      let reclaim = false;
      try {
        const owner = JSON.parse(await readFile(ownerPath, 'utf8'));
        reclaim = !pidAlive(owner.pid);
      } catch {
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
      if (owner.token === ownerToken) await moveAside(lockPath, ownerToken);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}
