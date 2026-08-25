import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { withFileMutationLock } from './file-mutation-lock.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function missing(target) {
  try {
    await stat(target);
    return false;
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw error;
  }
}

test('contenders tolerate the ownerless publication window and observe a complete owner document', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dig-lock-owner-publish-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lock = path.join(root, 'state.lock');
  const ownerPath = path.join(lock, 'owner.json');

  let releasePublication;
  const publicationGate = new Promise(resolve => { releasePublication = resolve; });
  let directoryCreated;
  const directoryReady = new Promise(resolve => { directoryCreated = resolve; });
  const events = [];

  const first = withFileMutationLock(lock, async () => {
    events.push('first');
    await sleep(15);
  }, {
    retryMs: 1,
    timeoutMs: 500,
    orphanGraceMs: 1_000,
    onDirectoryCreated: async () => {
      directoryCreated();
      await publicationGate;
    }
  });

  await directoryReady;
  assert.equal(await missing(ownerPath), true, 'owner metadata must remain absent until atomic publication completes');

  const contender = withFileMutationLock(lock, async () => {
    events.push('contender');
    const owner = JSON.parse(await readFile(ownerPath, 'utf8'));
    assert.equal(typeof owner.token, 'string');
    assert.equal(typeof owner.processIdentity, 'string');
  }, {
    retryMs: 1,
    timeoutMs: 500,
    orphanGraceMs: 1_000
  });

  await sleep(10);
  releasePublication();
  await Promise.all([first, contender]);
  assert.deepEqual(events, ['first', 'contender']);
});

test('owner-publication hook failure removes the ownerless lock attempt immediately', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dig-lock-owner-publish-fail-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lock = path.join(root, 'state.lock');

  await assert.rejects(() => withFileMutationLock(lock, async () => 'must-not-run', {
    onDirectoryCreated: async () => {
      throw new Error('owner publication setup failed');
    }
  }), /owner publication setup failed/);

  assert.equal(await missing(lock), true, 'failed owner publication must not leave an orphan directory behind');
  assert.equal(await withFileMutationLock(lock, async () => 'reacquired'), 'reacquired');
});
