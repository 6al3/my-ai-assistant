import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { attestCoordinatorResponse } from './qrexec-response-attestation.mjs';
import { runReadonlyQrexecPhase1Qualification } from './qrexec-readonly-phase1-runner.mjs';

const gitSha = 'a'.repeat(40);
const keyId = 'phase1-test-key';
const service = 'dig.ReadonlyProbe';

function keyMaterial() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKey,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString()
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

function fakeSpawn({ allowedResponse }) {
  return (_command, args, _options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = () => {};
    child.kill = () => {};
    queueMicrotask(() => {
      if (args[1] === service && allowedResponse) {
        child.stdout.emit('data', Buffer.from(`${JSON.stringify(allowedResponse)}\n`));
        child.emit('close', 0);
      } else {
        child.emit('close', 126);
      }
    });
    return child;
  };
}

function snapshots() {
  return async () => ({ missionStoreDigest: 'mission-stable', requestJournalDigest: 'journal-stable' });
}

test('composes real qrexec invoker observations into a schema-v2 zero-mutation qualification report', async () => {
  const { privateKey, publicKeyPem } = keyMaterial();
  const allowedResponse = attestCoordinatorResponse(
    { ok: true, probe: 'readonly' },
    { privateKey, keyId, gitSha, service },
    { requestId: 'phase1-ok' }
  );

  const report = await runReadonlyQrexecPhase1Qualification({
    gitSha,
    runtimeFingerprint: 'node-test-runtime',
    sourceQube: 'dig-worker',
    coordinatorQube: 'dig-coordinator',
    intendedService: service,
    scenarios: scenarios(),
    snapshotMutationState: snapshots(),
    publicKeyPem,
    expectedKeyId: keyId,
    spawnImpl: fakeSpawn({ allowedResponse })
  });

  assert.equal(report.schemaVersion, 2);
  assert.equal(report.readiness, 'LAB READY');
  assert.equal(report.zeroMutationVerified, true);
  assert.equal(report.attestationVerified, true);
  assert.equal(report.scenarios['intended-service-allowed'].outcome, 'allowed');
  for (const name of ['wrong-service-denied', 'wrong-identity-denied', 'auth-failure-denied', 'malformed-framing-denied']) {
    assert.equal(report.scenarios[name].outcome, 'denied');
  }
});

test('fails closed when the allowed response attestation is bound to the wrong deployment identity', async () => {
  const { privateKey, publicKeyPem } = keyMaterial();
  const allowedResponse = attestCoordinatorResponse(
    { ok: true, probe: 'readonly' },
    { privateKey, keyId, gitSha: 'b'.repeat(40), service },
    { requestId: 'phase1-ok' }
  );

  await assert.rejects(() => runReadonlyQrexecPhase1Qualification({
    gitSha,
    runtimeFingerprint: 'node-test-runtime',
    sourceQube: 'dig-worker',
    coordinatorQube: 'dig-coordinator',
    intendedService: service,
    scenarios: scenarios(),
    snapshotMutationState: snapshots(),
    publicKeyPem,
    expectedKeyId: keyId,
    spawnImpl: fakeSpawn({ allowedResponse })
  }), /gitSha mismatch/);
});

test('rejects incomplete scenario wiring before invoking qrexec', async () => {
  const { publicKeyPem } = keyMaterial();
  await assert.rejects(() => runReadonlyQrexecPhase1Qualification({
    gitSha,
    runtimeFingerprint: 'node-test-runtime',
    sourceQube: 'dig-worker',
    coordinatorQube: 'dig-coordinator',
    intendedService: service,
    scenarios: { 'intended-service-allowed': { service, payload: '{}' } },
    snapshotMutationState: snapshots(),
    publicKeyPem,
    expectedKeyId: keyId
  }), /scenario wrong-service-denied is required/);
});
