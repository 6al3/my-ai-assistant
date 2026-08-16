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

export async function runQrexecReadinessGate({
  probe,
  samples = 5,
  maxP95ProbeRoundTripMs = 2_000,
  maxP95RecoveryMs = 2_000
} = {}) {
  if (typeof probe !== 'function') throw new Error('probe must be a function');
  if (!Number.isSafeInteger(samples) || samples < 3 || samples > 100) throw new Error('samples must be an integer between 3 and 100');
  finiteNonNegative(maxP95ProbeRoundTripMs, 'maxP95ProbeRoundTripMs');
  finiteNonNegative(maxP95RecoveryMs, 'maxP95RecoveryMs');

  const results = [];
  for (let index = 0; index < samples; index += 1) {
    const result = await probe(index);
    if (!result || typeof result !== 'object') throw new Error('probe must return a result object');
    if (result.mutationPerformed !== false) throw new Error('readiness gate requires mutationPerformed=false');
    if (!['transport-auth-ready', 'recovery-pending'].includes(result.readiness)) throw new Error(`unexpected readiness: ${result.readiness}`);
    finiteNonNegative(result.probeRoundTripMs, 'probeRoundTripMs');
    finiteNonNegative(result.recoveryMs, 'recoveryMs');
    if (!Number.isSafeInteger(result.unresolved) || result.unresolved < 0) throw new Error('unresolved must be a non-negative integer');
    results.push(result);
  }

  const probeLatencies = results.map(result => result.probeRoundTripMs);
  const recoveryLatencies = results.map(result => result.recoveryMs);
  const unresolvedTotal = results.reduce((sum, result) => sum + result.unresolved, 0);
  const notReadyCount = results.filter(result => result.readiness !== 'transport-auth-ready').length;
  const p95ProbeRoundTripMs = percentile(probeLatencies, 95);
  const p95RecoveryMs = percentile(recoveryLatencies, 95);

  const checks = {
    allReadOnly: results.every(result => result.mutationPerformed === false),
    zeroUnresolved: unresolvedTotal === 0,
    allTransportAuthReady: notReadyCount === 0,
    probeLatencyWithinBudget: p95ProbeRoundTripMs <= maxP95ProbeRoundTripMs,
    recoveryLatencyWithinBudget: p95RecoveryMs <= maxP95RecoveryMs
  };
  const passed = Object.values(checks).every(Boolean);

  return {
    readiness: passed ? 'READ_ONLY_GATE_PASS' : 'READ_ONLY_GATE_FAIL',
    passed,
    samples,
    unresolvedTotal,
    notReadyCount,
    p95ProbeRoundTripMs,
    p95RecoveryMs,
    checks,
    mutationPerformed: false
  };
}
