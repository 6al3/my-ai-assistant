import { Buffer } from 'node:buffer';
import process from 'node:process';
import { WorkerEnvelopeVerifier } from './worker-transport-envelope.mjs';
import { attestCoordinatorResponse } from './qrexec-response-attestation.mjs';

const PROBE_OP = 'probe';

function required(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required`);
  return value.trim();
}

function sha(value, name) {
  const normalized = required(value, name).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(normalized)) throw new Error(`${name} must be a 40-character hex SHA`);
  return normalized;
}

function decodePrivateKey(value) {
  const pem = Buffer.from(required(value, 'DIG_QREXEC_ATTESTATION_PRIVATE_KEY_B64'), 'base64').toString('utf8');
  if (!pem.includes('PRIVATE KEY')) throw new Error('invalid attestation private key');
  return pem;
}

export function loadReadonlyProbeConfig(env = process.env) {
  const service = required(env.DIG_QREXEC_SERVICE, 'DIG_QREXEC_SERVICE');
  const gitSha = sha(env.DIG_QREXEC_GIT_SHA, 'DIG_QREXEC_GIT_SHA');
  const keyId = required(env.DIG_QREXEC_ATTESTATION_KEY_ID, 'DIG_QREXEC_ATTESTATION_KEY_ID');
  return {
    secret: required(env.DIG_QREXEC_TRANSPORT_SECRET, 'DIG_QREXEC_TRANSPORT_SECRET'),
    identity: { service, gitSha, keyId },
    attestationConfig: {
      privateKey: decodePrivateKey(env.DIG_QREXEC_ATTESTATION_PRIVATE_KEY_B64),
      service,
      gitSha,
      keyId
    }
  };
}

function validateProbeBody(body, expected) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('probe body must be an object');
  const requested = {
    service: required(body.service, 'body.service'),
    gitSha: sha(body.gitSha, 'body.gitSha'),
    keyId: required(body.keyId, 'body.keyId')
  };
  if (requested.service !== expected.service) throw new Error('probe service identity mismatch');
  if (requested.gitSha !== expected.gitSha) throw new Error('probe git identity mismatch');
  if (requested.keyId !== expected.keyId) throw new Error('probe attestation key identity mismatch');
  return requested;
}

export function handleReadonlyProbeEnvelope(envelope, { secret, identity, attestationConfig, now = Date.now } = {}) {
  const verified = new WorkerEnvelopeVerifier({ secret, now }).verify(envelope);
  if (verified.op !== PROBE_OP) throw new Error('unsupported read-only probe operation');
  validateProbeBody(verified.body, identity);
  const response = {
    ok: true,
    op: PROBE_OP,
    value: {
      protocolVersion: 1,
      readOnly: true,
      service: identity.service,
      gitSha: identity.gitSha,
      keyId: identity.keyId
    }
  };
  return attestCoordinatorResponse(response, attestationConfig, { requestId: verified.requestId });
}
