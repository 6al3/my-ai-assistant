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
const uid = 2201;
const keyId = 'deployment-test-key';

function identityContract(overrides = {}) {
  return buildReadonlyServiceIdentityContract({
    service,
    coordinatorQube,
    serviceUser: 'dig-readonly',
    serviceUid: uid,
    configuredServiceUid: uid,
    gitSha,
    ...overrides
  });
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
      expectedServiceUid: uid,
      serviceIdentityContract: identityContract(),
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

test('identity-bound deployment entrypoint qualifies only after contract verification', async () => {
  const { options, calls } = await baseOptions();
  const report = await runIdentityBoundReadonlyQrexecPhase1Qualification(options);
  assert.equal(report.readiness, 'LAB READY');
  assert.equal(report.zeroMutationVerified, true);
  assert.equal(report.attestationVerified, true);
  assert.equal(calls.length, 5);
});

test('service mismatch fails before any qrexec invocation', async () => {
  const { options, calls } = await baseOptions({
    serviceIdentityContract: identityContract({ service: 'dig.OtherProbe' })
  });
  await assert.rejects(() => runIdentityBoundReadonlyQrexecPhase1Qualification(options), /service identity mismatch/);
  assert.equal(calls.length, 0);
});

test('coordinator mismatch fails before any qrexec invocation', async () => {
  const { options, calls } = await baseOptions({
    serviceIdentityContract: identityContract({ coordinatorQube: 'wrong-coordinator' })
  });
  await assert.rejects(() => runIdentityBoundReadonlyQrexecPhase1Qualification(options), /coordinator identity mismatch/);
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
