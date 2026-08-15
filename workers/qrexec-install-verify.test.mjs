import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, symlink, writeFile, chmod } from 'node:fs/promises';
import { buildQrexecLabBundle } from './qrexec-lab-bundle.mjs';
import { installQrexecBundle, verifyQrexecInstall } from './qrexec-install-verify.mjs';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dig-qrexec-install-'));
  return buildQrexecLabBundle({
    sourceQube: 'dig-worker', targetQube: 'dig-coordinator', entryPath: '/opt/dig/workers/qrexec-coordinator-entrypoint.mjs',
    policyFile: path.join(root, 'policy.d', '30-dig-coordinator.policy'),
    serviceFile: path.join(root, 'qubes-rpc', 'dig.Coordinator')
  });
}

test('dry-run reports planned writes without changing disk', async () => {
  const bundle = await fixture();
  const result = await installQrexecBundle(bundle, { dryRun: true });
  assert.equal(result.dryRun, true);
  assert.equal(result.changed, false);
  assert.equal(result.plan.filter(item => item.needsWrite).length, 2);
  assert.equal((await verifyQrexecInstall(bundle)).ok, false);
});

test('install is verified and idempotent', async () => {
  const bundle = await fixture();
  const first = await installQrexecBundle(bundle, { dryRun: false });
  assert.equal(first.changed, true);
  assert.equal(first.after.ok, true);
  const second = await installQrexecBundle(bundle, { dryRun: false });
  assert.equal(second.changed, false);
  assert.equal(second.after.ok, true);
  assert.equal(await readFile(bundle.policyFile, 'utf8'), bundle.policy);
  assert.equal(await readFile(bundle.serviceFile, 'utf8'), bundle.serviceScript);
});

test('verification detects content and permission drift', async () => {
  const bundle = await fixture();
  await installQrexecBundle(bundle, { dryRun: false });
  await writeFile(bundle.policyFile, 'tampered\n', 'utf8');
  let report = await verifyQrexecInstall(bundle);
  assert.equal(report.ok, false);
  assert.equal(report.policy.contentMatches, false);
  assert.equal(report.secretMaterialReported, false);
  if (process.platform !== 'win32') {
    await writeFile(bundle.policyFile, bundle.policy, 'utf8');
    await chmod(bundle.serviceFile, 0o777);
    report = await verifyQrexecInstall(bundle);
    assert.equal(report.service.modeMatches, false);
  }
});

test('installer refuses symlink targets', async () => {
  if (process.platform === 'win32') return;
  const bundle = await fixture();
  const target = `${bundle.policyFile}.real`;
  await import('node:fs/promises').then(fs => fs.mkdir(path.dirname(bundle.policyFile), { recursive: true }));
  await writeFile(target, 'safe\n', 'utf8');
  await symlink(target, bundle.policyFile);
  await assert.rejects(() => installQrexecBundle(bundle, { dryRun: false }), /symlink install target/);
});
