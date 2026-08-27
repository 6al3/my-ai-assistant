import { assembleReadonlyQrexecDeploymentArtifact } from './qrexec-readonly-deployment-evidence-collector.mjs';
import { verifyReadonlyQrexecDeploymentArtifact } from './qrexec-readonly-deployment-artifact.mjs';

const MAX_EXPORT_BYTES = 96 * 1024;
const EXPECTED_DOMAINS = new Set(['dom0-policy', 'coordinator-service']);

function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required`);
  return value.trim();
}

function parseBoundedExport(value, label) {
  let parsed = value;
  if (typeof value === 'string' || Buffer.isBuffer(value)) {
    const bytes = Buffer.isBuffer(value) ? value.length : Buffer.byteLength(value);
    if (bytes > MAX_EXPORT_BYTES) throw new Error(`${label} exceeds byte limit`);
    const text = Buffer.isBuffer(value) ? value.toString('utf8') : value;
    try { parsed = JSON.parse(text.trim()); } catch { throw new Error(`${label} must be valid JSON`); }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${label} must be an object`);
  if (parsed.schemaVersion !== 1) throw new Error(`${label} schema mismatch`);
  if (!EXPECTED_DOMAINS.has(parsed.domain)) throw new Error(`${label} domain mismatch`);
  if (!parsed.evidence || typeof parsed.evidence !== 'object' || Array.isArray(parsed.evidence)) throw new Error(`${label} evidence is required`);
  return parsed;
}

/**
 * Join exactly one dom0-policy export with exactly one coordinator-service export.
 * The join is deliberately offline: it performs no qrexec call and does not mutate
 * MissionQueue state. Deployment expectations remain authoritative and are checked
 * again by verifyReadonlyQrexecDeploymentArtifact().
 */
export function importReadonlyQrexecDeploymentEvidence({ exports, expected } = {}) {
  if (!Array.isArray(exports) || exports.length !== 2) throw new Error('exactly two deployment evidence exports are required');
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) throw new Error('expected deployment identity is required');

  const parsed = exports.map((value, index) => parseBoundedExport(value, `exports[${index}]`));
  const byDomain = new Map();
  for (const item of parsed) {
    if (byDomain.has(item.domain)) throw new Error(`duplicate deployment evidence domain: ${item.domain}`);
    byDomain.set(item.domain, item.evidence);
  }
  if (!byDomain.has('dom0-policy') || !byDomain.has('coordinator-service')) {
    throw new Error('dom0-policy and coordinator-service evidence are both required');
  }

  const expectedGitSha = requiredString(expected.expectedGitSha, 'expected.expectedGitSha').toLowerCase();
  const coordinatorEvidence = byDomain.get('coordinator-service');
  if (coordinatorEvidence?.serviceHandler?.targetGitSha !== expectedGitSha) {
    throw new Error('coordinator evidence git sha mismatch');
  }

  const artifact = assembleReadonlyQrexecDeploymentArtifact({
    service: expected.expectedService,
    sourceQube: expected.expectedSourceQube,
    coordinatorQube: expected.expectedCoordinatorQube,
    serviceUser: expected.expectedServiceUser,
    serviceUid: expected.expectedServiceUid,
    gitSha: expectedGitSha,
    policyEvidence: byDomain.get('dom0-policy'),
    coordinatorEvidence
  });

  verifyReadonlyQrexecDeploymentArtifact(artifact, expected);
  return artifact;
}
