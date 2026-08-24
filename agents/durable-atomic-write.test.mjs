import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { durableAtomicWrite } from './durable-atomic-write.mjs';

test('durable atomic write replaces content and leaves no temp file', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dig-durable-write-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'state.json');

  await durableAtomicWrite(file, '{"version":1}');
  await durableAtomicWrite(file, '{"version":2}');

  assert.equal(await readFile(file, 'utf8'), '{"version":2}');
  await assert.rejects(() => stat(`${file}.tmp`), error => error?.code === 'ENOENT');
  if (process.platform !== 'win32') {
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  }
});

test('durable atomic write cleans temporary state after a failed write', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dig-durable-write-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'state.json');

  // A directory at the temp path forces open(..., "w") to fail.
  const { mkdir } = await import('node:fs/promises');
  await mkdir(`${file}.tmp`);
  await assert.rejects(() => durableAtomicWrite(file, 'never committed'));
  await assert.rejects(() => stat(file), error => error?.code === 'ENOENT');
  await assert.rejects(() => stat(`${file}.tmp`), error => error?.code === 'ENOENT');
});
