import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  assembleReadonlyQrexecDeploymentArtifact,
  collectCoordinatorReadonlyServiceEvidence
} from './qrexec-readonly-deployment-evidence-collector.mjs';
import { verifyReadonlyQrexecDeploymentArtifact } from './qrexec-readonly-deployment-artifact.mjs';

const service = 'dig.ReadonlyProbe';
const sourceQube = 'dig-worker';
const coordinatorQube = 'dig-coordinator';
const serviceUser = 'dig-readonly';
const serviceUid = 2201;
const gitSha = 'a'.repeat(40);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dig-qrexec-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const rpcDir = join(root, 'usr-local-etc-qubes-rpc');
  const targetDir = join(root, 'opt-dig-current-agents');
  await mkdir(rpcDir, { recursive: true, mode: 0o555 });
  await mkdir(targetDir, { recursive: true, mode: 0o555 });
  const target = join(targetDir, 'qrexec-readonly-service-process.mjs');
  await writeFile(target, '#!/usr/bin/env node\n', { mode: 0o555 });
  const handler = join(rpcDir, service);
  await symlink(target, handler);
  const marker = join(root, 'deployment.json');
  await writeFile(marker, JSON.stringify({ schemaVersion: 1, service, serviceTarget: target, gitSha }), { mode: 0o444 });
  await chmod(marker, 0o444);
  return { root, rpcDir, targetDir, target, handler, marker };
}

test('assembly preserves independently captured identity and policy evidence', () => {
  const policyEvidence = {
    path: '/etc/qubes/policy.d/30-dig-readonly.policy',
    text: `${service} + ${sourceQube} ${coordinatorQube} allow user=${serviceUser}\n${service} * * * deny\n`
  };
  const coordinatorEvidence = {
    serviceUser,
    serviceUid,
    effectiveUid: serviceUid,
    effectiveGid: 2201,
    serviceHandler: {
      path: `/usr/local/etc/qubes-rpc/${service}`,
      target: '/opt/dig/current/agents/qrexec-readonly-service-process.mjs',
      executable: true,
      writableByServiceUser: false,
      targetGitSha: gitSha
    }
  };
  const artifact = assembleReadonlyQrexecDeploymentArtifact({ service, sourceQube, coordinatorQube, serviceUser, serviceUid, gitSha, policyEvidence, coordinatorEvidence });
  assert.equal(verifyReadonlyQrexecDeploymentArtifact(artifact, {
    expectedService: service,
    expectedSourceQube: sourceQube,
    expectedCoordinatorQube: coordinatorQube,
    expectedServiceUser: serviceUser,
    expectedServiceUid: serviceUid,
    expectedGitSha: gitSha,
    expectedServiceTarget: coordinatorEvidence.serviceHandler.target
  }), true);
});

test('collector fails closed when kernel effective uid is not the dedicated service uid', async (t) => {
  const f = await fixture(t);
  await assert.rejects(() => collectCoordinatorReadonlyServiceEvidence({
    service,
    serviceUser,
    serviceUid,
    expectedGitSha: gitSha,
    serviceHandlerPath: f.handler,
    deploymentMarkerPath: f.marker,
    getEuid: () => serviceUid + 1,
    getEgid: () => serviceUid
  }), /effective uid does not match/);
});

test('collector rejects mutable or inconsistent deployment marker before emitting evidence', async (t) => {
  const f = await fixture(t);
  await writeFile(f.marker, JSON.stringify({ schemaVersion: 1, service, serviceTarget: f.target, gitSha: 'b'.repeat(40) }), { mode: 0o444 });
  await chmod(f.marker, 0o444);
  await assert.rejects(() => collectCoordinatorReadonlyServiceEvidence({
    service,
    serviceUser,
    serviceUid,
    expectedGitSha: gitSha,
    serviceHandlerPath: f.handler,
    deploymentMarkerPath: f.marker,
    getEuid: () => serviceUid,
    getEgid: () => serviceUid
  }), /git sha mismatch/);
});

test('assembly rejects coordinator evidence collected under a different service identity', () => {
  assert.throws(() => assembleReadonlyQrexecDeploymentArtifact({
    service,
    sourceQube,
    coordinatorQube,
    serviceUser,
    serviceUid,
    gitSha,
    policyEvidence: { path: '/etc/qubes/policy.d/30-dig-readonly.policy', text: 'x' },
    coordinatorEvidence: { serviceUser, serviceUid, effectiveUid: serviceUid + 1, serviceHandler: {} }
  }), /effective uid mismatch/);
});
