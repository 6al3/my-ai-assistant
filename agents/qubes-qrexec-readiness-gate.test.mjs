import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateQrexecReadiness, percentile } from './qubes-qrexec-readiness-gate.mjs';

const gitSha = 'a'.repeat(40);
const nowMs = Date.parse('2026-08-17T16:00:00.000Z');
const passingReport = {
  provenance: {
    runId: 'run-1', transport: 'qrexec', sourceQube: 'AI', targetQube: 'DIG-Coordinator',
    service: 'dig.Coordinator', gitSha,
    startedAt: '2026-08-17T15:50:00.000Z', finishedAt: '2026-08-17T15:55:00.000Z'
  },
  duplicateCommittedMutations: 0,
  staleCompletions: 0,
  unresolvedPendingRequests: 0,
  qaBeforeJoin: 0,
  recoveryLatencyMs: [110, 140, 170, 190, 220],
  roundTripLatencyMs: [25, 30, 35, 40, 55]
};
const thresholds = { nowMs, expectedGitSha: gitSha };

test('percentile is deterministic and order-independent', () => {
  assert.equal(percentile([50, 10, 40, 20, 30], 95), 50);
  assert.equal(percentile([50, 10, 40, 20, 30], 50), 30);
  assert.equal(percentile([], 95), null);
});

test('gate marks a fresh matching qrexec campaign REAL-WORKER READY', () => {
  const result = evaluateQrexecReadiness(passingReport, thresholds);
  assert.equal(result.ready, true);
  assert.equal(result.classification, 'REAL-WORKER READY');
  assert.deepEqual(result.failedChecks, []);
  assert.equal(result.metrics.recoveryP95Ms, 220);
  assert.equal(result.metrics.roundTripP95Ms, 55);
});

test('provenance blocks simulation, stale reports, same-qube reports, and wrong commits', () => {
  const simulated = evaluateQrexecReadiness({ ...passingReport, provenance: { ...passingReport.provenance, transport: 'stdio' } }, thresholds);
  assert.ok(simulated.failedChecks.includes('validQrexecProvenance'));
  const sameQube = evaluateQrexecReadiness({ ...passingReport, provenance: { ...passingReport.provenance, targetQube: 'AI' } }, thresholds);
  assert.ok(sameQube.failedChecks.includes('validQrexecProvenance'));
  const stale = evaluateQrexecReadiness({ ...passingReport, provenance: { ...passingReport.provenance, finishedAt: '2026-08-15T15:55:00.000Z' } }, thresholds);
  assert.ok(stale.failedChecks.includes('freshCampaignReport'));
  const wrongSha = evaluateQrexecReadiness({ ...passingReport, provenance: { ...passingReport.provenance, gitSha: 'b'.repeat(40) } }, thresholds);
  assert.ok(wrongSha.failedChecks.includes('matchingGitSha'));
  const missing = evaluateQrexecReadiness({ ...passingReport, provenance: null }, thresholds);
  assert.ok(missing.failedChecks.includes('validQrexecProvenance'));
});

test('any correctness invariant failure blocks readiness', () => {
  for (const field of ['duplicateCommittedMutations', 'staleCompletions', 'unresolvedPendingRequests', 'qaBeforeJoin']) {
    const result = evaluateQrexecReadiness({ ...passingReport, [field]: 1 }, thresholds);
    assert.equal(result.ready, false, field);
    assert.equal(result.classification, 'LAB READY');
  }
});

test('latency budget failures block readiness without hiding correctness results', () => {
  const result = evaluateQrexecReadiness({ ...passingReport, recoveryLatencyMs: [100, 200, 6000], roundTripLatencyMs: [100, 200, 1500] }, thresholds);
  assert.equal(result.ready, false);
  assert.ok(result.failedChecks.includes('recoveryWithinBudget'));
  assert.ok(result.failedChecks.includes('roundTripWithinBudget'));
  assert.equal(result.checks.noDuplicateCommittedMutations, true);
});

test('insufficient samples block readiness', () => {
  const result = evaluateQrexecReadiness({ ...passingReport, recoveryLatencyMs: [100, 120], roundTripLatencyMs: [20, 25] }, thresholds);
  assert.equal(result.ready, false);
  assert.ok(result.failedChecks.includes('enoughRecoverySamples'));
  assert.ok(result.failedChecks.includes('enoughRoundTripSamples'));
});

test('malformed campaign reports fail closed', () => {
  assert.throws(() => evaluateQrexecReadiness({ ...passingReport, staleCompletions: -1 }, thresholds), /non-negative integer/);
  assert.throws(() => evaluateQrexecReadiness({ ...passingReport, recoveryLatencyMs: [100, Number.NaN] }, thresholds), /non-negative finite/);
  assert.throws(() => evaluateQrexecReadiness({ ...passingReport, roundTripLatencyMs: null }, thresholds), /array/);
});
