import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildQrexecCoordinator, loadWorkerSecrets } from './qrexec-coordinator-entrypoint.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dig-qrexec-entry-'));
  const secretDirectory = path.join(root, 'secrets');
  fs.mkdirSync(secretDirectory, { mode: 0o700 });
  fs.writeFileSync(path.join(secretDirectory, 'coder.key'), `${'x'.repeat(48)}\n`, { mode: 0o600 });
  const workerManifestFile = path.join(root, 'workers.json');
  fs.writeFileSync(workerManifestFile, JSON.stringify({ workers: [{ id: 'coder', capabilities: ['code'], maxConcurrent: 1 }] }));
  return {
    root,
    secretDirectory,
    workerManifestFile,
    stateFile: path.join(root, 'missions.json'),
    registryFile: path.join(root, 'registry.json')
  };
}

test('loads only explicitly declared owner-only worker secrets', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.secretDirectory, 'ignored.key'), `${'y'.repeat(48)}\n`, { mode: 0o600 });
  const secrets = loadWorkerSecrets({ directory: f.secretDirectory, workerIds: ['coder'] });
  assert.deepEqual(Object.keys(secrets), ['coder']);
  assert.equal(secrets.coder.length, 48);
});

test('rejects overly broad worker secret permissions on POSIX', { skip: process.platform === 'win32' }, () => {
  const f = fixture();
  fs.chmodSync(path.join(f.secretDirectory, 'coder.key'), 0o644);
  assert.throws(() => loadWorkerSecrets({ directory: f.secretDirectory, workerIds: ['coder'] }), /permissions are too broad/);
});

test('builds transactional runtime, replay registry, and stdio transport without listener', async () => {
  const f = fixture();
  const built = await buildQrexecCoordinator(f);
  assert.deepEqual(built.workerIds, ['coder']);
  assert.equal(typeof built.transport.serve, 'function');
  assert.equal(typeof built.runtime.handle, 'function');
  assert.equal((await built.registry.get('coder')).status, 'online');
  assert.equal(fs.existsSync(f.stateFile), true);
  assert.equal(fs.existsSync(f.registryFile), true);
});

test('rejects duplicate worker identities in deployment manifest', async () => {
  const f = fixture();
  fs.writeFileSync(f.workerManifestFile, JSON.stringify({ workers: [{ id: 'coder' }, { id: 'coder' }] }));
  await assert.rejects(() => buildQrexecCoordinator(f), /duplicate ids/);
});

test('does not bootstrap undeclared secret files into registry', async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.secretDirectory, 'qa.key'), `${'z'.repeat(48)}\n`, { mode: 0o600 });
  const built = await buildQrexecCoordinator(f);
  assert.equal(await built.registry.get('qa'), null);
});
