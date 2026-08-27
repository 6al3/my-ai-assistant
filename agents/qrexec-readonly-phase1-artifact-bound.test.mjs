import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { attestCoordinatorResponse } from './qrexec-response-attestation.mjs';
import { buildReadonlyServiceIdentityContract } from './qrexec-readonly-service-identity-contract.mjs';
import { runArtifactBoundReadonlyQrexecPhase1Qualification } from './qrexec-readonly-phase1-deployment.mjs';

const gitSha = 'a'.repeat(40);
const service = 'dig.ReadonlyProbe';
const sourceQube = 'dig-worker';
const coordinatorQube = 'dig-coordinator';
const serviceUser = 'dig-readonly';
const serviceUid = 2201;
const serviceTarget = '/opt/dig/current/agents/qrexec-readonly-service-process.mjs';
const keyId = 'artifact-bound-test-key';

function deploymentArtifact(overrides = {}) {
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

function identityContract() {
  return buildReadonlyServiceIdentityContract({
    service,
    coordinatorQube,
    serviceUser,
    serviceUid,
    configuredServiceUid: serviceUid,
    gitSha
  });
}

function scenarios() {
  return {
    'intended-service-allowed': { service, payload: '{"requestId":"artifact-ok"}\n' },
    'wrong-service-denied': { service: 'dig.NotAllowed', payload: '{}' },
    'wrong-identity-denied': { service, payload: '{"identity":"stale"}' },
    'auth-failure-denied': { service, payload: '{"mac":"invalid"}' },
    'malformed-framing-denied': { service, payload: '{}\n{}\n' }
  };
}

async function makeOptions(overrides = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const response = attestCoordinatorResponse(
    { ok: true, probe: 'readonly' },
    { privateKey, keyId, gitSha, service },
    { requestId: 'artifact-ok' }
  );
  const calls = [];
  const spawnImpl = (_command, args) => {
    calls.push(args);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = () => {};
    child.kill = () => {};
    queueMicrotask(() => {
      if (args[1] === service) {
        child.stdout.emit('data', Buffer.from(`${JSON.stringify(response)}\n`));
        child.emit('close', 0);
      } else {
        child.emit('close', 126);
      }
    });
    return child;
  };

  return {
    calls,
    options: {
      gitSha,
      runtimeFingerprint: 'node-artifact-bound-test',
      sourceQube,
      coordinatorQube,
      intendedService: service,
      expectedServiceUser: serviceUser,
      expectedServiceUid: serviceUid,
      expectedServiceTarget: serviceTarget,
      serviceIdentityContract: identityContract(),
      deploymentArtifact: deploymentArtifact(),
      scenarios: scenarios(),
      snapshotMutationState: async () => ({ missionStoreDigest: 'm', requestJournalDigest: 'j' }),
      verifyFilesystemEnforcement: async () => ({ enforcementVerified: true }),
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      expectedKeyId: keyId,
      spawnImpl,
      ...overrides
    }
  };
}

test('real deployment artifact is verified and converted into the Phase-1 manifest before qrexec', async () => {
  const { options, calls } = await makeOptions();
  const report = await runArtifactBoundReadonlyQrexecPhase1Qualification(options);
  assert.equal(report.readiness, 'LAB READY');
  assert.equal(report.zeroMutationVerified, true);
  assert.equal(report.attestationVerified, true);
  assert.equal(calls.length, 5);
});

test('broad source policy fails before any qrexec invocation', async () => {
  const { options, calls } = await makeOptions({
    deploymentArtifact: deploymentArtifact({
      policy: { text: `${service} + * ${coordinatorQube} allow user=${serviceUser}\n${service} * * * deny\n` }
    })
  });
  await assert.rejects(() => runArtifactBoundReadonlyQrexecPhase1Qualification(options), /exact allow-then-deny rules/);
  assert.equal(calls.length, 0);
});

test('writable service handler fails before any qrexec invocation', async () => {
  const { options, calls } = await makeOptions({
    deploymentArtifact: deploymentArtifact({ serviceHandler: { writableByServiceUser: true } })
  });
  await assert.rejects(() => runArtifactBoundReadonlyQrexecPhase1Qualification(options), /must not be writable/);
  assert.equal(calls.length, 0);
});

test('service target SHA drift fails before any qrexec invocation', async () => {
  const { options, calls } = await makeOptions({
    deploymentArtifact: deploymentArtifact({ serviceHandler: { targetGitSha: 'b'.repeat(40) } })
  });
  await assert.rejects(() => runArtifactBoundReadonlyQrexecPhase1Qualification(options), /target git sha mismatch/);
  assert.equal(calls.length, 0);
});
