import { createHash } from 'node:crypto';

const REQUIRED_SCENARIOS = Object.freeze([
  'intended-service-allowed',
  'wrong-service-denied',
  'wrong-identity-denied',
  'auth-failure-denied',
  'malformed-framing-denied'
]);

function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required`);
  return value.trim();
}

function sha(value, name) {
  const normalized = requiredString(value, name).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(normalized)) throw new Error(`${name} must be a 40-character hex SHA`);
  return normalized;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

function normalizeScenario(input, name) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(`scenario ${name} is required`);
  const expected = name === 'intended-service-allowed' ? 'allowed' : 'denied';
  const outcome = requiredString(input.outcome, `scenario ${name}.outcome`);
  if (outcome !== expected) throw new Error(`scenario ${name} must be ${expected}`);
  if (!Number.isInteger(input.exitCode) || input.exitCode < 0 || input.exitCode > 255) {
    throw new Error(`scenario ${name}.exitCode must be an integer from 0 to 255`);
  }
  if (expected === 'allowed' && input.exitCode !== 0) throw new Error(`scenario ${name} must exit 0`);
  if (expected === 'denied' && input.exitCode === 0) throw new Error(`scenario ${name} must fail non-zero`);
  return { outcome, exitCode: input.exitCode };
}

function normalizeMutationEvidence(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('mutationEvidence is required');
  const missionStoreBefore = requiredString(input.missionStoreBefore, 'mutationEvidence.missionStoreBefore');
  const missionStoreAfter = requiredString(input.missionStoreAfter, 'mutationEvidence.missionStoreAfter');
  const requestJournalBefore = requiredString(input.requestJournalBefore, 'mutationEvidence.requestJournalBefore');
  const requestJournalAfter = requiredString(input.requestJournalAfter, 'mutationEvidence.requestJournalAfter');
  if (missionStoreBefore !== missionStoreAfter) throw new Error('read-only qualification mutated MissionStore');
  if (requestJournalBefore !== requestJournalAfter) throw new Error('read-only qualification mutated DurableRequestJournal');
  return { missionStoreBefore, missionStoreAfter, requestJournalBefore, requestJournalAfter };
}

export function buildReadonlyQrexecPolicyQualification(input = {}) {
  const scenarios = {};
  for (const name of REQUIRED_SCENARIOS) scenarios[name] = normalizeScenario(input.scenarios?.[name], name);

  if (input.attestationVerified !== true) throw new Error('allowed response attestation must be verified');
  if (input.responseBounded !== true) throw new Error('allowed response must satisfy configured byte bound');
  if (input.singleResponseFrame !== true) throw new Error('allowed response must contain exactly one response frame');

  const evidence = {
    schemaVersion: 1,
    readiness: 'LAB READY',
    gitSha: sha(input.gitSha, 'gitSha'),
    runtimeFingerprint: requiredString(input.runtimeFingerprint, 'runtimeFingerprint'),
    sourceQube: requiredString(input.sourceQube, 'sourceQube'),
    coordinatorQube: requiredString(input.coordinatorQube, 'coordinatorQube'),
    intendedService: requiredString(input.intendedService, 'intendedService'),
    scenarios,
    attestationVerified: true,
    responseBounded: true,
    singleResponseFrame: true,
    zeroMutationVerified: true,
    mutationEvidence: normalizeMutationEvidence(input.mutationEvidence)
  };

  return { ...evidence, evidenceDigest: digest(evidence) };
}

export function verifyReadonlyQrexecPolicyQualification(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) throw new Error('qualification report is required');
  const { evidenceDigest, ...evidence } = report;
  const expected = digest(evidence);
  if (evidenceDigest !== expected) throw new Error('qualification evidence digest mismatch');
  buildReadonlyQrexecPolicyQualification(evidence);
  return true;
}

export { REQUIRED_SCENARIOS as READONLY_QREXEC_POLICY_SCENARIOS };
