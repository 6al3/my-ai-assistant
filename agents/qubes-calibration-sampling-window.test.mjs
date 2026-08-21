import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveDurationBoundSampling, validateSampleOffsets } from './qubes-calibration-sampling-window.mjs';

test('derives five samples entirely inside the canonical 210ms workload', () => {
  const policy = deriveDurationBoundSampling({ workloadDurationMs: 210, sampleCount: 5 });
  assert.equal(policy.intervalMs, 52);
  assert.equal(policy.lastSampleOffsetMs, 208);
  assert.equal(policy.derived, true);
  assert.equal(validateSampleOffsets([0, 52, 104, 156, 208], policy), true);
});

test('rejects the old 1000ms interval for a 210ms workload', () => {
  assert.throws(() => deriveDurationBoundSampling({
    workloadDurationMs: 210,
    sampleCount: 5,
    requestedIntervalMs: 1000
  }), /sampling window exceeds active workload/);
});

test('accepts an explicit interval only when the last sample remains active', () => {
  const policy = deriveDurationBoundSampling({
    workloadDurationMs: 210,
    sampleCount: 5,
    requestedIntervalMs: 50
  });
  assert.equal(policy.lastSampleOffsetMs, 200);
  assert.equal(policy.derived, false);
});

test('fails closed when workload is too short for requested sample density', () => {
  assert.throws(() => deriveDurationBoundSampling({ workloadDurationMs: 4, sampleCount: 5, reserveMs: 1 }), /too short/);
});

test('sample timing evidence rejects post-workload and non-monotonic offsets', () => {
  const policy = deriveDurationBoundSampling({ workloadDurationMs: 210, sampleCount: 3, requestedIntervalMs: 100 });
  assert.throws(() => validateSampleOffsets([0, 100, 210], policy), /outside active workload/);
  assert.throws(() => validateSampleOffsets([0, 100, 90], policy), /monotonic/);
});

test('single-sample calibration has no interval requirement', () => {
  const policy = deriveDurationBoundSampling({ workloadDurationMs: 210, sampleCount: 1 });
  assert.equal(policy.intervalMs, 0);
  assert.equal(policy.lastSampleOffsetMs, 0);
});
