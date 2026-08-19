import { randomUUID } from 'node:crypto';
import { createQrexecProcessTransport } from './qubes-qrexec-campaign-harness.mjs';
import { signWorkerEnvelope } from './worker-transport-envelope.mjs';

function requireString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required for qualification preflight`);
  return value.trim();
}

export function validateQualificationPreflightEnvironment(env = process.env) {
  const sourceQube = requireString(env.DIG_SOURCE_QUBE || env.DIG_QREXEC_SOURCE, 'DIG_QREXEC_SOURCE');
  const targetQube = requireString(env.DIG_TARGET_QUBE || env.DIG_QREXEC_TARGET, 'DIG_QREXEC_TARGET');
  const service = requireString(env.DIG_QREXEC_SERVICE, 'DIG_QREXEC_SERVICE');
  const faultService = requireString(env.DIG_QREXEC_FAULT_SERVICE || 'dig.CoordinatorFault', 'DIG_QREXEC_FAULT_SERVICE');
  const gitSha = requireString(env.DIG_GIT_SHA, 'DIG_GIT_SHA');
  const transportSecret = requireString(env.DIG_TRANSPORT_SECRET, 'DIG_TRANSPORT_SECRET');
  const qrexecBin = (env.DIG_QREXEC_BIN || 'qrexec-client-vm').trim();
  const attestationPublicKey = requireString(env.DIG_RESPONSE_ATTESTATION_PUBLIC_KEY, 'DIG_RESPONSE_ATTESTATION_PUBLIC_KEY');
  const attestationKeyId = requireString(env.DIG_RESPONSE_ATTESTATION_KEY_ID, 'DIG_RESPONSE_ATTESTATION_KEY_ID');

  if (sourceQube === targetQube) throw new Error('qualification preflight requires distinct source and target Qubes');
  if (service === faultService) throw new Error('qualification preflight requires distinct normal and fault qrexec services');
  if (!/^[0-9a-f]{40}$/i.test(gitSha)) throw new Error('DIG_GIT_SHA must be a 40-character hex SHA');
  if (Buffer.byteLength(transportSecret, 'utf8') < 32) throw new Error('DIG_TRANSPORT_SECRET must be at least 32 bytes');
  if (!qrexecBin) throw new Error('DIG_QREXEC_BIN must be a non-empty executable name');

  return { sourceQube, targetQube, service, faultService, gitSha, transportSecret, qrexecBin, attestationPublicKey, attestationKeyId };
}

export async function runQualificationPreflight({ invoke, secret, requestId = `qualification-preflight-${randomUUID()}`, issuedAt = Date.now(), expectedService = null, expectedKeyId = null, expectedGitSha = null } = {}) {
  if (typeof invoke !== 'function') throw new TypeError('invoke must be a function');
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32) throw new Error('secret must be at least 32 bytes');

  const envelope = signWorkerEnvelope({ requestId, issuedAt, op: 'stats', body: null, secret });
  const outcome = await invoke(envelope);
  if (!outcome || typeof outcome !== 'object' || !Number.isFinite(outcome.durationMs) || outcome.durationMs < 0) {
    throw new Error('qrexec preflight transport returned invalid timing evidence');
  }
  const response = outcome.response;
  if (!response || typeof response !== 'object' || response.ok !== true) {
    throw new Error(`qrexec preflight coordinator probe failed: ${response?.error ?? 'invalid response'}`);
  }
  if (!response.result || typeof response.result !== 'object' || Array.isArray(response.result)) {
    throw new Error('qrexec preflight stats response must be an object');
  }
  const attestation = outcome.attestationVerified;
  if (!attestation || typeof attestation !== 'object') throw new Error('qrexec preflight requires verified coordinator response attestation');
  if (expectedService && attestation.service !== expectedService) throw new Error('qrexec preflight attestation service mismatch');
  if (expectedKeyId && attestation.keyId !== expectedKeyId) throw new Error('qrexec preflight attestation key id mismatch');
  if (expectedGitSha && attestation.gitSha !== expectedGitSha) throw new Error('qrexec preflight attestation git sha mismatch');
  return { ok: true, durationMs: outcome.durationMs, requestId, attestation: { service: attestation.service, keyId: attestation.keyId, gitSha: attestation.gitSha } };
}

export async function runQualificationPreflightFromEnv({ env = process.env, invoke = null, faultInvoke = null } = {}) {
  const config = validateQualificationPreflightEnvironment(env);
  const attestation = { publicKeyPem: config.attestationPublicKey, expectedKeyId: config.attestationKeyId, expectedGitSha: config.gitSha };
  const normalTransport = invoke ?? createQrexecProcessTransport({
    target: config.targetQube,
    service: config.service,
    qrexecBin: config.qrexecBin,
    env,
    attestation
  });
  const faultTransport = faultInvoke ?? createQrexecProcessTransport({
    target: config.targetQube,
    service: config.faultService,
    qrexecBin: config.qrexecBin,
    env,
    attestation
  });

  const normal = await runQualificationPreflight({
    invoke: normalTransport,
    secret: config.transportSecret,
    requestId: `qualification-preflight-normal-${randomUUID()}`,
    expectedService: config.service,
    expectedKeyId: config.attestationKeyId,
    expectedGitSha: config.gitSha
  });
  const fault = await runQualificationPreflight({
    invoke: faultTransport,
    secret: config.transportSecret,
    requestId: `qualification-preflight-fault-${randomUUID()}`,
    expectedService: config.faultService,
    expectedKeyId: config.attestationKeyId,
    expectedGitSha: config.gitSha
  });

  return {
    ok: true,
    durationMs: normal.durationMs + fault.durationMs,
    probes: { normal, fault },
    verifiedAttestations: [normal.attestation, fault.attestation],
    sourceQube: config.sourceQube,
    targetQube: config.targetQube,
    service: config.service,
    faultService: config.faultService,
    gitSha: config.gitSha,
    attestationKeyId: config.attestationKeyId
  };
}
