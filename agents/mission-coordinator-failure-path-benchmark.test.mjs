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
  }
});

test('coordinator failure-path budget fails closed on slow or missing measurements', () => {
  const evaluation = evaluateCoordinatorFailurePathBudget([
    { queueSize: 10, failedEnqueue: { p95Ms: 2 }, failedClaim: { p95Ms: 7 } }
  ], { maxP95MsByQueueSize: { 10: 5 } });
  assert.equal(evaluation.ready, false);
  assert.equal(evaluation.checks[0].pass, false);
  assert.throws(() => evaluateCoordinatorFailurePathBudget([
    { queueSize: 100, failedEnqueue: { p95Ms: 1 }, failedClaim: { p95Ms: 1 } }
  ], { maxP95MsByQueueSize: {} }), /missing coordinator failure-path budget/);
});
