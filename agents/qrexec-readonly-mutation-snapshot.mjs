import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';

const ABSENT_DIGEST = createHash('sha256').update('DIG_QREXEC_READONLY_ABSENT_V1').digest('hex');

function requiredPath(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function sameStat(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

function stateDigest(stat, bytes) {
  const contentDigest = createHash('sha256').update(bytes).digest('hex');
  const identity = [
    'DIG_QREXEC_READONLY_FILE_V1',
    stat.dev.toString(),
    stat.ino.toString(),
    stat.size.toString(),
    stat.mtimeNs.toString(),
    stat.ctimeNs.toString(),
    contentDigest
  ].join('\n');
  return createHash('sha256').update(identity).digest('hex');
}

async function stableDigest(path, label, maxAttempts) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let before;
    try {
      before = await lstat(path, { bigint: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new Error(`${label} snapshot failed`, { cause: error });
      try {
        await lstat(path, { bigint: true });
      } catch (secondError) {
        if (secondError?.code === 'ENOENT') return ABSENT_DIGEST;
        throw new Error(`${label} snapshot failed`, { cause: secondError });
      }
      continue;
    }

    if (!before.isFile() || before.isSymbolicLink()) throw new Error(`${label} snapshot target must be a regular file`);

    let bytes;
    let after;
    try {
      bytes = await readFile(path);
      after = await lstat(path, { bigint: true });
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw new Error(`${label} snapshot failed`, { cause: error });
    }

    if (!after.isFile() || after.isSymbolicLink()) throw new Error(`${label} snapshot target must be a regular file`);
    if (sameStat(before, after) && BigInt(bytes.length) === after.size) return stateDigest(after, bytes);
  }
  throw new Error(`${label} changed while snapshotting`);
}

/**
 * Coordinator-side, read-only state snapshotter for Phase-1 qrexec qualification.
 * The digest binds file bytes and mutation-relevant inode metadata so an atomic replace
 * or same-content rewrite is still visible. Reads fail closed when the target changes
 * while being sampled; no MissionQueue or journal mutation API is imported or exposed.
 */
export function createReadonlyMutationStateSnapshotter({
  missionStorePath,
  requestJournalPath,
  maxAttempts = 3
} = {}) {
  const missionPath = requiredPath(missionStorePath, 'missionStorePath');
  const journalPath = requiredPath(requestJournalPath, 'requestJournalPath');
  const attempts = positiveInteger(maxAttempts, 'maxAttempts');

  return async function snapshotMutationState() {
    const [missionStoreDigest, requestJournalDigest] = await Promise.all([
      stableDigest(missionPath, 'mission store', attempts),
      stableDigest(journalPath, 'request journal', attempts)
    ]);
    return { missionStoreDigest, requestJournalDigest };
  };
}
