import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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

function filesystemEnforcementPass() {
  return async () => ({ enforcementVerified: true });
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
    verifyFilesystemEnforcement: filesystemEnforcementPass(),
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

test('builds coordinator mutation snapshots directly from MissionStore and request-journal paths', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dig-qrexec-phase1-runner-'));
  try {
    const missionStorePath = path.join(root, 'missions.json');
    const requestJournalPath = path.join(root, 'requests.json');
    await writeFile(missionStorePath, '{"missions":[]}\n');
    await writeFile(requestJournalPath, '{"requests":[]}\n');

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
      missionStorePath,
      requestJournalPath,
      verifyFilesystemEnforcement: filesystemEnforcementPass(),
      publicKeyPem,
      expectedKeyId: keyId,
      spawnImpl: fakeSpawn({ allowedResponse })
    });

    assert.equal(report.readiness, 'LAB READY');
    assert.equal(report.zeroMutationVerified, true);
    assert.match(report.missionStoreBefore, /^[a-f0-9]{64}$/);
    assert.match(report.requestJournalBefore, /^[a-f0-9]{64}$/);
    assert.equal(report.missionStoreBefore, report.missionStoreAfter);
    assert.equal(report.requestJournalBefore, report.requestJournalAfter);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('fails closed when mutation-state paths are missing and no snapshot function is injected', async () => {
  const { publicKeyPem } = keyMaterial();
  await assert.rejects(() => runReadonlyQrexecPhase1Qualification({
    gitSha,
    runtimeFingerprint: 'node-test-runtime',
    sourceQube: 'dig-worker',
    coordinatorQube: 'dig-coordinator',
    intendedService: service,
    scenarios: scenarios(),
    publicKeyPem,
    expectedKeyId: keyId
  }), /missionStorePath is required/);
});

test('fails closed before qrexec when read-only filesystem enforcement is not verified', async () => {
  const { publicKeyPem } = keyMaterial();
  await assert.rejects(() => runReadonlyQrexecPhase1Qualification({
    gitSha,
    runtimeFingerprint: 'node-test-runtime',
    sourceQube: 'dig-worker',
    coordinatorQube: 'dig-coordinator',
    intendedService: service,
    scenarios: scenarios(),
    snapshotMutationState: snapshots(),
    verifyFilesystemEnforcement: async () => ({ enforcementVerified: false }),
    publicKeyPem,
    expectedKeyId: keyId
  }), /read-only filesystem enforcement was not verified/);
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
    verifyFilesystemEnforcement: filesystemEnforcementPass(),
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
    verifyFilesystemEnforcement: filesystemEnforcementPass(),
    publicKeyPem,
    expectedKeyId: keyId
  }), /scenario wrong-service-denied is required/);
});
