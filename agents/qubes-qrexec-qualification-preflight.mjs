import { randomUUID } from 'node:crypto';
import { createQrexecProcessTransport } from './qubes-qrexec-campaign-harness.mjs';
import { signWorkerEnvelope } from './worker-transport-envelope.mjs';

function requireString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required for qualification preflight`);
  return value.trim();
}
function requireDigest(value, name) {
  const digest = requireString(value, name);
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`${name} must be a lowercase SHA-256 hex digest`);
  return digest;
}

export function validateQualificationPreflightEnvironment(env = process.env) {
  const sourceQube = requireString(env.DIG_SOURCE_QUBE || env.DIG_QREXEC_SOURCE, 'DIG_QREXEC_SOURCE');
  const targetQube = requireString(env.DIG_TARGET_QUBE || env.DIG_QREXEC_TARGET, 'DIG_QREXEC_TARGET');
  const service = requireString(env.DIG_QREXEC_SERVICE, 'DIG_QREXEC_SERVICE');
  const faultService = requireString(env.DIG_QREXEC_FAULT_SERVICE || 'dig.CoordinatorFault', 'DIG_QREXEC_FAULT_SERVICE');
  const gitSha = requireString(env.DIG_GIT_SHA, 'DIG_GIT_SHA');
  const topologyId = requireString(env.DIG_QUBES_TOPOLOGY_ID, 'DIG_QUBES_TOPOLOGY_ID');
  const calibrationEvidenceDigest = requireDigest(env.DIG_CALIBRATION_EVIDENCE_DIGEST, 'DIG_CALIBRATION_EVIDENCE_DIGEST');
  const transportSecret = requireString(env.DIG_TRANSPORT_SECRET, 'DIG_TRANSPORT_SECRET');
  const qrexecBin = (env.DIG_QREXEC_BIN || 'qrexec-client-vm').trim();
  const attestationPublicKey = requireString(env.DIG_RESPONSE_ATTESTATION_PUBLIC_KEY, 'DIG_RESPONSE_ATTESTATION_PUBLIC_KEY');
  const attestationKeyId = requireString(env.DIG_RESPONSE_ATTESTATION_KEY_ID, 'DIG_RESPONSE_ATTESTATION_KEY_ID');

  if (sourceQube === targetQube) throw new Error('qualification preflight requires distinct source and target Qubes');
  if (service === faultService) throw new Error('qualification preflight requires distinct normal and fault qrexec services');
  if (!/^[0-9a-f]{40}$/i.test(gitSha)) throw new Error('DIG_GIT_SHA must be a 40-character hex SHA');
  if (Buffer.byteLength(transportSecret, 'utf8') < 32) throw new Error('DIG_TRANSPORT_SECRET must be at least 32 bytes');
  if (!qrexecBin) throw new Error('DIG_QREXEC_BIN must be a non-empty executable name');

  return { sourceQube, targetQube, service, faultService, gitSha, topologyId, calibrationEvidenceDigest, transportSecret, qrexecBin, attestationPublicKey, attestationKeyId };
}

export async function runQualificationPreflight({ invoke, secret, requestId = `qualification-preflight-${randomUUID()}`, issuedAt = Date.now(), expectedService = null, expectedKeyId = null, expectedGitSha = null, expectedTopologyId = null, expectedCalibrationEvidenceDigest = null } = {}) {
  if (typeof invoke !== 'function') throw new TypeError('invoke must be a function');
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32) throw new Error('secret must be at least 32 bytes');
  if ((expectedTopologyId == null) !== (expectedCalibrationEvidenceDigest == null)) throw new Error('expectedTopologyId and expectedCalibrationEvidenceDigest must be provided together');

  const envelope = signWorkerEnvelope({ requestId, issuedAt, op: 'stats', body: null, secret });
  const outcome = await invoke(envelope);
  if (!outcome || typeof outcome !== 'object' || !Number.isFinite(outcome.durationMs) || outcome.durationMs < 0) throw new Error('qrexec preflight transport returned invalid timing evidence');
  const response = outcome.response;
  if (!response || typeof response !== 'object' || response.ok !== true) throw new Error(`qrexec preflight coordinator probe failed: ${response?.error ?? 'invalid response'}`);
  if (!response.result || typeof response.result !== 'object' || Array.isArray(response.result)) throw new Error('qrexec preflight stats response must be an object');
  const attestation = outcome.attestationVerified;
  if (!attestation || typeof attestation !== 'object') throw new Error('qrexec preflight requires verified coordinator response attestation');
  if (expectedService && attestation.service !== expectedService) throw new Error('qrexec preflight attestation service mismatch');
  if (expectedKeyId && attestation.keyId !== expectedKeyId) throw new Error('qrexec preflight attestation key id mismatch');
  if (expectedGitSha && attestation.gitSha !== expectedGitSha) throw new Error('qrexec preflight attestation git sha mismatch');
  if (expectedTopologyId != null) {
    if (attestation.topologyId !== expectedTopologyId) throw new Error('qrexec preflight attestation topology mismatch');
    if (attestation.calibrationEvidenceDigest !== expectedCalibrationEvidenceDigest) throw new Error('qrexec preflight attestation calibration digest mismatch');
  }
  return { ok: true, durationMs: outcome.durationMs, requestId, attestation: { service: attestation.service, keyId: attestation.keyId, gitSha: attestation.gitSha, ...(attestation.topologyId == null ? {} : { topologyId: attestation.topologyId, calibrationEvidenceDigest: attestation.calibrationEvidenceDigest }) } };
}

export async function runQualificationPreflightFromEnv({ env = process.env, invoke = null, faultInvoke = null } = {}) {
  const config = validateQualificationPreflightEnvironment(env);
  const attestation = { publicKeyPem: config.attestationPublicKey, expectedKeyId: config.attestationKeyId, expectedGitSha: config.gitSha, expectedTopologyId: config.topologyId, expectedCalibrationEvidenceDigest: config.calibrationEvidenceDigest };
  const normalTransport = invoke ?? createQrexecProcessTransport({ target: config.targetQube, service: config.service, qrexecBin: config.qrexecBin, env, attestation });
  const faultTransport = faultInvoke ?? createQrexecProcessTransport({ target: config.targetQube, service: config.faultService, qrexecBin: config.qrexecBin, env, attestation });
  const expected = { expectedKeyId: config.attestationKeyId, expectedGitSha: config.gitSha, expectedTopologyId: config.topologyId, expectedCalibrationEvidenceDigest: config.calibrationEvidenceDigest };
  const normal = await runQualificationPreflight({ invoke: normalTransport, secret: config.transportSecret, requestId: `qualification-preflight-normal-${randomUUID()}`, expectedService: config.service, ...expected });
  const fault = await runQualificationPreflight({ invoke: faultTransport, secret: config.transportSecret, requestId: `qualification-preflight-fault-${randomUUID()}`, expectedService: config.faultService, ...expected });

  return { ok: true, durationMs: normal.durationMs + fault.durationMs, probes: { normal, fault }, verifiedAttestations: [normal.attestation, fault.attestation], sourceQube: config.sourceQube, targetQube: config.targetQube, service: config.service, faultService: config.faultService, gitSha: config.gitSha, topologyId: config.topologyId, calibrationEvidenceDigest: config.calibrationEvidenceDigest, attestationKeyId: config.attestationKeyId };
}
