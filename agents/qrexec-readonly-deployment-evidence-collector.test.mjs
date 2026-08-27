import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assembleReadonlyQrexecDeploymentArtifact,
  collectCoordinatorReadonlyServiceEvidence,
  collectDom0ReadonlyPolicyEvidence
} from './qrexec-readonly-deployment-evidence-collector.mjs';
import { verifyReadonlyQrexecDeploymentArtifact } from './qrexec-readonly-deployment-artifact.mjs';

const service = 'dig.ReadonlyProbe';
const sourceQube = 'dig-worker';
const coordinatorQube = 'dig-coordinator';
const serviceUser = 'dig-readonly';
const serviceUid = 2201;
const gitSha = 'a'.repeat(40);

function validEvidence() {
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
  return { policyEvidence, coordinatorEvidence };
}

test('assembly preserves independently captured identity and policy evidence', () => {
  const { policyEvidence, coordinatorEvidence } = validEvidence();
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

test('collector fails closed on wrong effective uid before any handler inspection', async () => {
  await assert.rejects(() => collectCoordinatorReadonlyServiceEvidence({
    service,
    serviceUser,
    serviceUid,
    expectedGitSha: gitSha,
    serviceHandlerPath: `/usr/local/etc/qubes-rpc/${service}`,
    deploymentMarkerPath: '/opt/dig/current/.dig-deployment.json',
    getEuid: () => serviceUid + 1,
    getEgid: () => serviceUid
  }), /effective uid does not match/);
});

test('collector does not permit test or deployment callers to bypass canonical qrexec handler paths', async () => {
  await assert.rejects(() => collectCoordinatorReadonlyServiceEvidence({
    service,
    serviceUser,
    serviceUid,
    expectedGitSha: gitSha,
    serviceHandlerPath: '/tmp/dig.ReadonlyProbe',
    deploymentMarkerPath: '/opt/dig/current/.dig-deployment.json',
    getEuid: () => serviceUid,
    getEgid: () => serviceUid
  }), /service handler path mismatch/);
});

test('dom0 collector rejects transient or non-policy locations before reading them', async () => {
  await assert.rejects(() => collectDom0ReadonlyPolicyEvidence({
    policyPath: '/run/qubes/policy.d/30-dig-readonly.policy'
  }), /persistent Qubes policy file/);
  await assert.rejects(() => collectDom0ReadonlyPolicyEvidence({
    policyPath: '/tmp/30-dig-readonly.policy'
  }), /persistent Qubes policy file/);
});

test('assembly rejects coordinator evidence collected under a different service identity', () => {
  const { policyEvidence, coordinatorEvidence } = validEvidence();
  assert.throws(() => assembleReadonlyQrexecDeploymentArtifact({
    service,
    sourceQube,
    coordinatorQube,
    serviceUser,
    serviceUid,
    gitSha,
    policyEvidence,
    coordinatorEvidence: { ...coordinatorEvidence, effectiveUid: serviceUid + 1 }
  }), /effective uid mismatch/);
});
