import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateMissionRuntimeBenchmarkStability } from './mission-runtime-benchmark-stability.mjs';

function run(enqueue1k, claim1k, enqueue5k, claim5k) {
  return [
    { queueSize: 1000, failedEnqueue: { p95Ms: enqueue1k }, failedClaim: { p95Ms: claim1k } },
    { queueSize: 5000, failedEnqueue: { p95Ms: enqueue5k }, failedClaim: { p95Ms: claim5k } }
  ];
}

test('accepts reproducible p95 measurements across repeated benchmark runs', () => {
  const result = evaluateMissionRuntimeBenchmarkStability([
    run(20, 25, 90, 100),
    run(21, 24, 94, 102),
    run(19, 26, 88, 98)
  ]);
  assert.equal(result.ready, true);
  assert.equal(result.runCount, 3);
  assert.deepEqual(result.failedChecks, []);
});

test('fails closed when one queue size has unstable p95 measurements', () => {
  const result = evaluateMissionRuntimeBenchmarkStability([
    run(20, 25, 90, 100),
    run(21, 24, 160, 102),
    run(19, 26, 88, 98)
  ], { maxRelativeP95Spread: 0.25 });
  assert.equal(result.ready, false);
  assert.deepEqual(result.failedChecks, ['unstable-p95-5000']);
});

test('rejects incomparable, incomplete, or malformed benchmark evidence', () => {
  assert.throws(() => evaluateMissionRuntimeBenchmarkStability([run(20, 25, 90, 100)]), /at least two/);
  assert.throws(() => evaluateMissionRuntimeBenchmarkStability([
    run(20, 25, 90, 100),
    [{ queueSize: 1000, failedEnqueue: { p95Ms: 20 }, failedClaim: { p95Ms: 25 } }]
  ]), /different queue sizes/);
  assert.throws(() => evaluateMissionRuntimeBenchmarkStability([
    run(20, 25, 90, 100),
    run(20, 25, Number.NaN, 100)
  ]), /measurement is invalid/);
});
