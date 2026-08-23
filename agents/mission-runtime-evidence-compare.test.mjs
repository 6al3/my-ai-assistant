import test from 'node:test';
import assert from 'node:assert/strict';
import { computeMissionRuntimeEvidenceDigest } from './mission-runtime-qualification.mjs';
import { compareMissionRuntimeEvidence } from './mission-runtime-evidence-compare.mjs';

function report({ sha = 'a'.repeat(40), cpuModel = 'Test CPU', enqueue = [10, 11], claim = [8, 9], readiness = 'LAB READY' } = {}) {
  const evidence = {
    schemaVersion: 4,
    gitSha: sha,
    cleanWorktree: true,
    runtime: {
      nodeVersion: 'v22.0.0',
      platform: 'linux',
      arch: 'x64',
      cpuModel,
      logicalCpus: 8,
      totalMemoryMiB: 16384
    },
    tests: { command: 'npm run test:mission-runtime', passed: true, durationMs: 100 },
    benchmark: {
      queueSizes: [1000, 5000],
      samples: 15,
      runCount: 2,
      durationMs: 100,
      runs: [
        [
          { queueSize: 1000, enqueue: { p95Ms: enqueue[0] }, claim: { p95Ms: claim[0] } },
          { queueSize: 5000, enqueue: { p95Ms: enqueue[1] }, claim: { p95Ms: claim[1] } }
        ],
        [
          { queueSize: 1000, enqueue: { p95Ms: enqueue[0] }, claim: { p95Ms: claim[0] } },
          { queueSize: 5000, enqueue: { p95Ms: enqueue[1] }, claim: { p95Ms: claim[1] } }
        ]
      ],
      evaluations: [{ ready: true }, { ready: true }],
      stability: { ready: true },
      budgetsReady: true,
      ready: readiness === 'LAB READY'
    },
    readiness
  };
  return { ...evidence, evidenceDigest: computeMissionRuntimeEvidenceDigest(evidence) };
}

test('accepts comparable stable reports from the same SHA and runtime', () => {
  const result = compareMissionRuntimeEvidence([
    report(),
    report({ enqueue: [10.5, 10.8], claim: [8.2, 9.1] })
  ]);
  assert.equal(result.ready, true);
  assert.equal(result.readiness, 'LAB READY');
  assert.equal(result.runtimeComparable, true);
});

test('fails closed on tampered report digest', () => {
  const tampered = report();
  tampered.runtime.cpuModel = 'tampered';
  assert.throws(() => compareMissionRuntimeEvidence([report(), tampered]), /digest is invalid/);
});

test('rejects mixed git SHAs', () => {
  assert.throws(
    () => compareMissionRuntimeEvidence([report(), report({ sha: 'b'.repeat(40) })]),
    /same git SHA/
  );
});

test('rejects different runtime fingerprints by default', () => {
  assert.throws(
    () => compareMissionRuntimeEvidence([report(), report({ cpuModel: 'Different CPU' })]),
    /same runtime fingerprint/
  );
});

test('marks noisy cross-report performance as NOT READY', () => {
  const result = compareMissionRuntimeEvidence([
    report({ enqueue: [10, 10], claim: [10, 10] }),
    report({ enqueue: [20, 20], claim: [10, 10] })
  ], { maxCrossReportRelativeP95Spread: 0.25 });
  assert.equal(result.ready, false);
  assert.equal(result.readiness, 'NOT READY');
  assert.ok(result.comparisons.some(item => item.operation === 'enqueue' && item.withinBudget === false));
});

test('rejects NOT READY evidence by default', () => {
  assert.throws(
    () => compareMissionRuntimeEvidence([report(), report({ readiness: 'NOT READY' })]),
    /not LAB READY/
  );
});
