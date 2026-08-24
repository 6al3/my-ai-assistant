import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { withFileMutationLock } from './file-mutation-lock.mjs';

test('mutation lock serializes competing callers', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dig-mutation-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lock = path.join(root, 'state.lock');
  const events = [];

  await Promise.all([
    withFileMutationLock(lock, async () => {
      events.push('a:start');
      await new Promise(resolve => setTimeout(resolve, 40));
      events.push('a:end');
    }),
    withFileMutationLock(lock, async () => {
      events.push('b:start');
      events.push('b:end');
    })
  ]);

  const aStart = events.indexOf('a:start');
  const aEnd = events.indexOf('a:end');
  const bStart = events.indexOf('b:start');
  const bEnd = events.indexOf('b:end');
  assert.ok((aEnd < bStart) || (bEnd < aStart), `critical sections overlapped: ${events.join(', ')}`);
});

test('mutation lock is released when the protected operation throws', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dig-mutation-lock-error-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lock = path.join(root, 'state.lock');

  await assert.rejects(
    () => withFileMutationLock(lock, async () => { throw new Error('boom'); }),
    /boom/
  );
  const result = await withFileMutationLock(lock, async () => 'reacquired');
  assert.equal(result, 'reacquired');
});
