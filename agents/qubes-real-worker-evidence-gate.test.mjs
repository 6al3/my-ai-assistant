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
  { type: 'qa_barrier_probe', blocked: true },
  { type: 'qa_post_join_start' },
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
  assert.equal(result.metrics.qaBarrierProbes, 1);
  assert.equal(result.metrics.qaBarrierBlocks, 1);
  assert.equal(result.metrics.qaPostJoinStarts, 1);
});

test('combined gate can classify complete fresh evidence REAL-WORKER READY', () => {
  const result = evaluateRealWorkerEvidence(events, thresholds);
  assert.equal(result.ready, true);
  assert.equal(result.classification, 'REAL-WORKER READY');
});

test('zero-error reports cannot pass when recovery or either side of QA join causality was never exercised', () => {
  const noRecovery = events.filter(event => event.type !== 'recovery');
  const recoveryResult = evaluateCampaignCoverage(noRecovery);
  assert.ok(recoveryResult.failedChecks.includes('recoveryWasActuallyExercised'));

  const noBarrier = events.filter(event => event.type !== 'qa_barrier_probe');
  const barrierResult = evaluateCampaignCoverage(noBarrier);
  assert.ok(barrierResult.failedChecks.includes('qaBarrierWasActuallyProbed'));
  assert.ok(barrierResult.failedChecks.includes('qaWasBlockedBeforeJoin'));

  const noPostJoin = events.filter(event => event.type !== 'qa_post_join_start');
  const postJoinResult = evaluateCampaignCoverage(noPostJoin);
  assert.ok(postJoinResult.failedChecks.includes('qaStartedAfterJoin'));
});

test('an early QA claim is a blocker even when QA later starts after join', () => {
  const altered = events.map(event => event.type === 'qa_barrier_probe' ? { ...event, blocked: false } : event);
  const result = evaluateCampaignCoverage(altered);
  assert.equal(result.ready, false);
  assert.ok(result.failedChecks.includes('qaWasBlockedBeforeJoin'));
  const combined = evaluateRealWorkerEvidence(altered, thresholds);
  assert.equal(combined.ready, false);
  assert.ok(combined.failedChecks.includes('readiness:noQaBeforeJoin'));
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
