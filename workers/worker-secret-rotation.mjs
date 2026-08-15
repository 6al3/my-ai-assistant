import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const SAFE_WORKER = /^[A-Za-z0-9_.-]{1,63}$/;

function requireInputs({ secretDirectory, workerId, registry, bytes }) {
  if (typeof secretDirectory !== 'string' || !path.isAbsolute(secretDirectory)) throw new Error('secretDirectory must be an absolute path');
  if (typeof workerId !== 'string' || !SAFE_WORKER.test(workerId)) throw new Error('invalid workerId');
  if (!registry?.rotateCredential) throw new Error('registry with rotateCredential is required');
  if (!Number.isSafeInteger(bytes) || bytes < 32 || bytes > 64) throw new Error('bytes must be an integer from 32 to 64');
}

async function assertSecretFile(secretPath) {
  const stat = await lstat(secretPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('worker secret must be a regular file');
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new Error('worker secret permissions are too broad');
}

async function replaceSecret(secretPath, value) {
  const tmp = `${secretPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, `${value}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await chmod(tmp, 0o600);
    await rename(tmp, secretPath);
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
}

export async function rotateWorkerSecret({ secretDirectory, workerId, registry, bytes = 32 } = {}) {
  requireInputs({ secretDirectory, workerId, registry, bytes });
  const secretPath = path.join(secretDirectory, `${workerId}.key`);
  await assertSecretFile(secretPath);
  const previous = (await readFile(secretPath, 'utf8')).trim();
  if (previous.length < 32) throw new Error('existing worker secret is too short');

  const replacement = randomBytes(bytes).toString('base64url');
  await replaceSecret(secretPath, replacement);
  try {
    const enrollment = await registry.rotateCredential(workerId);
    return {
      workerId,
      secretPath,
      credentialGeneration: enrollment.credentialGeneration,
      counterResetTo: enrollment.lastCounter,
      oldCredentialRevoked: true
    };
  } catch (error) {
    await replaceSecret(secretPath, previous);
    throw error;
  }
}
