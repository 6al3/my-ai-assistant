import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DurableWorkerRegistry } from './durable-worker-registry.mjs';
import { WorkerAuthenticator } from './worker-protocol.mjs';
import { readWorkerSecret } from './qrexec-coordinator-entrypoint.mjs';
import { rotateWorkerSecret } from './worker-secret-rotation.mjs';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dig-rotation-'));
  const secretDirectory = path.join(root, 'secrets');
  await mkdir(secretDirectory, { mode: 0o700 });
  const workerId = 'coder-1';
  const oldSecret = 'A'.repeat(48);
  const secretPath = path.join(secretDirectory, `${workerId}.key`);
  await writeFile(secretPath, `${oldSecret}\n`, { mode: 0o600 });
  const registry = new DurableWorkerRegistry({ filePath: path.join(root, 'registry.json'), ttlMs: 60_000 });
  await registry.register({ id: workerId, capabilities: ['code'] });
  return { root, secretDirectory, workerId, oldSecret, secretPath, registry };
}

test('rotation rejects the old key and accepts the new key from counter 1', async () => {
  const f = await fixture();
  const verifier = new WorkerAuthenticator({
    secrets: id => readWorkerSecret({ directory: f.secretDirectory, workerId: id }),
    replayStore: f.registry
  });
  const oldSigner = new WorkerAuthenticator({ secrets: { [f.workerId]: f.oldSecret } });
  await verifier.verify(oldSigner.sign({ workerId: f.workerId, action: 'claim', counter: 9, payload: { requestId: 'before' } }));

  const result = await rotateWorkerSecret(f);
  assert.equal(result.oldCredentialRevoked, true);
  assert.equal(result.counterResetTo, 0);
  assert.equal(result.credentialGeneration, 2);
  assert.equal((await f.registry.get(f.workerId)).lastCounter, 0);

  await assert.rejects(
    verifier.verify(oldSigner.sign({ workerId: f.workerId, action: 'claim', counter: 10, payload: { requestId: 'old-after-rotate' } })),
    /invalid worker signature/
  );

  const newSecret = readWorkerSecret({ directory: f.secretDirectory, workerId: f.workerId });
  assert.notEqual(newSecret, f.oldSecret);
  const newSigner = new WorkerAuthenticator({ secrets: { [f.workerId]: newSecret } });
  const verified = await verifier.verify(newSigner.sign({ workerId: f.workerId, action: 'claim', counter: 1, payload: { requestId: 'new-after-rotate' } }));
  assert.equal(verified.counter, 1);
});

test('rotation preserves owner-only secret permissions', async () => {
  const f = await fixture();
  await rotateWorkerSecret(f);
  if (process.platform !== 'win32') assert.equal((await stat(f.secretPath)).mode & 0o777, 0o600);
});

test('failed registry rotation restores the previous secret', async () => {
  const f = await fixture();
  const failingRegistry = { rotateCredential: async () => { throw new Error('registry write failed'); } };
  await assert.rejects(rotateWorkerSecret({ ...f, registry: failingRegistry }), /registry write failed/);
  assert.equal((await readFile(f.secretPath, 'utf8')).trim(), f.oldSecret);
});

test('rotation result never exposes secret material', async () => {
  const f = await fixture();
  const result = await rotateWorkerSecret(f);
  const serialized = JSON.stringify(result);
  const newSecret = (await readFile(f.secretPath, 'utf8')).trim();
  assert.equal(serialized.includes(f.oldSecret), false);
  assert.equal(serialized.includes(newSecret), false);
});
