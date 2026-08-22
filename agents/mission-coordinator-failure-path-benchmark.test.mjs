import assert from 'node:assert/strict';
import test from 'node:test';
import { benchmarkCoordinatorFailurePath, evaluateCoordinatorFailurePathBudget } from './mission-coordinator-failure-path-benchmark.mjs';

test('coordinator failure-path benchmark measures enqueue and claim rollback without leaked state', async () => {
  const results = await benchmarkCoordinatorFailurePath({ queueSizes: [10, 100], samples: 3 });
  assert.deepEqual(results.map(result => result.queueSize), [10, 100]);
  for (const result of results) {
    assert.equal(result.samples, 3);
    assert.ok(result.failedEnqueue.p95Ms >= result.failedEnqueue.p50Ms);
    assert.ok(result.failedClaim.p95Ms >= result.failedClaim.p50Ms);
    assert.ok(result.failedEnqueue.p95UsPerMission >= 0);
    assert.ok(result.failedClaim.p95UsPerMission >= 0);
  }
});

test('coordinator failure-path benchmark supports bounded 5000-mission scaling evidence', async () => {
  const results = await benchmarkCoordinatorFailurePath({ queueSizes: [1000, 5000], samples: 3 });
  assert.deepEqual(results.map(result => result.queueSize), [1000, 5000]);
  const evaluation = evaluateCoordinatorFailurePathBudget(results, {
    maxP95MsByQueueSize: { 1000: 10000, 5000: 50000 },
    maxGrowthRatio1000To5000: 100
  });
  assert.ok(evaluation.growth);
  assert.ok(evaluation.growth.enqueueRatio >= 0);
  assert.ok(evaluation.growth.claimRatio >= 0);
});

test('coordinator failure-path budget fails closed on slow, missing, or superlinear growth measurements', () => {
  const evaluation = evaluateCoordinatorFailurePathBudget([
    { queueSize: 10, failedEnqueue: { p95Ms: 2 }, failedClaim: { p95Ms: 7 } }
  ], { maxP95MsByQueueSize: { 10: 5 } });
  assert.equal(evaluation.ready, false);
  assert.equal(evaluation.checks[0].pass, false);
  assert.throws(() => evaluateCoordinatorFailurePathBudget([
    { queueSize: 100, failedEnqueue: { p95Ms: 1 }, failedClaim: { p95Ms: 1 } }
  ], { maxP95MsByQueueSize: {} }), /missing coordinator failure-path budget/);

  const growth = evaluateCoordinatorFailurePathBudget([
    { queueSize: 1000, failedEnqueue: { p95Ms: 10 }, failedClaim: { p95Ms: 10 } },
    { queueSize: 5000, failedEnqueue: { p95Ms: 70 }, failedClaim: { p95Ms: 50 } }
  ], { maxP95MsByQueueSize: { 1000: 100, 5000: 100 }, maxGrowthRatio1000To5000: 6 });
  assert.equal(growth.ready, false);
  assert.equal(growth.growth.pass, false);
  assert.throws(() => evaluateCoordinatorFailurePathBudget([
    { queueSize: 1000, failedEnqueue: { p95Ms: 10 }, failedClaim: { p95Ms: 10 } }
  ], { maxP95MsByQueueSize: { 1000: 100 } }), /1000 and 5000 mission measurements/);
});
