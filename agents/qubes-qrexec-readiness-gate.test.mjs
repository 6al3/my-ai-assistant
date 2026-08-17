import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateQrexecReadiness, percentile } from './qubes-qrexec-readiness-gate.mjs';

const passingReport = {
  duplicateCommittedMutations: 0,
  staleCompletions: 0,
  unresolvedPendingRequests: 0,
  qaBeforeJoin: 0,
  recoveryLatencyMs: [110, 140, 170, 190, 220],
  roundTripLatencyMs: [25, 30, 35, 40, 55]
};

test('percentile is deterministic and order-independent', () => {
  assert.equal(percentile([50, 10, 40, 20, 30], 95), 50);
  assert.equal(percentile([50, 10, 40, 20, 30], 50), 30);
  assert.equal(percentile([], 95), null);
});

test('gate marks a clean campaign REAL-WORKER READY', () => {
  const result = evaluateQrexecReadiness(passingReport);
  assert.equal(result.ready, true);
  assert.equal(result.classification, 'REAL-WORKER READY');
  assert.deepEqual(result.failedChecks, []);
  assert.equal(result.metrics.recoveryP95Ms, 220);
  assert.equal(result.metrics.roundTripP95Ms, 55);
});

test('any correctness invariant failure blocks readiness', () => {
  for (const field of ['duplicateCommittedMutations', 'staleCompletions', 'unresolvedPendingRequests', 'qaBeforeJoin']) {
    const result = evaluateQrexecReadiness({ ...passingReport, [field]: 1 });
    assert.equal(result.ready, false, field);
    assert.equal(result.classification, 'LAB READY');
  }
});

test('latency budget failures block readiness without hiding correctness results', () => {
  const result = evaluateQrexecReadiness({
    ...passingReport,
    recoveryLatencyMs: [100, 200, 6000],
    roundTripLatencyMs: [100, 200, 1500]
  });
  assert.equal(result.ready, false);
  assert.ok(result.failedChecks.includes('recoveryWithinBudget'));
  assert.ok(result.failedChecks.includes('roundTripWithinBudget'));
  assert.equal(result.checks.noDuplicateCommittedMutations, true);
});

test('insufficient samples block readiness', () => {
  const result = evaluateQrexecReadiness({
    ...passingReport,
    recoveryLatencyMs: [100, 120],
    roundTripLatencyMs: [20, 25]
  });
  assert.equal(result.ready, false);
  assert.ok(result.failedChecks.includes('enoughRecoverySamples'));
  assert.ok(result.failedChecks.includes('enoughRoundTripSamples'));
});

test('malformed campaign reports fail closed', () => {
  assert.throws(() => evaluateQrexecReadiness({ ...passingReport, staleCompletions: -1 }), /non-negative integer/);
  assert.throws(() => evaluateQrexecReadiness({ ...passingReport, recoveryLatencyMs: [100, Number.NaN] }), /non-negative finite/);
  assert.throws(() => evaluateQrexecReadiness({ ...passingReport, roundTripLatencyMs: null }), /array/);
});
