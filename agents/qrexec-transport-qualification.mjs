import { createHash, randomUUID } from 'node:crypto';

const REQUIRED_SCENARIOS = [
  'beforeMutation',
  'afterClaimMutation',
  'afterHeartbeatMutation',
  'afterFailMutation',
  'afterCompleteMutation',
  'afterJournalCommit'
];

function text(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be a non-empty string`);
  return value.trim();
}

function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('qualification evidence must contain only finite JSON numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw new TypeError('qualification evidence must contain only JSON-compatible values');
}

function normalizeRuntimeFingerprint(value = {}) {
  return {
    node: text(value.node, 'runtime.node'),
    platform: text(value.platform, 'runtime.platform'),
    arch: text(value.arch, 'runtime.arch')
  };
}

function normalizeScenario(name, scenario = {}) {
  const normalized = {
    attestationVerified: scenario.attestationVerified === true,
    duplicateMutations: scenario.duplicateMutations,
    durableEffectCount: scenario.durableEffectCount,
    journalStatus: text(scenario.journalStatus, `${name}.journalStatus`),
    outcome: text(scenario.outcome, `${name}.outcome`)
  };
  if (!Number.isSafeInteger(normalized.duplicateMutations) || normalized.duplicateMutations < 0) throw new TypeError(`${name}.duplicateMutations must be a non-negative integer`);
  if (!Number.isSafeInteger(normalized.durableEffectCount) || normalized.durableEffectCount < 0) throw new TypeError(`${name}.durableEffectCount must be a non-negative integer`);
  return normalized;
}

function scenarioPasses(name, scenario) {
  if (!scenario.attestationVerified || scenario.duplicateMutations !== 0) return false;
  if (name === 'beforeMutation') return scenario.durableEffectCount === 0 && scenario.journalStatus === 'missing' && scenario.outcome === 'RETRY_EXECUTES_ONCE';
  if (name === 'afterCompleteMutation') return scenario.durableEffectCount === 1 && scenario.journalStatus === 'committed' && scenario.outcome === 'RECONCILED_COMPLETE';
  if (name === 'afterJournalCommit') return scenario.durableEffectCount === 1 && scenario.journalStatus === 'committed' && scenario.outcome === 'REPLAY_COMMITTED';
  return scenario.durableEffectCount === 1 && scenario.journalStatus === 'pending' && scenario.outcome === 'REQUEST_OUTCOME_INDETERMINATE';
}

function digestPayload(report) {
  const copy = structuredClone(report);
  delete copy.evidenceDigest;
  return canonicalJson(copy);
}

export function buildQrexecTransportQualification({ gitSha, runtime, scenarios, generatedAt = new Date().toISOString(), qualificationRunId = randomUUID() } = {}) {
  gitSha = text(gitSha, 'gitSha').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(gitSha)) throw new Error('gitSha must be a 40-character hex SHA');
  generatedAt = text(generatedAt, 'generatedAt');
  if (!Number.isFinite(Date.parse(generatedAt))) throw new Error('generatedAt must be an ISO timestamp');
  qualificationRunId = text(qualificationRunId, 'qualificationRunId');
  const runtimeFingerprint = normalizeRuntimeFingerprint(runtime);
  if (!scenarios || typeof scenarios !== 'object' || Array.isArray(scenarios)) throw new TypeError('scenarios must be an object');
  const unknown = Object.keys(scenarios).filter(name => !REQUIRED_SCENARIOS.includes(name));
  if (unknown.length) throw new Error(`unexpected scenarios: ${unknown.join(',')}`);
  const normalizedScenarios = {};
  const checks = {};
  for (const name of REQUIRED_SCENARIOS) {
    if (!(name in scenarios)) throw new Error(`missing required scenario: ${name}`);
    normalizedScenarios[name] = normalizeScenario(name, scenarios[name]);
    checks[name] = scenarioPasses(name, normalizedScenarios[name]);
  }
  const duplicateMutations = Object.values(normalizedScenarios).reduce((sum, scenario) => sum + scenario.duplicateMutations, 0);
  const responseAttestationsVerified = Object.values(normalizedScenarios).every(scenario => scenario.attestationVerified);
  const ready = Object.values(checks).every(Boolean) && duplicateMutations === 0 && responseAttestationsVerified;
  const report = {
    schemaVersion: 1,
    qualificationRunId,
    generatedAt,
    gitSha,
    runtime: runtimeFingerprint,
    readiness: ready ? 'LAB READY' : 'NOT READY',
    checks,
    metrics: { duplicateMutations, responseAttestationsVerified },
    scenarios: normalizedScenarios
  };
  report.evidenceDigest = createHash('sha256').update(digestPayload(report)).digest('hex');
  return report;
}

export function verifyQrexecTransportQualification(report, { expectedGitSha = null } = {}) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) throw new TypeError('qualification report must be an object');
  if (report.schemaVersion !== 1) throw new Error('unsupported qualification report schema');
  if (expectedGitSha != null && report.gitSha !== text(expectedGitSha, 'expectedGitSha').toLowerCase()) throw new Error('qualification gitSha mismatch');
  if (typeof report.evidenceDigest !== 'string' || !/^[0-9a-f]{64}$/.test(report.evidenceDigest)) throw new Error('qualification evidenceDigest is invalid');
  const expected = createHash('sha256').update(digestPayload(report)).digest('hex');
  if (expected !== report.evidenceDigest) throw new Error('qualification evidence digest mismatch');
  const rebuilt = buildQrexecTransportQualification({
    gitSha: report.gitSha,
    runtime: report.runtime,
    scenarios: report.scenarios,
    generatedAt: report.generatedAt,
    qualificationRunId: report.qualificationRunId
  });
  if (rebuilt.readiness !== report.readiness) throw new Error('qualification readiness mismatch');
  return report;
}

export const QREXEC_TRANSPORT_REQUIRED_SCENARIOS = Object.freeze([...REQUIRED_SCENARIOS]);
