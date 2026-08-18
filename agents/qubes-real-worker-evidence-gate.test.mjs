import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateCampaignCoverage, evaluateRealWorkerEvidence } from './qubes-real-worker-evidence-gate.mjs';

const gitSha = 'a'.repeat(40);
const start = { type: 'campaign_start', runId: 'run-coverage', transport: 'qrexec', sourceQube: 'AI', targetQube: 'DIG-Coordinator', service: 'dig.Coordinator', gitSha, startedAt: '2026-08-18T04:00:00.000Z' };
const end = { type: 'campaign_end', runId: 'run-coverage', finishedAt: '2026-08-18T04:05:00.000Z' };
const events = [
  start,
  { type: 'request_pending', requestId: 'r1' },
  { type: 'mutation_committed', mutationKey: 'r1:complete:coder' },
  { type: 'request_resolved', requestId: 'r1' },
  { type: 'stale_completion_probe', rejected: true },
  { type: 'current_lease_completion' },
  { type: 'qa_started', pendingDependencies: 0 },
  { type: 'recovery', durationMs: 100 },
  { type: 'recovery', durationMs: 120 },
  { type: 'recovery', durationMs: 140 },
  { type: 'round_trip', durationMs: 20 },
  { type: 'round_trip', durationMs: 25 },
  { type: 'round_trip', durationMs: 30 },
  end
];
const thresholds = { nowMs: Date.parse('2026-08-18T04:10:00.000Z'), expectedGitSha: gitSha, expectedSourceQube: 'AI', expectedTargetQube: 'DIG-Coordinator', expectedService: 'dig.Coordinator' };

test('coverage requires every release-critical scenario to be exercised, not merely zero failures', () => {
  const result = evaluateCampaignCoverage(events);
  assert.equal(result.ready, true);
  assert.deepEqual(result.failedChecks, []);
  assert.equal(result.metrics.resolvedAfterPending, 1);
  assert.equal(result.metrics.qaJoinProbes, 1);
});

test('combined gate can classify complete fresh evidence REAL-WORKER READY', () => {
  const result = evaluateRealWorkerEvidence(events, thresholds);
  assert.equal(result.ready, true);
  assert.equal(result.classification, 'REAL-WORKER READY');
});

test('zero-error reports cannot pass when recovery or QA join was never exercised', () => {
  const noRecovery = events.filter(event => event.type !== 'recovery');
  const recoveryResult = evaluateCampaignCoverage(noRecovery);
  assert.ok(recoveryResult.failedChecks.includes('recoveryWasActuallyExercised'));

  const noQa = events.filter(event => event.type !== 'qa_started');
  const qaResult = evaluateCampaignCoverage(noQa);
  assert.ok(qaResult.failedChecks.includes('qaJoinWasActuallyProbed'));
});

test('request resolution only counts when the same request was first observed pending', () => {
  const altered = events.filter(event => event.type !== 'request_pending');
  const result = evaluateCampaignCoverage(altered);
  assert.ok(result.failedChecks.includes('pendingRequestWasResolved'));
});

test('coverage independently requires mutation, stale fencing, current lease success, and framing', () => {
  const cases = [
    ['mutation_committed', 'committedMutationObserved'],
    ['stale_completion_probe', 'staleLeaseWasActuallyProbed'],
    ['current_lease_completion', 'currentLeaseCompletionObserved'],
    ['campaign_start', 'exactlyOneCampaignStart'],
    ['campaign_end', 'exactlyOneCampaignEnd']
  ];
  for (const [removedType, expectedCheck] of cases) {
    const result = evaluateCampaignCoverage(events.filter(event => event.type !== removedType));
    assert.equal(result.ready, false, removedType);
    assert.ok(result.failedChecks.includes(expectedCheck), removedType);
  }
});
