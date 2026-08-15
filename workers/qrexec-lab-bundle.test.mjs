import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildQrexecLabBundle, provisionWorkerSecret, renderQrexecPolicy } from './qrexec-lab-bundle.mjs';

test('policy pins source and target and ends with deny fallback', () => {
  const policy = renderQrexecPolicy({ sourceQube: 'dig-worker', targetQube: 'dig-coordinator' });
  assert.equal(policy, 'dig.Coordinator * dig-worker dig-coordinator allow\ndig.Coordinator * * * deny\n');
});

test('bundle requires no network listener and embeds no secret', () => {
  const bundle = buildQrexecLabBundle({ sourceQube: 'dig-worker', targetQube: 'dig-coordinator', entryPath: '/opt/dig/workers/coordinator-entry.mjs' });
  assert.equal(bundle.safety.networkListenerRequired, false);
  assert.equal(bundle.safety.defaultDenyFallback, true);
  assert.equal(bundle.safety.secretEmbedded, false);
  assert.match(bundle.serviceScript, /^#!\/bin\/sh\nset -eu\nexec /);
  assert.equal(bundle.installModes.service, 0o755);
});

test('invalid qube names are rejected instead of entering policy text', () => {
  assert.throws(() => renderQrexecPolicy({ sourceQube: 'worker\n* * allow', targetQube: 'dig-coordinator' }));
  assert.throws(() => renderQrexecPolicy({ sourceQube: 'same', targetQube: 'same' }));
});

test('secret provisioning creates unique owner-only secret and refuses overwrite', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dig-secret-'));
  const { secretPath } = await provisionWorkerSecret({ directory: root, workerId: 'worker-01' });
  const value = (await readFile(secretPath, 'utf8')).trim();
  assert.ok(value.length >= 43);
  if (process.platform !== 'win32') assert.equal((await stat(secretPath)).mode & 0o777, 0o600);
  await assert.rejects(() => provisionWorkerSecret({ directory: root, workerId: 'worker-01' }));
});
