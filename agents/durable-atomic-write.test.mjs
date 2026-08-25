import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { durableAtomicWrite } from './durable-atomic-write.mjs';

async function assertNoTempFiles(root, basename) {
  const entries = await readdir(root);
  assert.deepEqual(entries.filter(name => name.startsWith(`${basename}.`) && name.endsWith('.tmp')), []);
}

test('durable atomic write replaces content and leaves no temp file', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dig-durable-write-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'state.json');

  await durableAtomicWrite(file, '{"version":1}');
  await durableAtomicWrite(file, '{"version":2}');

  assert.equal(await readFile(file, 'utf8'), '{"version":2}');
  await assertNoTempFiles(root, 'state.json');
  if (process.platform !== 'win32') {
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  }
});

test('concurrent durable writers use independent staging files and commit one complete payload', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dig-durable-write-concurrent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'state.json');
  const payloads = Array.from({ length: 12 }, (_, index) => JSON.stringify({ version: index, marker: `writer-${index}` }));

  await Promise.all(payloads.map(payload => durableAtomicWrite(file, payload)));

  const committed = await readFile(file, 'utf8');
  assert.ok(payloads.includes(committed), 'destination must contain one complete writer payload');
  await assertNoTempFiles(root, 'state.json');
  if (process.platform !== 'win32') {
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  }
});

test('durable atomic write cleans only its own temporary state after a failed write', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dig-durable-write-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'state.json');

  await assert.rejects(() => durableAtomicWrite(file, { invalid: 'writeFile payload' }), TypeError);
  await assert.rejects(() => stat(file), error => error?.code === 'ENOENT');
  await assertNoTempFiles(root, 'state.json');
});
