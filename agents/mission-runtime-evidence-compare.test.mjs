import test from 'node:test';
import assert from 'node:assert/strict';
import { computeMissionRuntimeEvidenceDigest } from './mission-runtime-qualification.mjs';
import { compareMissionRuntimeEvidence } from './mission-runtime-evidence-compare.mjs';

const NOW = Date.parse('2026-08-23T20:00:00.000Z');
let sequence = 0;
function report({ sha = 'a'.repeat(40), cpuModel = 'Test CPU', enqueue = [10, 11], claim = [8, 9], readiness = 'LAB READY', runId = null, generatedAt = '2026-08-23T19:30:00.000Z' } = {}) {
  sequence += 1;
  const id = runId ?? `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
  const evidence = {
    schemaVersion: 5,
    qualificationRunId: id,
    generatedAt,
    gitSha: sha,
    cleanWorktree: true,
    runtime: { nodeVersion: 'v22.0.0', platform: 'linux', arch: 'x64', cpuModel, logicalCpus: 8, totalMemoryMiB: 16384 },
    tests: { command: 'npm run test:mission-runtime', passed: true, durationMs: 100 },
    benchmark: {
      queueSizes: [1000, 5000], samples: 15, runCount: 2, durationMs: 100,
      runs: [0, 1].map(() => [
        { queueSize: 1000, failedEnqueue: { p95Ms: enqueue[0] }, failedClaim: { p95Ms: claim[0] } },
        { queueSize: 5000, failedEnqueue: { p95Ms: enqueue[1] }, failedClaim: { p95Ms: claim[1] } }
      ]),
      evaluations: [{ ready: true }, { ready: true }], stability: { ready: true }, budgetsReady: true, ready: readiness === 'LAB READY'
    },
    readiness
  };
  return { ...evidence, evidenceDigest: computeMissionRuntimeEvidenceDigest(evidence) };
}
const compare = reports => compareMissionRuntimeEvidence(reports, { now: () => NOW });

test('accepts distinct fresh reports using the real failedEnqueue/failedClaim benchmark schema', () => {
  const result = compare([report(), report({ enqueue: [10.5, 10.8], claim: [8.2, 9.1] })]);
  assert.equal(result.ready, true);
  assert.equal(result.readiness, 'LAB READY');
  assert.equal(result.reportCount, 2);
});

test('rejects replayed qualification run identity', () => {
  const runId = '11111111-1111-4111-8111-111111111111';
  assert.throws(() => compare([report({ runId }), report({ runId, enqueue: [10.1, 10.9] })]), /unique qualification runs/);
});

test('rejects an identical copied evidence report', () => {
  const first = report();
  assert.throws(() => compare([first, structuredClone(first)]), /unique qualification runs|duplicate mission runtime evidence/);
});

test('rejects stale and materially future-dated reports', () => {
  assert.throws(() => compare([report({ generatedAt: '2026-08-21T00:00:00.000Z' }), report()]), /too old/);
  assert.throws(() => compare([report({ generatedAt: '2026-08-23T20:10:01.000Z' }), report()]), /future-dated/);
});

test('fails closed on tampered report digest', () => {
  const tampered = report(); tampered.runtime.cpuModel = 'tampered';
  assert.throws(() => compare([report(), tampered]), /digest is invalid/);
});

test('rejects mixed git SHAs and runtime fingerprints', () => {
  assert.throws(() => compare([report(), report({ sha: 'b'.repeat(40) })]), /same git SHA/);
  assert.throws(() => compare([report(), report({ cpuModel: 'Different CPU' })]), /same runtime fingerprint/);
});

test('marks noisy cross-report performance as NOT READY', () => {
  const result = compareMissionRuntimeEvidence([
    report({ enqueue: [10, 10], claim: [10, 10] }),
    report({ enqueue: [20, 20], claim: [10, 10] })
  ], { maxCrossReportRelativeP95Spread: 0.25, now: () => NOW });
  assert.equal(result.ready, false);
  assert.ok(result.comparisons.some(item => item.operation === 'enqueue' && item.withinBudget === false));
});

test('rejects NOT READY evidence by default', () => {
  assert.throws(() => compare([report(), report({ readiness: 'NOT READY' })]), /not LAB READY/);
});
