import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { attestCoordinatorResponse } from './qrexec-response-attestation.mjs';
import { buildReadonlyServiceIdentityContract } from './qrexec-readonly-service-identity-contract.mjs';
import { runIdentityBoundReadonlyQrexecPhase1Qualification } from './qrexec-readonly-phase1-deployment.mjs';

const gitSha = 'c'.repeat(40);
const service = 'dig.ReadonlyProbe';
const coordinatorQube = 'dig-coordinator';
const serviceUser = 'dig-readonly';
const uid = 2201;
const keyId = 'deployment-test-key';

function identityContract(overrides = {}) {
  return buildReadonlyServiceIdentityContract({
    service,
    coordinatorQube,
    serviceUser,
    serviceUid: uid,
    configuredServiceUid: uid,
    gitSha,
    ...overrides
  });
}

function deploymentManifest(overrides = {}) {
  return {
    schemaVersion: 1,
    service,
    coordinatorQube,
    serviceUser,
    serviceUid: uid,
    gitSha,
    readOnly: true,
    allowStateChangingOperations: false,
    ...overrides
  };
}

function scenarios() {
  return {
    'intended-service-allowed': { service, payload: '{"requestId":"phase1-ok"}\n' },
    'wrong-service-denied': { service: 'dig.NotAllowed', payload: '{}' },
    'wrong-identity-denied': { service, payload: '{"identity":"stale"}' },
    'auth-failure-denied': { service, payload: '{"mac":"invalid"}' },
    'malformed-framing-denied': { service, payload: '{}\n{}\n' }
  };
}

function fakeSpawn(allowedResponse, calls) {
  return (_command, args) => {
    calls.push(args);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = () => {};
    child.kill = () => {};
    queueMicrotask(() => {
      if (args[1] === service) {
        child.stdout.emit('data', Buffer.from(`${JSON.stringify(allowedResponse)}\n`));
        child.emit('close', 0);
      } else {
        child.emit('close', 126);
      }
    });
    return child;
  };
}

function stableSnapshots() {
  return async () => ({ missionStoreDigest: 'mission-stable', requestJournalDigest: 'journal-stable' });
}

function filesystemPass() {
  return async () => ({ enforcementVerified: true });
}

function keyMaterial() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKey,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString()
  };
}

async function baseOptions(overrides = {}) {
  const { privateKey, publicKeyPem } = keyMaterial();
  const allowedResponse = attestCoordinatorResponse(
    { ok: true, probe: 'readonly' },
    { privateKey, keyId, gitSha, service },
    { requestId: 'phase1-ok' }
  );
  const calls = [];
  return {
    options: {
      gitSha,
      runtimeFingerprint: 'node-deployment-test',
      sourceQube: 'dig-worker',
      coordinatorQube,
      intendedService: service,
      expectedServiceUser: serviceUser,
      expectedServiceUid: uid,
      serviceIdentityContract: identityContract(),
      deploymentManifest: deploymentManifest(),
      scenarios: scenarios(),
      snapshotMutationState: stableSnapshots(),
      verifyFilesystemEnforcement: filesystemPass(),
      publicKeyPem,
      expectedKeyId: keyId,
      spawnImpl: fakeSpawn(allowedResponse, calls),
      ...overrides
    },
    calls
  };
}

test('identity-bound deployment entrypoint qualifies only after identity and manifest verification', async () => {
  const { options, calls } = await baseOptions();
  const report = await runIdentityBoundReadonlyQrexecPhase1Qualification(options);
  assert.equal(report.readiness, 'LAB READY');
  assert.equal(report.zeroMutationVerified, true);
  assert.equal(report.attestationVerified, true);
  assert.equal(calls.length, 5);
});

test('service mismatch fails before any qrexec invocation', async () => {
  const { options, calls } = await baseOptions({ serviceIdentityContract: identityContract({ service: 'dig.OtherProbe' }) });
  await assert.rejects(() => runIdentityBoundReadonlyQrexecPhase1Qualification(options), /service identity mismatch/);
  assert.equal(calls.length, 0);
});

test('coordinator mismatch fails before any qrexec invocation', async () => {
  const { options, calls } = await baseOptions({ serviceIdentityContract: identityContract({ coordinatorQube: 'wrong-coordinator' }) });
  await assert.rejects(() => runIdentityBoundReadonlyQrexecPhase1Qualification(options), /coordinator identity mismatch/);
  assert.equal(calls.length, 0);
});

