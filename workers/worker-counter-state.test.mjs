import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WorkerAuthenticator } from './worker-protocol.mjs';
import { WorkerCounterState, PersistentWorkerSigner } from './worker-counter-state.mjs';

const SECRET = 'w'.repeat(64);
const temp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dig-worker-counter-'));
  return { dir, filePath: path.join(dir, 'counter.json') };
};

test('counter persists across worker restart', async t => {
  const f = temp(); t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  const first = new WorkerCounterState({ filePath: f.filePath });
  assert.equal(await first.reserve(), 1);
  assert.equal(await first.reserve(), 2);
  const restarted = new WorkerCounterState({ filePath: f.filePath });
  assert.equal(await restarted.reserve(), 3);
  assert.equal(restarted.peek(), 4);
});

test('concurrent counter reservations are unique and gap-free', async t => {
  const f = temp(); t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  const states = Array.from({ length: 8 }, () => new WorkerCounterState({ filePath: f.filePath, lockRetryMs: 1 }));
  const counters = await Promise.all(Array.from({ length: 64 }, (_, i) => states[i % states.length].reserve()));
  assert.equal(new Set(counters).size, 64);
  assert.deepEqual([...counters].sort((a, b) => a - b), Array.from({ length: 64 }, (_, i) => i + 1));
});

test('persistent signer emits monotonically increasing authenticated counters', async t => {
  const f = temp(); t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  const auth = new WorkerAuthenticator({ secrets: { worker: SECRET }, now: () => 1_000 });
  const signer1 = new PersistentWorkerSigner({ workerId: 'worker', authenticator: auth, counterState: new WorkerCounterState({ filePath: f.filePath }) });
  const a = await signer1.sign({ action: 'claim', timestamp: 1_000 });
  const signer2 = new PersistentWorkerSigner({ workerId: 'worker', authenticator: auth, counterState: new WorkerCounterState({ filePath: f.filePath }) });
  const b = await signer2.sign({ action: 'heartbeat', timestamp: 1_000 });
  assert.equal(a.counter, 1);
  assert.equal(b.counter, 2);
  assert.notEqual(a.signature, b.signature);
});

test('counter file is owner-only on POSIX', async t => {
  if (process.platform === 'win32') return;
  const f = temp(); t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  const state = new WorkerCounterState({ filePath: f.filePath });
  await state.reserve();
  assert.equal(fs.statSync(f.filePath).mode & 0o777, 0o600);
});
