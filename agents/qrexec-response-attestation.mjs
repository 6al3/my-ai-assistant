import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

function assertString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be a non-empty string`);
  return value.trim();
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

function assertContext({ keyId, gitSha, service, requestId } = {}) {
  keyId = assertString(keyId, 'keyId');
  gitSha = assertString(gitSha, 'gitSha').toLowerCase();
  service = assertString(service, 'service');
  requestId = assertString(requestId, 'requestId');
  if (!/^[0-9a-f]{40}$/.test(gitSha)) throw new Error('gitSha must be a 40-character hex SHA');
  return { keyId, gitSha, service, requestId };
}

function signingPayload(response, context) {
  return Buffer.from(canonicalJson({ version: 1, context, response }), 'utf8');
}

export function loadResponseAttestationConfig(env = process.env) {
  const privateKeyPem = env.DIG_RESPONSE_ATTESTATION_PRIVATE_KEY;
  const keyId = env.DIG_RESPONSE_ATTESTATION_KEY_ID?.trim();
  const gitSha = env.DIG_GIT_SHA?.trim();
  const service = env.DIG_QREXEC_SERVICE_ID?.trim();
  const configured = [privateKeyPem, keyId, gitSha, service].filter(value => typeof value === 'string' && value.trim() !== '').length;
  if (configured === 0) return null;
  if (configured !== 4) throw new Error('response attestation requires DIG_RESPONSE_ATTESTATION_PRIVATE_KEY, DIG_RESPONSE_ATTESTATION_KEY_ID, DIG_GIT_SHA, and DIG_QREXEC_SERVICE_ID together');
  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('response attestation private key must be Ed25519');
  if (!/^[0-9a-f]{40}$/i.test(gitSha)) throw new Error('DIG_GIT_SHA must be a 40-character hex SHA');
  return { privateKey, keyId, gitSha: gitSha.toLowerCase(), service };
}

export function attestCoordinatorResponse(response, config, { requestId } = {}) {
  if (!response || typeof response !== 'object' || Array.isArray(response) || typeof response.ok !== 'boolean') throw new TypeError('response must be a coordinator response object');
  if (!config?.privateKey) throw new Error('response attestation config is required');
  const context = assertContext({ ...config, requestId });
  const unsignedResponse = structuredClone(response);
  delete unsignedResponse.attestation;
  const signature = sign(null, signingPayload(unsignedResponse, context), config.privateKey).toString('base64');
  return { ...unsignedResponse, attestation: { version: 1, alg: 'Ed25519', ...context, signature } };
}

export function verifyCoordinatorResponseAttestation(response, { publicKeyPem, expectedKeyId, expectedGitSha, expectedService, expectedRequestId } = {}) {
  if (!response || typeof response !== 'object' || Array.isArray(response) || typeof response.ok !== 'boolean') throw new TypeError('response must be a coordinator response object');
  if (!publicKeyPem) throw new Error('publicKeyPem is required');
  const attestation = response.attestation;
  if (!attestation || typeof attestation !== 'object' || Array.isArray(attestation)) throw new Error('response attestation is required');
  if (attestation.version !== 1 || attestation.alg !== 'Ed25519') throw new Error('unsupported response attestation');
  const context = assertContext(attestation);
  if (expectedKeyId != null && context.keyId !== assertString(expectedKeyId, 'expectedKeyId')) throw new Error('response attestation keyId mismatch');
  if (expectedGitSha != null && context.gitSha !== assertString(expectedGitSha, 'expectedGitSha').toLowerCase()) throw new Error('response attestation gitSha mismatch');
  if (expectedService != null && context.service !== assertString(expectedService, 'expectedService')) throw new Error('response attestation service mismatch');
  if (expectedRequestId != null && context.requestId !== assertString(expectedRequestId, 'expectedRequestId')) throw new Error('response attestation requestId mismatch');

  const signature = Buffer.from(assertString(attestation.signature, 'attestation.signature'), 'base64');
  const unsignedResponse = structuredClone(response);
  delete unsignedResponse.attestation;
  const publicKey = createPublicKey(publicKeyPem);
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('response attestation public key must be Ed25519');
  if (!verify(null, signingPayload(unsignedResponse, context), publicKey, signature)) throw new Error('response attestation verification failed');
  return unsignedResponse;
}
