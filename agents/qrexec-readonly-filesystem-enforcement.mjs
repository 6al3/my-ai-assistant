import { constants as FS_CONSTANTS } from 'node:fs';
import { access, lstat, open } from 'node:fs/promises';
import path from 'node:path';

const DENIED_CODES = new Set(['EACCES', 'EPERM', 'EROFS']);

function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required`);
  return value.trim();
}

function denied(error) {
  return Boolean(error && DENIED_CODES.has(error.code));
}

async function requireDenied(operation, label) {
  try {
    await operation();
  } catch (error) {
    if (denied(error)) return;
    throw error;
  }
  throw new Error(`${label} is writable by the Phase-1 service identity`);
}

async function verifyTarget(targetPath, label, fsOps) {
  const stat = await fsOps.lstat(targetPath);
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
  if (!stat.isFile()) throw new Error(`${label} must be a regular file`);

  await fsOps.access(targetPath, FS_CONSTANTS.R_OK);
  await requireDenied(() => fsOps.access(targetPath, FS_CONSTANTS.W_OK), label);

  // Opening r+ performs no write, but proves whether the current service identity can
  // obtain a writable descriptor. A successful open is itself a failed qualification.
  await requireDenied(async () => {
    const handle = await fsOps.open(targetPath, 'r+');
    await handle.close();
  }, `${label} writable descriptor`);

  // Atomic replacement can bypass read-only file bits when the containing directory is
  // writable. Require the service identity to lack directory write permission as well.
  const parent = path.dirname(targetPath);
  await fsOps.access(parent, FS_CONSTANTS.R_OK | FS_CONSTANTS.X_OK);
  await requireDenied(() => fsOps.access(parent, FS_CONSTANTS.W_OK), `${label} parent directory`);

  return {
    pathRole: label,
    fileWriteDenied: true,
    writableDescriptorDenied: true,
    parentDirectoryWriteDenied: true
  };
}

/**
 * Qualify the coordinator-side execution identity used by the read-only qrexec Phase-1 service.
 * This must execute inside that service identity/context. It proves that MissionStore and the
 * DurableRequestJournal are readable but not writable, and that their parent directories cannot
 * be used for atomic replacement. It performs no writes and exposes no file contents.
 */
export async function qualifyReadonlyFilesystemEnforcement({
  missionStorePath,
  requestJournalPath,
  fsOps = { access, lstat, open }
} = {}) {
  const missionPath = requiredString(missionStorePath, 'missionStorePath');
  const journalPath = requiredString(requestJournalPath, 'requestJournalPath');
  if (!fsOps || typeof fsOps !== 'object') throw new Error('fsOps is required');
  for (const name of ['access', 'lstat', 'open']) {
    if (typeof fsOps[name] !== 'function') throw new Error(`fsOps.${name} must be a function`);
  }

  const missionStore = await verifyTarget(missionPath, 'MissionStore', fsOps);
  const requestJournal = await verifyTarget(journalPath, 'DurableRequestJournal', fsOps);

  return {
    schemaVersion: 1,
    readiness: 'LAB READY',
    enforcementVerified: true,
    missionStore,
    requestJournal
  };
}
