import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildReadonlyQrexecDeploymentManifestFromArtifact,
  verifyReadonlyQrexecDeploymentArtifact
} from './qrexec-readonly-deployment-artifact.mjs';

const service = 'dig.ReadonlyProbe';
const sourceQube = 'dig-worker';
const coordinatorQube = 'dig-coordinator';
const serviceUser = 'dig-readonly';
const serviceUid = 2201;
const gitSha = 'e'.repeat(40);
const serviceTarget = '/opt/dig/current/agents/qrexec-readonly-service-process.mjs';

const expected = {
  expectedService: service,
  expectedSourceQube: sourceQube,
  expectedCoordinatorQube: coordinatorQube,
  expectedServiceUser: serviceUser,
  expectedServiceUid: serviceUid,
  expectedGitSha: gitSha,
  expectedServiceTarget: serviceTarget
};

function artifact(overrides = {}) {
  const base = {
    schemaVersion: 1,
    service,
    sourceQube,
    coordinatorQube,
    serviceUser,
    serviceUid,
    gitSha,
    policy: {
      path: '/etc/qubes/policy.d/30-dig-readonly.policy',
      text: `${service} + ${sourceQube} ${coordinatorQube} allow user=${serviceUser}\n${service} * * * deny\n`
    },
    serviceHandler: {
      path: `/usr/local/etc/qubes-rpc/${service}`,
      target: serviceTarget,
      executable: true,
      writableByServiceUser: false,
      targetGitSha: gitSha
    }
  };
  return {
    ...base,
    ...overrides,
    policy: { ...base.policy, ...(overrides.policy ?? {}) },
    serviceHandler: { ...base.serviceHandler, ...(overrides.serviceHandler ?? {}) }
  };
}

test('verified Qubes artifact produces the existing read-only deployment manifest contract', () => {
  const evidence = artifact();
  assert.equal(verifyReadonlyQrexecDeploymentArtifact(evidence, expected), true);
  assert.deepEqual(buildReadonlyQrexecDeploymentManifestFromArtifact(evidence, expected), {
    schemaVersion: 1,
    service,
    coordinatorQube,
    serviceUser,
    serviceUid,
    gitSha,
    readOnly: true,
    allowStateChangingOperations: false
  });
});

test('policy must allow only empty argument from the intended source then deny every other call', () => {
  assert.throws(() => verifyReadonlyQrexecDeploymentArtifact(artifact({
    policy: { text: `${service} * ${sourceQube} ${coordinatorQube} allow user=${serviceUser}\n${service} * * * deny\n` }
  }), expected), /exact allow-then-deny rules/);

  assert.throws(() => verifyReadonlyQrexecDeploymentArtifact(artifact({
    policy: { text: `${service} + * ${coordinatorQube} allow user=${serviceUser}\n${service} * * * deny\n` }
  }), expected), /exact allow-then-deny rules/);

  assert.throws(() => verifyReadonlyQrexecDeploymentArtifact(artifact({
    policy: { text: `${service} + ${sourceQube} ${coordinatorQube} allow user=${serviceUser}\n` }
  }), expected), /exact allow-then-deny rules/);
});

test('additional service-specific rules are rejected even when the required pair exists', () => {
  const text = `${service} + ${sourceQube} ${coordinatorQube} allow user=${serviceUser}\n${service} + other-worker ${coordinatorQube} allow user=${serviceUser}\n${service} * * * deny\n`;
  assert.throws(() => verifyReadonlyQrexecDeploymentArtifact(artifact({ policy: { text } }), expected), /exact allow-then-deny rules/);
});

test('temporary policy location is rejected so evidence survives reboot', () => {
  assert.throws(() => verifyReadonlyQrexecDeploymentArtifact(artifact({
    policy: { path: '/run/qubes/policy.d/30-dig-readonly.policy' }
  }), expected), /persistent Qubes policy file/);
});

test('service handler must be the intended qrexec endpoint and immutable to the service user', () => {
  assert.throws(() => verifyReadonlyQrexecDeploymentArtifact(artifact({
    serviceHandler: { path: '/tmp/dig.ReadonlyProbe' }
  }), expected), /handler path mismatch/);

  assert.throws(() => verifyReadonlyQrexecDeploymentArtifact(artifact({
    serviceHandler: { writableByServiceUser: true }
  }), expected), /must not be writable/);

  assert.throws(() => verifyReadonlyQrexecDeploymentArtifact(artifact({
    serviceHandler: { targetGitSha: 'f'.repeat(40) }
  }), expected), /target git sha mismatch/);
});

test('deployment identity drift is rejected before a manifest can be emitted', () => {
  assert.throws(() => verifyReadonlyQrexecDeploymentArtifact(artifact({ sourceQube: 'wrong-worker' }), expected), /source mismatch/);
  assert.throws(() => verifyReadonlyQrexecDeploymentArtifact(artifact({ serviceUid: serviceUid + 1 }), expected), /service uid mismatch/);
  assert.throws(() => verifyReadonlyQrexecDeploymentArtifact(artifact({ gitSha: 'f'.repeat(40) }), expected), /git sha mismatch/);
});
