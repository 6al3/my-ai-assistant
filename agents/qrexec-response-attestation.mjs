import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

function assertString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be a non-empty string`);
  return value.trim();
}

function assertDigest(value, name) {
  const digest = assertString(value, name);
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`${name} must be a lowercase SHA-256 hex digest`);
  return digest;
}

function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('attested response must contain only finite JSON numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw new TypeError('attested response must contain only JSON-compatible values');
}

function assertContext({ keyId, gitSha, service, requestId = null, topologyId = null, calibrationEvidenceDigest = null } = {}) {
  keyId = assertString(keyId, 'keyId');
  gitSha = assertString(gitSha, 'gitSha');
  service = assertString(service, 'service');
  if (!/^[0-9a-f]{40}$/i.test(gitSha)) throw new Error('gitSha must be a 40-character hex SHA');
  if (requestId != null) requestId = assertString(requestId, 'requestId');
  const hasTopology = topologyId != null;
  const hasDigest = calibrationEvidenceDigest != null;
  if (hasTopology !== hasDigest) throw new Error('topologyId and calibrationEvidenceDigest must be provided together');
  if (hasTopology) {
    topologyId = assertString(topologyId, 'topologyId');
    calibrationEvidenceDigest = assertDigest(calibrationEvidenceDigest, 'calibrationEvidenceDigest');
  }
  return {
    keyId,
    gitSha: gitSha.toLowerCase(),
    service,
    ...(requestId == null ? {} : { requestId }),
    ...(hasTopology ? { topologyId, calibrationEvidenceDigest } : {})
  };
}

function signingPayload(response, context) {
  return Buffer.from(canonicalJson({ context, response }), 'utf8');
}

export function loadResponseAttestationConfig(env = process.env) {
  const privateKeyPem = env.DIG_RESPONSE_ATTESTATION_PRIVATE_KEY;
  const keyId = env.DIG_RESPONSE_ATTESTATION_KEY_ID?.trim();
  const gitSha = env.DIG_GIT_SHA?.trim();
  const service = env.DIG_QREXEC_SERVICE_ID?.trim();
  const topologyId = env.DIG_QUBES_TOPOLOGY_ID?.trim() || null;
  const calibrationEvidenceDigest = env.DIG_CALIBRATION_EVIDENCE_DIGEST?.trim() || null;
  const values = [privateKeyPem, keyId, gitSha, service];
  const configured = values.filter(value => typeof value === 'string' && value.trim() !== '').length;
  if (configured === 0) return null;
  if (configured !== values.length) throw new Error('response attestation requires DIG_RESPONSE_ATTESTATION_PRIVATE_KEY, DIG_RESPONSE_ATTESTATION_KEY_ID, DIG_GIT_SHA, and DIG_QREXEC_SERVICE_ID together');
  const context = assertContext({ keyId, gitSha, service, topologyId, calibrationEvidenceDigest });
  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('response attestation private key must be Ed25519');
  return { ...context, privateKey };
}

export function attestCoordinatorResponse(response, config, { requestId = null } = {}) {
  if (!response || typeof response !== 'object' || Array.isArray(response) || typeof response.ok !== 'boolean') throw new TypeError('response must be a coordinator response object');
  if (!config?.privateKey) throw new Error('response attestation config is required');
  const context = assertContext({ ...config, requestId });
  const unsignedResponse = structuredClone(response);
  delete unsignedResponse.attestation;
  const signature = sign(null, signingPayload(unsignedResponse, context), config.privateKey).toString('base64');
  return {
    ...unsignedResponse,
    attestation: {
      alg: 'Ed25519',
      keyId: context.keyId,
      gitSha: context.gitSha,
      service: context.service,
      ...(context.requestId == null ? {} : { requestId: context.requestId }),
      ...(context.topologyId == null ? {} : {
        topologyId: context.topologyId,
        calibrationEvidenceDigest: context.calibrationEvidenceDigest
      }),
      signature
    }
  };
}

export function verifyCoordinatorResponseAttestation(response, {
  publicKeyPem,
  expectedKeyId,
  expectedGitSha,
  expectedService,
  expectedRequestId = null,
  expectedTopologyId = null,
  expectedCalibrationEvidenceDigest = null
} = {}) {
  if (!response || typeof response !== 'object' || Array.isArray(response) || typeof response.ok !== 'boolean') throw new TypeError('response must be a coordinator response object');
  if (!publicKeyPem) throw new Error('publicKeyPem is required');
  const attestation = response.attestation;
  if (!attestation || typeof attestation !== 'object' || Array.isArray(attestation)) throw new Error('response attestation is required');
  if (attestation.alg !== 'Ed25519') throw new Error('unsupported response attestation algorithm');
  const requestId = attestation.requestId == null ? null : attestation.requestId;
  const topologyId = attestation.topologyId == null ? null : attestation.topologyId;
  const calibrationEvidenceDigest = attestation.calibrationEvidenceDigest == null ? null : attestation.calibrationEvidenceDigest;
  const context = assertContext({
    keyId: attestation.keyId,
    gitSha: attestation.gitSha,
    service: attestation.service,
    requestId,
    topologyId,
    calibrationEvidenceDigest
  });
  if (expectedKeyId != null && context.keyId !== assertString(expectedKeyId, 'expectedKeyId')) throw new Error('response attestation keyId mismatch');
  if (expectedGitSha != null && context.gitSha !== assertString(expectedGitSha, 'expectedGitSha').toLowerCase()) throw new Error('response attestation gitSha mismatch');
  if (expectedService != null && context.service !== assertString(expectedService, 'expectedService')) throw new Error('response attestation service mismatch');
  if (expectedRequestId != null) {
    const normalizedExpectedRequestId = assertString(expectedRequestId, 'expectedRequestId');
    if (context.requestId == null) throw new Error('response attestation requestId is required');
    if (context.requestId !== normalizedExpectedRequestId) throw new Error('response attestation requestId mismatch');
  }
  const expectsCalibrationBinding = expectedTopologyId != null || expectedCalibrationEvidenceDigest != null;
  if (expectsCalibrationBinding) {
    if (expectedTopologyId == null || expectedCalibrationEvidenceDigest == null) throw new Error('expectedTopologyId and expectedCalibrationEvidenceDigest must be provided together');
    if (context.topologyId == null) throw new Error('response attestation topologyId is required');
    if (context.topologyId !== assertString(expectedTopologyId, 'expectedTopologyId')) throw new Error('response attestation topologyId mismatch');
    const expectedDigest = assertDigest(expectedCalibrationEvidenceDigest, 'expectedCalibrationEvidenceDigest');
    if (context.calibrationEvidenceDigest !== expectedDigest) throw new Error('response attestation calibrationEvidenceDigest mismatch');
  }
  const signature = Buffer.from(assertString(attestation.signature, 'attestation.signature'), 'base64');
  const unsignedResponse = structuredClone(response);
  delete unsignedResponse.attestation;
  const publicKey = createPublicKey(publicKeyPem);
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('response attestation public key must be Ed25519');
  if (!verify(null, signingPayload(unsignedResponse, context), publicKey, signature)) throw new Error('response attestation verification failed');
  return unsignedResponse;
}
