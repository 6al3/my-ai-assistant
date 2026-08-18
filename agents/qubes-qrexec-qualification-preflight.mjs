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
  const gitSha = requireString(env.DIG_GIT_SHA, 'DIG_GIT_SHA');
  const transportSecret = requireString(env.DIG_TRANSPORT_SECRET, 'DIG_TRANSPORT_SECRET');
  const qrexecBin = (env.DIG_QREXEC_BIN || 'qrexec-client-vm').trim();

  if (sourceQube === targetQube) throw new Error('qualification preflight requires distinct source and target Qubes');
  if (!/^[0-9a-f]{40}$/i.test(gitSha)) throw new Error('DIG_GIT_SHA must be a 40-character hex SHA');
  if (Buffer.byteLength(transportSecret, 'utf8') < 32) throw new Error('DIG_TRANSPORT_SECRET must be at least 32 bytes');
  if (!qrexecBin) throw new Error('DIG_QREXEC_BIN must be a non-empty executable name');

  return { sourceQube, targetQube, service, gitSha, transportSecret, qrexecBin };
}

export async function runQualificationPreflight({ invoke, secret, requestId = `qualification-preflight-${randomUUID()}`, issuedAt = Date.now() } = {}) {
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
  return { ok: true, durationMs: outcome.durationMs, requestId };
}

export async function runQualificationPreflightFromEnv({ env = process.env, invoke = null } = {}) {
  const config = validateQualificationPreflightEnvironment(env);
  const transport = invoke ?? createQrexecProcessTransport({
    target: config.targetQube,
    service: config.service,
    qrexecBin: config.qrexecBin,
    env
  });
  const result = await runQualificationPreflight({ invoke: transport, secret: config.transportSecret });
  return {
    ...result,
    sourceQube: config.sourceQube,
    targetQube: config.targetQube,
    service: config.service,
    gitSha: config.gitSha
  };
}
