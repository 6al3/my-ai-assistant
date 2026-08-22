import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateQrexecReadiness, percentile } from './qubes-qrexec-readiness-gate.mjs';

const gitSha = 'a'.repeat(40);
const nowMs = Date.parse('2026-08-17T16:00:00.000Z');
const passingReport = {
  provenance: { runId: 'run-1', transport: 'qrexec', sourceQube: 'AI', targetQube: 'DIG-Coordinator', service: 'dig.Coordinator', gitSha, startedAt: '2026-08-17T15:50:00.000Z', finishedAt: '2026-08-17T15:55:00.000Z' },
  duplicateCommittedMutations: 0,
  staleCompletions: 0,
  staleCompletionProbes: 1,
  staleCompletionRejections: 1,
  currentLeaseCompletions: 1,
  unresolvedPendingRequests: 0,
  qaBeforeJoin: 0,
  recoveryLatencyMs: [110, 140, 170, 190, 220],
  roundTripLatencyMs: [25, 30, 35, 40, 55]
};
const thresholds = { nowMs, expectedGitSha: gitSha, expectedSourceQube: 'AI', expectedTargetQube: 'DIG-Coordinator', expectedService: 'dig.Coordinator' };

test('percentile is deterministic and order-independent', () => {
  assert.equal(percentile([50, 10, 40, 20, 30], 95), 50);
  assert.equal(percentile([50, 10, 40, 20, 30], 50), 30);
  assert.equal(percentile([], 95), null);
});

test('gate marks a fresh matching qrexec campaign REAL-WORKER READY only with fencing proof', () => {
  const result = evaluateQrexecReadiness(passingReport, thresholds);
  assert.equal(result.ready, true);
  assert.equal(result.classification, 'REAL-WORKER READY');
  assert.deepEqual(result.failedChecks, []);
  assert.equal(result.metrics.recoveryP95Ms, 220);
  assert.equal(result.metrics.roundTripP95Ms, 55);
});

test('gate refuses REAL-WORKER READY without explicit expected SHA and topology binding', () => {
  const missingAll = evaluateQrexecReadiness(passingReport, { nowMs });
  assert.equal(missingAll.ready, false);
  assert.equal(missingAll.classification, 'LAB READY');
  assert.ok(missingAll.failedChecks.includes('explicitQualificationBinding'));
  assert.ok(missingAll.failedChecks.includes('matchingGitSha'));
  assert.ok(missingAll.failedChecks.includes('matchingExpectedTopology'));

  for (const field of ['expectedGitSha', 'expectedSourceQube', 'expectedTargetQube', 'expectedService']) {
    const partial = { ...thresholds };
    delete partial[field];
    const result = evaluateQrexecReadiness(passingReport, partial);
    assert.equal(result.ready, false, field);
    assert.ok(result.failedChecks.includes('explicitQualificationBinding'), field);
  }
});

test('provenance blocks simulation, stale reports, same-qube reports, wrong commits, and future-dated evidence', () => {
  const simulated = evaluateQrexecReadiness({ ...passingReport, provenance: { ...passingReport.provenance, transport: 'stdio' } }, thresholds); assert.ok(simulated.failedChecks.includes('validQrexecProvenance'));
  const sameQube = evaluateQrexecReadiness({ ...passingReport, provenance: { ...passingReport.provenance, targetQube: 'AI' } }, thresholds); assert.ok(sameQube.failedChecks.includes('validQrexecProvenance'));
  const stale = evaluateQrexecReadiness({ ...passingReport, provenance: { ...passingReport.provenance, finishedAt: '2026-08-15T15:55:00.000Z' } }, thresholds); assert.ok(stale.failedChecks.includes('freshCampaignReport'));
  const wrongSha = evaluateQrexecReadiness({ ...passingReport, provenance: { ...passingReport.provenance, gitSha: 'b'.repeat(40) } }, thresholds); assert.ok(wrongSha.failedChecks.includes('matchingGitSha'));
  const future = evaluateQrexecReadiness({ ...passingReport, provenance: { ...passingReport.provenance, startedAt: '2026-08-17T16:10:00.000Z', finishedAt: '2026-08-17T16:11:00.000Z' } }, thresholds); assert.ok(future.failedChecks.includes('freshCampaignReport'));
  const missing = evaluateQrexecReadiness({ ...passingReport, provenance: null }, thresholds); assert.ok(missing.failedChecks.includes('validQrexecProvenance'));
});

test('gate permits only bounded future clock skew', () => {
  const withinSkew = evaluateQrexecReadiness({ ...passingReport, provenance: { ...passingReport.provenance, startedAt: '2026-08-17T16:03:00.000Z', finishedAt: '2026-08-17T16:04:00.000Z' } }, thresholds);
  assert.equal(withinSkew.checks.freshCampaignReport, true);
  const beyondSkew = evaluateQrexecReadiness({ ...passingReport, provenance: { ...passingReport.provenance, startedAt: '2026-08-17T16:06:00.000Z', finishedAt: '2026-08-17T16:07:00.000Z' } }, thresholds);
  assert.equal(beyondSkew.checks.freshCampaignReport, false);
});

test('gate binds evidence to the configured Qube topology and service', () => {
  for (const [field, value] of [['sourceQube', 'OtherWorker'], ['targetQube', 'OtherCoordinator'], ['service', 'dig.OtherService']]) {
    const result = evaluateQrexecReadiness({ ...passingReport, provenance: { ...passingReport.provenance, [field]: value } }, thresholds);
    assert.equal(result.ready, false, field);
    assert.ok(result.failedChecks.includes('matchingExpectedTopology'), field);
  }
  assert.throws(() => evaluateQrexecReadiness(passingReport, { ...thresholds, expectedTargetQube: 'AI' }), /must differ/);
});

test('any correctness invariant failure blocks readiness', () => {
  for (const field of ['duplicateCommittedMutations', 'staleCompletions', 'unresolvedPendingRequests', 'qaBeforeJoin']) {
    const result = evaluateQrexecReadiness({ ...passingReport, [field]: 1 }, thresholds);
    assert.equal(result.ready, false, field);
    assert.equal(result.classification, 'LAB READY');
  }
});

test('missing or failed lease-fencing evidence blocks readiness', () => {
  const noProbe = evaluateQrexecReadiness({ ...passingReport, staleCompletionProbes: 0, staleCompletionRejections: 0 }, thresholds);
  assert.ok(noProbe.failedChecks.includes('staleLeaseWasActuallyProbed'));
  assert.ok(noProbe.failedChecks.includes('everyStaleLeaseProbeRejected'));

  const acceptedStale = evaluateQrexecReadiness({ ...passingReport, staleCompletionRejections: 0, staleCompletions: 1 }, thresholds);
  assert.ok(acceptedStale.failedChecks.includes('noStaleCompletions'));
  assert.ok(acceptedStale.failedChecks.includes('everyStaleLeaseProbeRejected'));

  const noCurrentSuccess = evaluateQrexecReadiness({ ...passingReport, currentLeaseCompletions: 0 }, thresholds);
  assert.ok(noCurrentSuccess.failedChecks.includes('currentLeaseCompletionObserved'));
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
  assert.throws(() => evaluateQrexecReadiness({ ...passingReport, staleCompletionProbes: undefined }, thresholds), /non-negative integer/);
  assert.throws(() => evaluateQrexecReadiness({ ...passingReport, recoveryLatencyMs: [100, Number.NaN] }, thresholds), /non-negative finite/);
  assert.throws(() => evaluateQrexecReadiness({ ...passingReport, roundTripLatencyMs: null }, thresholds), /array/);
});
