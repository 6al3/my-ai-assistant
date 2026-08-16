function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function finiteNonNegative(value, label) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a finite non-negative number`);
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}

export async function runSyntheticMutationGate({
  scenario,
  samples = 5,
  maxP95RecoveryMs = 3_000,
  maxP95RoundTripMs = 3_000
} = {}) {
  if (typeof scenario !== 'function') throw new Error('scenario must be a function');
  if (!Number.isSafeInteger(samples) || samples < 3 || samples > 50) throw new Error('samples must be an integer between 3 and 50');
  finiteNonNegative(maxP95RecoveryMs, 'maxP95RecoveryMs');
  finiteNonNegative(maxP95RoundTripMs, 'maxP95RoundTripMs');

  const results = [];
  for (let index = 0; index < samples; index += 1) {
    const result = await scenario(index);
    if (!result || typeof result !== 'object') throw new Error('scenario must return a result object');
    if (result.syntheticOnly !== true) throw new Error('synthetic mutation gate requires syntheticOnly=true');
    nonNegativeInteger(result.duplicateMutations, 'duplicateMutations');
    nonNegativeInteger(result.unresolvedCommittedRequests, 'unresolvedCommittedRequests');
    nonNegativeInteger(result.oldKeyAcceptance, 'oldKeyAcceptance');
    nonNegativeInteger(result.missionAttempts, 'missionAttempts');
    finiteNonNegative(result.recoveryMs, 'recoveryMs');
    finiteNonNegative(result.roundTripMs, 'roundTripMs');
    results.push(result);
  }

  const duplicateMutations = results.reduce((sum, item) => sum + item.duplicateMutations, 0);
  const unresolvedCommittedRequests = results.reduce((sum, item) => sum + item.unresolvedCommittedRequests, 0);
  const oldKeyAcceptance = results.reduce((sum, item) => sum + item.oldKeyAcceptance, 0);
  const p95RecoveryMs = percentile(results.map(item => item.recoveryMs), 95);
  const p95RoundTripMs = percentile(results.map(item => item.roundTripMs), 95);
  const missionAttemptsExact = results.every(item => item.missionAttempts === 1);

  const checks = {
    syntheticOnly: results.every(item => item.syntheticOnly === true),
    zeroDuplicateMutations: duplicateMutations === 0,
    zeroUnresolvedCommittedRequests: unresolvedCommittedRequests === 0,
    zeroOldKeyAcceptance: oldKeyAcceptance === 0,
    missionAttemptsExactlyOnce: missionAttemptsExact,
    recoveryLatencyWithinBudget: p95RecoveryMs <= maxP95RecoveryMs,
    roundTripLatencyWithinBudget: p95RoundTripMs <= maxP95RoundTripMs
  };
  const passed = Object.values(checks).every(Boolean);

  return {
    readiness: passed ? 'SYNTHETIC_MUTATION_GATE_PASS' : 'SYNTHETIC_MUTATION_GATE_FAIL',
    passed,
    samples,
    duplicateMutations,
    unresolvedCommittedRequests,
    oldKeyAcceptance,
    p95RecoveryMs,
    p95RoundTripMs,
    checks,
    syntheticOnly: true
  };
}
