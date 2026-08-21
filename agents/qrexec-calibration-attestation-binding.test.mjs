import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  attestCoordinatorResponse,
  loadResponseAttestationConfig,
  verifyCoordinatorResponseAttestation
} from './qrexec-response-attestation.mjs';

const GIT_SHA = 'a'.repeat(40);
const SERVICE_ID = 'dig.Coordinator';
const KEY_ID = 'dig-lab-ed25519-1';
const TOPOLOGY_ID = 'q2-fused';
const CALIBRATION_DIGEST = 'b'.repeat(64);

function keyMaterial() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString()
  };
}

function config(privateKeyPem, overrides = {}) {
  return loadResponseAttestationConfig({
    DIG_RESPONSE_ATTESTATION_PRIVATE_KEY: privateKeyPem,
    DIG_RESPONSE_ATTESTATION_KEY_ID: KEY_ID,
    DIG_GIT_SHA: GIT_SHA,
    DIG_QREXEC_SERVICE_ID: SERVICE_ID,
    DIG_QUBES_TOPOLOGY_ID: TOPOLOGY_ID,
    DIG_CALIBRATION_EVIDENCE_DIGEST: CALIBRATION_DIGEST,
    ...overrides
  });
}

test('Ed25519 response attestation binds calibrated topology and evidence digest', () => {
  const { privateKeyPem, publicKeyPem } = keyMaterial();
  const requestId = randomUUID();
  const attested = attestCoordinatorResponse({ ok: true, result: { total: 1 } }, config(privateKeyPem), { requestId });

  assert.equal(attested.attestation.topologyId, TOPOLOGY_ID);
  assert.equal(attested.attestation.calibrationEvidenceDigest, CALIBRATION_DIGEST);
  assert.deepEqual(verifyCoordinatorResponseAttestation(attested, {
    publicKeyPem,
    expectedKeyId: KEY_ID,
    expectedGitSha: GIT_SHA,
    expectedService: SERVICE_ID,
    expectedRequestId: requestId,
    expectedTopologyId: TOPOLOGY_ID,
    expectedCalibrationEvidenceDigest: CALIBRATION_DIGEST
  }), { ok: true, result: { total: 1 } });
});

test('calibration-bound attestation rejects wrong topology, wrong digest, and legacy binding', () => {
  const { privateKeyPem, publicKeyPem } = keyMaterial();
  const requestId = randomUUID();
  const attested = attestCoordinatorResponse({ ok: true, result: null }, config(privateKeyPem), { requestId });
  const expected = {
    publicKeyPem,
    expectedKeyId: KEY_ID,
    expectedGitSha: GIT_SHA,
    expectedService: SERVICE_ID,
    expectedRequestId: requestId,
    expectedTopologyId: TOPOLOGY_ID,
    expectedCalibrationEvidenceDigest: CALIBRATION_DIGEST
  };

  assert.throws(() => verifyCoordinatorResponseAttestation(attested, { ...expected, expectedTopologyId: 'q4-isolated' }), /topologyId mismatch/);
  assert.throws(() => verifyCoordinatorResponseAttestation(attested, { ...expected, expectedCalibrationEvidenceDigest: 'c'.repeat(64) }), /calibrationEvidenceDigest mismatch/);

  const legacy = attestCoordinatorResponse({ ok: true, result: null }, loadResponseAttestationConfig({
    DIG_RESPONSE_ATTESTATION_PRIVATE_KEY: privateKeyPem,
    DIG_RESPONSE_ATTESTATION_KEY_ID: KEY_ID,
    DIG_GIT_SHA: GIT_SHA,
    DIG_QREXEC_SERVICE_ID: SERVICE_ID
  }), { requestId });
  assert.throws(() => verifyCoordinatorResponseAttestation(legacy, expected), /topologyId is required/);
});

test('response attestation calibration binding is all-or-none and digest is strict', () => {
  const { privateKeyPem } = keyMaterial();
  assert.throws(() => config(privateKeyPem, { DIG_CALIBRATION_EVIDENCE_DIGEST: '' }), /provided together/);
  assert.throws(() => config(privateKeyPem, { DIG_QUBES_TOPOLOGY_ID: '', DIG_CALIBRATION_EVIDENCE_DIGEST: CALIBRATION_DIGEST }), /provided together/);
  assert.throws(() => config(privateKeyPem, { DIG_CALIBRATION_EVIDENCE_DIGEST: 'ABC' }), /lowercase SHA-256/);
});
