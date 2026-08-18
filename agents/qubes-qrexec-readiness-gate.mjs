import { pathToFileURL } from 'node:url';

function assertNonNegativeInteger(value, name) {
  if (!Number.isInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative integer`);
}

function assertLatencySamples(values, name) {
  if (!Array.isArray(values) || values.some(value => !Number.isFinite(value) || value < 0)) throw new TypeError(`${name} must be an array of non-negative finite numbers`);
}

function assertString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be a non-empty string`);
  return value.trim();
}

export function percentile(values, percentileValue) {
  assertLatencySamples(values, 'values');
  if (values.length === 0) return null;
  if (!Number.isFinite(percentileValue) || percentileValue < 0 || percentileValue > 100) throw new TypeError('percentileValue must be between 0 and 100');
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((percentileValue / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

function evaluateProvenance(provenance, limits) {
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) return { valid: false, fresh: false, matchesGitSha: false, matchesTopology: false };
  const transport = assertString(provenance.transport, 'provenance.transport');
  const sourceQube = assertString(provenance.sourceQube, 'provenance.sourceQube');
  const targetQube = assertString(provenance.targetQube, 'provenance.targetQube');
  assertString(provenance.runId, 'provenance.runId');
  const service = assertString(provenance.service, 'provenance.service');
  const gitSha = assertString(provenance.gitSha, 'provenance.gitSha');
  const startedAt = Date.parse(assertString(provenance.startedAt, 'provenance.startedAt'));
  const finishedAt = Date.parse(assertString(provenance.finishedAt, 'provenance.finishedAt'));
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || finishedAt < startedAt) return { valid: false, fresh: false, matchesGitSha: false, matchesTopology: false };
  const ageMs = Math.max(0, limits.nowMs - finishedAt);
  return {
    valid: transport === 'qrexec' && sourceQube !== targetQube && /^[0-9a-f]{40}$/i.test(gitSha),
    fresh: ageMs <= limits.maxReportAgeMs,
    matchesGitSha: limits.expectedGitSha == null || gitSha === limits.expectedGitSha,
    matchesTopology: (limits.expectedSourceQube == null || sourceQube === limits.expectedSourceQube) &&
      (limits.expectedTargetQube == null || targetQube === limits.expectedTargetQube) &&
      (limits.expectedService == null || service === limits.expectedService),
    ageMs
  };
}

export function evaluateQrexecReadiness(report, thresholds = {}) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) throw new TypeError('report must be an object');
  const limits = {
    minSamples: thresholds.minSamples ?? 3,
    maxRecoveryP95Ms: thresholds.maxRecoveryP95Ms ?? 5000,
    maxRoundTripP95Ms: thresholds.maxRoundTripP95Ms ?? 1000,
    maxReportAgeMs: thresholds.maxReportAgeMs ?? 24 * 60 * 60 * 1000,
    expectedGitSha: thresholds.expectedGitSha ?? null,
    expectedSourceQube: thresholds.expectedSourceQube ?? null,
    expectedTargetQube: thresholds.expectedTargetQube ?? null,
    expectedService: thresholds.expectedService ?? null,
    nowMs: thresholds.nowMs ?? Date.now()
  };
  assertNonNegativeInteger(limits.minSamples, 'minSamples');
  if (limits.minSamples === 0) throw new TypeError('minSamples must be greater than zero');
  for (const name of ['maxRecoveryP95Ms', 'maxRoundTripP95Ms', 'maxReportAgeMs']) if (!Number.isFinite(limits[name]) || limits[name] < 0) throw new TypeError(`${name} must be non-negative`);
  if (!Number.isFinite(limits.nowMs)) throw new TypeError('nowMs must be finite');
  if (limits.expectedGitSha != null && !/^[0-9a-f]{40}$/i.test(limits.expectedGitSha)) throw new TypeError('expectedGitSha must be a 40-character hex SHA');
  for (const name of ['expectedSourceQube', 'expectedTargetQube', 'expectedService']) if (limits[name] != null) limits[name] = assertString(limits[name], name);
  if (limits.expectedSourceQube != null && limits.expectedSourceQube === limits.expectedTargetQube) throw new TypeError('expected source and target Qubes must differ');

  const counters = {
    duplicateCommittedMutations: report.duplicateCommittedMutations,
    staleCompletions: report.staleCompletions,
    staleCompletionProbes: report.staleCompletionProbes,
    staleCompletionRejections: report.staleCompletionRejections,
    currentLeaseCompletions: report.currentLeaseCompletions,
    unresolvedPendingRequests: report.unresolvedPendingRequests,
    qaBeforeJoin: report.qaBeforeJoin
  };
  for (const [name, value] of Object.entries(counters)) assertNonNegativeInteger(value, name);
  assertLatencySamples(report.recoveryLatencyMs, 'recoveryLatencyMs');
  assertLatencySamples(report.roundTripLatencyMs, 'roundTripLatencyMs');

  const provenance = evaluateProvenance(report.provenance, limits);
  const recoveryP95Ms = percentile(report.recoveryLatencyMs, 95);
  const roundTripP95Ms = percentile(report.roundTripLatencyMs, 95);
  const checks = {
    validQrexecProvenance: provenance.valid,
    freshCampaignReport: provenance.fresh,
    matchingGitSha: provenance.matchesGitSha,
    matchingExpectedTopology: provenance.matchesTopology,
    enoughRecoverySamples: report.recoveryLatencyMs.length >= limits.minSamples,
    enoughRoundTripSamples: report.roundTripLatencyMs.length >= limits.minSamples,
    noDuplicateCommittedMutations: counters.duplicateCommittedMutations === 0,
    noStaleCompletions: counters.staleCompletions === 0,
    staleLeaseWasActuallyProbed: counters.staleCompletionProbes > 0,
    everyStaleLeaseProbeRejected: counters.staleCompletionProbes > 0 && counters.staleCompletionRejections === counters.staleCompletionProbes,
    currentLeaseCompletionObserved: counters.currentLeaseCompletions > 0,
    noUnresolvedPendingRequests: counters.unresolvedPendingRequests === 0,
    noQaBeforeJoin: counters.qaBeforeJoin === 0,
    recoveryWithinBudget: recoveryP95Ms !== null && recoveryP95Ms <= limits.maxRecoveryP95Ms,
    roundTripWithinBudget: roundTripP95Ms !== null && roundTripP95Ms <= limits.maxRoundTripP95Ms
  };
  const failedChecks = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  return { ready: failedChecks.length === 0, classification: failedChecks.length === 0 ? 'REAL-WORKER READY' : 'LAB READY', failedChecks, checks, metrics: { ...counters, recoverySamples: report.recoveryLatencyMs.length, roundTripSamples: report.roundTripLatencyMs.length, recoveryP95Ms, roundTripP95Ms, reportAgeMs: provenance.ageMs ?? null }, thresholds: limits };
}

async function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  const report = JSON.parse(input);
  const thresholds = {
    expectedGitSha: process.env.DIG_GIT_SHA || null,
    expectedSourceQube: process.env.DIG_SOURCE_QUBE || null,
    expectedTargetQube: process.env.DIG_TARGET_QUBE || null,
    expectedService: process.env.DIG_QREXEC_SERVICE || null
  };
  process.stdout.write(`${JSON.stringify(evaluateQrexecReadiness(report, thresholds), null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch(error => { process.stderr.write(`DIG Qubes readiness gate failed: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