test('service user mismatch fails before any qrexec invocation', async () => {
  const { options, calls } = await baseOptions({ expectedServiceUser: 'unexpected-service-user' });
  await assert.rejects(() => runIdentityBoundReadonlyQrexecPhase1Qualification(options), /service user identity mismatch/);
  assert.equal(calls.length, 0);
});

test('non-root verification tamper fails before any qrexec invocation', async () => {
  const { options, calls } = await baseOptions();
  options.serviceIdentityContract = { ...options.serviceIdentityContract, nonRootVerified: false };
  await assert.rejects(() => runIdentityBoundReadonlyQrexecPhase1Qualification(options), /non-root identity was not verified/);
  assert.equal(calls.length, 0);
});

test('uid mismatch fails before any qrexec invocation', async () => {
  const { options, calls } = await baseOptions({ expectedServiceUid: uid + 1 });
  await assert.rejects(() => runIdentityBoundReadonlyQrexecPhase1Qualification(options), /service uid mismatch/);
  assert.equal(calls.length, 0);
});

test('git sha mismatch fails before any qrexec invocation', async () => {
  const { options, calls } = await baseOptions({ gitSha: 'd'.repeat(40) });
  await assert.rejects(() => runIdentityBoundReadonlyQrexecPhase1Qualification(options), /service deployment git sha mismatch/);
  assert.equal(calls.length, 0);
});

test('missing identity contract fails closed before qrexec', async () => {
  const { options, calls } = await baseOptions({ serviceIdentityContract: undefined });
  await assert.rejects(() => runIdentityBoundReadonlyQrexecPhase1Qualification(options), /invalid read-only qrexec service identity contract/);
  assert.equal(calls.length, 0);
});

test('missing deployment manifest fails closed before qrexec', async () => {
  const { options, calls } = await baseOptions({ deploymentManifest: undefined });
  await assert.rejects(() => runIdentityBoundReadonlyQrexecPhase1Qualification(options), /invalid read-only qrexec deployment manifest/);
  assert.equal(calls.length, 0);
});

test('manifest service mismatch fails before any qrexec invocation', async () => {
  const { options, calls } = await baseOptions({ deploymentManifest: deploymentManifest({ service: 'dig.OtherProbe' }) });
  await assert.rejects(() => runIdentityBoundReadonlyQrexecPhase1Qualification(options), /deployment manifest service mismatch/);
  assert.equal(calls.length, 0);
});

test('manifest coordinator mismatch fails before any qrexec invocation', async () => {
  const { options, calls } = await baseOptions({ deploymentManifest: deploymentManifest({ coordinatorQube: 'wrong-coordinator' }) });
  await assert.rejects(() => runIdentityBoundReadonlyQrexecPhase1Qualification(options), /deployment manifest coordinator mismatch/);
  assert.equal(calls.length, 0);
});

test('manifest user or uid drift fails before any qrexec invocation', async () => {
  const first = await baseOptions({ deploymentManifest: deploymentManifest({ serviceUser: 'wrong-user' }) });
  await assert.rejects(() => runIdentityBoundReadonlyQrexecPhase1Qualification(first.options), /deployment manifest service user mismatch/);
  assert.equal(first.calls.length, 0);
  const second = await baseOptions({ deploymentManifest: deploymentManifest({ serviceUid: uid + 1 }) });
  await assert.rejects(() => runIdentityBoundReadonlyQrexecPhase1Qualification(second.options), /deployment manifest service uid mismatch/);
  assert.equal(second.calls.length, 0);
});

test('manifest sha drift fails before any qrexec invocation', async () => {
  const { options, calls } = await baseOptions({ deploymentManifest: deploymentManifest({ gitSha: 'd'.repeat(40) }) });
  await assert.rejects(() => runIdentityBoundReadonlyQrexecPhase1Qualification(options), /deployment manifest git sha mismatch/);
  assert.equal(calls.length, 0);
});

test('manifest must remain read-only and deny state-changing operations', async () => {
  const writable = await baseOptions({ deploymentManifest: deploymentManifest({ readOnly: false }) });
  await assert.rejects(() => runIdentityBoundReadonlyQrexecPhase1Qualification(writable.options), /invalid read-only qrexec deployment manifest/);
  assert.equal(writable.calls.length, 0);
  const mutable = await baseOptions({ deploymentManifest: deploymentManifest({ allowStateChangingOperations: true }) });
  await assert.rejects(() => runIdentityBoundReadonlyQrexecPhase1Qualification(mutable.options), /must deny state-changing operations/);
  assert.equal(mutable.calls.length, 0);
});
