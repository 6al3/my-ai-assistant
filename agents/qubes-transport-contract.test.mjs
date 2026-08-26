import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { signWorkerEnvelope, WorkerEnvelopeVerifier } from './worker-transport-envelope.mjs';
import { attestCoordinatorResponse, verifyCoordinatorResponseAttestation } from './qrexec-response-attestation.mjs';

const SECRET = '0123456789abcdef0123456789abcdef';
const NOW = 1_800_000_000_000;
const GIT_SHA = 'a'.repeat(40);
const SERVICE = 'dig.Coordinator';
const KEY_ID = 'dig-lab-ed25519-1';

function keys() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKey,
    publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString()
  };
}

test('canonical HMAC transport preserves lease-fencing fields across JSON key ordering', () => {
  const signed = signWorkerEnvelope({
    requestId: 'req-heartbeat-1',
    issuedAt: NOW,
    op: 'heartbeat',
    body: { workerId: 'worker-a', missionId: 'mission-1', leaseToken: 'lease-token-1', metadata: { z: 2, a: 1 } },
    secret: SECRET
  });
  // Simulate another language/runtime reordering object keys while preserving JSON meaning.
  const reordered = {
    mac: signed.mac,
    body: { metadata: { a: 1, z: 2 }, leaseToken: 'lease-token-1', missionId: 'mission-1', workerId: 'worker-a' },
    op: signed.op,
    issuedAt: signed.issuedAt,
    requestId: signed.requestId,
    version: signed.version
  };
  const verified = new WorkerEnvelopeVerifier({ secret: SECRET, now: () => NOW }).verify(reordered);
  assert.equal(verified.body.leaseToken, 'lease-token-1');
  assert.equal(verified.body.missionId, 'mission-1');
});

test('transport rejects lease-token, operation, body and timestamp tampering', () => {
  const signed = signWorkerEnvelope({
    requestId: 'req-complete-1',
    issuedAt: NOW,
    op: 'complete',
    body: { missionId: 'mission-1', workerId: 'worker-a', leaseToken: 'lease-token-1', result: { ok: true } },
    secret: SECRET
  });
  const mutations = [
    { ...signed, op: 'fail' },
    { ...signed, issuedAt: NOW + 1 },
    { ...signed, body: { ...signed.body, leaseToken: 'stale-token' } },
    { ...signed, body: { ...signed.body, result: { ok: false } } }
  ];
  for (const envelope of mutations) {
    assert.throws(() => new WorkerEnvelopeVerifier({ secret: SECRET, now: () => NOW }).verify(envelope), /authentication failed/);
  }
});

test('transport rejects replay and clock skew before coordinator mutation', () => {
  const verifier = new WorkerEnvelopeVerifier({ secret: SECRET, maxSkewMs: 5_000, now: () => NOW });
  const signed = signWorkerEnvelope({ requestId: 'req-claim-1', issuedAt: NOW, op: 'claim', body: { workerId: 'worker-a' }, secret: SECRET });
  assert.equal(verifier.verify(signed).requestId, 'req-claim-1');
  assert.throws(() => verifier.verify(signed), /replay detected/);
  const expired = signWorkerEnvelope({ requestId: 'req-old', issuedAt: NOW - 5_001, op: 'stats', secret: SECRET });
  assert.throws(() => new WorkerEnvelopeVerifier({ secret: SECRET, maxSkewMs: 5_000, now: () => NOW }).verify(expired), /expired/);
});

test('Ed25519 coordinator response is bound to request, deployment SHA, service and key id', () => {
  const { privateKey, publicKeyPem } = keys();
  const config = { privateKey, keyId: KEY_ID, gitSha: GIT_SHA, service: SERVICE };
  const attested = attestCoordinatorResponse({ ok: true, result: { missionId: 'mission-1', status: 'running' } }, config, { requestId: 'req-claim-1' });
  assert.deepEqual(verifyCoordinatorResponseAttestation(attested, {
    publicKeyPem,
    expectedKeyId: KEY_ID,
    expectedGitSha: GIT_SHA,
    expectedService: SERVICE,
    expectedRequestId: 'req-claim-1'
  }), { ok: true, result: { missionId: 'mission-1', status: 'running' } });
  assert.throws(() => verifyCoordinatorResponseAttestation(attested, { publicKeyPem, expectedRequestId: 'req-other' }), /requestId mismatch/);
  assert.throws(() => verifyCoordinatorResponseAttestation(attested, { publicKeyPem, expectedService: 'dig.Other' }), /service mismatch/);
  assert.throws(() => verifyCoordinatorResponseAttestation(attested, { publicKeyPem, expectedGitSha: 'b'.repeat(40) }), /gitSha mismatch/);
});

test('response attestation rejects payload modification and non-Ed25519 keys', () => {
  const { privateKey, publicKeyPem } = keys();
  const attested = attestCoordinatorResponse({ ok: true, result: { total: 1 } }, { privateKey, keyId: KEY_ID, gitSha: GIT_SHA, service: SERVICE }, { requestId: 'req-stats-1' });
  const tampered = structuredClone(attested);
  tampered.result.total = 2;
  assert.throws(() => verifyCoordinatorResponseAttestation(tampered, { publicKeyPem }), /verification failed/);
  assert.throws(() => signWorkerEnvelope({ requestId: 'bad-json', issuedAt: NOW, op: 'stats', body: { value: Number.NaN }, secret: SECRET }), /finite JSON numbers/);
});
