import assert from 'node:assert/strict';
import { mkdtemp, rename, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createReadonlyMutationStateSnapshotter } from './qrexec-readonly-mutation-snapshot.mjs';

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dig-qrexec-snapshot-'));
  return {
    dir,
    missionStorePath: path.join(dir, 'missions.json'),
    requestJournalPath: path.join(dir, 'journal.json'),
    cleanup: () => rm(dir, { recursive: true, force: true })
  };
}

test('stable absent state produces repeatable digests without creating files', async () => {
  const f = await fixture();
  try {
    const snapshot = createReadonlyMutationStateSnapshotter(f);
    assert.deepEqual(await snapshot(), await snapshot());
  } finally { await f.cleanup(); }
});

test('content changes are detected independently for mission store and request journal', async () => {
  const f = await fixture();
  try {
    await writeFile(f.missionStorePath, '{"version":1,"missions":[]}');
    await writeFile(f.requestJournalPath, '{"version":1,"entries":[]}');
    const snapshot = createReadonlyMutationStateSnapshotter(f);
    const before = await snapshot();
    await writeFile(f.missionStorePath, '{"version":1,"missions":[{"id":"m1"}]}');
    const afterMission = await snapshot();
    assert.notEqual(afterMission.missionStoreDigest, before.missionStoreDigest);
    assert.equal(afterMission.requestJournalDigest, before.requestJournalDigest);
    await writeFile(f.requestJournalPath, '{"version":1,"entries":[{"requestId":"r1"}]}');
    const afterJournal = await snapshot();
    assert.notEqual(afterJournal.requestJournalDigest, afterMission.requestJournalDigest);
  } finally { await f.cleanup(); }
});

test('atomic same-content replacement changes the state digest', async () => {
  const f = await fixture();
  try {
    const bytes = '{"version":1,"missions":[]}';
    await writeFile(f.missionStorePath, bytes);
    const snapshot = createReadonlyMutationStateSnapshotter(f);
    const before = await snapshot();
    const replacement = `${f.missionStorePath}.next`;
    await writeFile(replacement, bytes);
    await rename(replacement, f.missionStorePath);
    const after = await snapshot();
    assert.notEqual(after.missionStoreDigest, before.missionStoreDigest);
  } finally { await f.cleanup(); }
});

test('same-content in-place rewrite is visible through mutation metadata', async () => {
  const f = await fixture();
  try {
    const bytes = '{"version":1,"missions":[]}';
    await writeFile(f.missionStorePath, bytes);
    const snapshot = createReadonlyMutationStateSnapshotter(f);
    const before = await snapshot();
    await new Promise(resolve => setTimeout(resolve, 5));
    await writeFile(f.missionStorePath, bytes);
    const after = await snapshot();
    assert.notEqual(after.missionStoreDigest, before.missionStoreDigest);
  } finally { await f.cleanup(); }
});

test('symlink targets fail closed', async () => {
  const f = await fixture();
  try {
    const target = path.join(f.dir, 'target.json');
    await writeFile(target, '{}');
    const { symlink } = await import('node:fs/promises');
    await symlink(target, f.missionStorePath);
    const snapshot = createReadonlyMutationStateSnapshotter(f);
    await assert.rejects(snapshot(), /regular file/);
  } finally { await f.cleanup(); }
});

test('invalid configuration fails before qualification starts', () => {
  assert.throws(() => createReadonlyMutationStateSnapshotter({ requestJournalPath: '/tmp/journal' }), /missionStorePath is required/);
  assert.throws(() => createReadonlyMutationStateSnapshotter({ missionStorePath: '/tmp/missions', requestJournalPath: '/tmp/journal', maxAttempts: 0 }), /maxAttempts/);
});
