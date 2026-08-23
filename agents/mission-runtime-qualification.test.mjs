import test from 'node:test';
import assert from 'node:assert/strict';
import { computeMissionRuntimeEvidenceDigest, qualifyMissionRuntime, verifyMissionRuntimeEvidenceDigest } from './mission-runtime-qualification.mjs';

const SHA = 'a'.repeat(40);
const RUNTIME = { nodeVersion: 'v22.0.0', platform: 'linux', arch: 'x64' };

function fakeRunner({ status = '', failTest = false } = {}) {
  return async (command, args) => {
    if (command === 'git' && args[0] === 'rev-parse') return { stdout: `${SHA}\n`, stderr: '' };
    if (command === 'git' && args[0] === 'status') return { stdout: status, stderr: '' };
    if (command === 'npm') {
      if (failTest) throw new Error('mission runtime tests failed');
      return { stdout: 'ok', stderr: '' };
    }
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
  };
}

const stableRun = (enqueue1000 = 20, claim1000 = 25, enqueue5000 = 90, claim5000 = 100) => [
  { queueSize: 1000, samples: 15, failedEnqueue: { p95Ms: enqueue1000 }, failedClaim: { p95Ms: claim1000 } },
  { queueSize: 5000, samples: 15, failedEnqueue: { p95Ms: enqueue5000 }, failedClaim: { p95Ms: claim5000 } }
];

function benchmarkSequence(sequence) {
  let index = 0;
  return async () => sequence[index++];
}

test('qualifies clean exact-SHA mission runtime evidence only after stable repeated benchmark runs', async () => {
  const report = await qualifyMissionRuntime({
    expectedSha: SHA,
    runner: fakeRunner(),
    benchmark: benchmarkSequence([
      stableRun(20, 25, 90, 100),
      stableRun(21, 24, 92, 98),
      stableRun(19, 26, 88, 101)
    ]),
    runtimeFingerprint: () => RUNTIME
  });
  assert.equal(report.schemaVersion, 3);
  assert.equal(report.gitSha, SHA);
  assert.equal(report.cleanWorktree, true);
  assert.deepEqual(report.runtime, RUNTIME);
  assert.equal(report.tests.passed, true);
  assert.equal(report.benchmark.runCount, 3);
  assert.equal(report.benchmark.evaluations.every(row => row.ready), true);
  assert.equal(report.benchmark.stability.ready, true);
  assert.equal(report.benchmark.ready, true);
  assert.equal(report.readiness, 'LAB READY');
  assert.match(report.evidenceDigest, /^[0-9a-f]{64}$/);
  assert.equal(verifyMissionRuntimeEvidenceDigest(report), true);
});

test('evidence digest is canonical across object key ordering and detects tampering', () => {
  const left = { z: 1, nested: { b: 2, a: 1 }, list: [{ y: 2, x: 1 }] };
  const right = { list: [{ x: 1, y: 2 }], nested: { a: 1, b: 2 }, z: 1 };
  assert.equal(computeMissionRuntimeEvidenceDigest(left), computeMissionRuntimeEvidenceDigest(right));

  const report = { ...left, evidenceDigest: computeMissionRuntimeEvidenceDigest(left) };
  assert.equal(verifyMissionRuntimeEvidenceDigest(report), true);
  report.z = 2;
  assert.equal(verifyMissionRuntimeEvidenceDigest(report), false);
});

test('fails closed on invalid runtime fingerprint', async () => {
  await assert.rejects(() => qualifyMissionRuntime({
    runner: fakeRunner(),
    benchmark: benchmarkSequence([stableRun(), stableRun(), stableRun()]),
    runtimeFingerprint: () => ({ nodeVersion: '22', platform: 'linux', arch: 'x64' })
  }), /runtime fingerprint requires nodeVersion/);
});

test('fails closed on invalid benchmark run count before running tests', async () => {
  let npmCalled = false;
  const runner = async (command, args) => {
    if (command === 'git' && args[0] === 'rev-parse') return { stdout: `${SHA}\n`, stderr: '' };
    if (command === 'git' && args[0] === 'status') return { stdout: '', stderr: '' };
    if (command === 'npm') npmCalled = true;
    return { stdout: '', stderr: '' };
  };
  await assert.rejects(() => qualifyMissionRuntime({ benchmarkRuns: 1, runner }), /benchmarkRuns/);
  assert.equal(npmCalled, false);
});

test('fails closed on dirty worktree', async () => {
  await assert.rejects(() => qualifyMissionRuntime({ runner: fakeRunner({ status: ' M agents/mission-queue.mjs' }), benchmark: benchmarkSequence([stableRun(), stableRun(), stableRun()]) }), /clean worktree/);
});

test('fails closed on SHA mismatch', async () => {
  await assert.rejects(() => qualifyMissionRuntime({ expectedSha: 'b'.repeat(40), runner: fakeRunner(), benchmark: benchmarkSequence([stableRun(), stableRun(), stableRun()]) }), /git SHA mismatch/);
});

test('does not benchmark when mission runtime tests fail', async () => {
  let benchmarkCalled = false;
  await assert.rejects(() => qualifyMissionRuntime({
    runner: fakeRunner({ failTest: true }),
    benchmark: async () => { benchmarkCalled = true; return []; }
  }), /mission runtime tests failed/);
  assert.equal(benchmarkCalled, false);
});

test('returns NOT READY when any repeated benchmark run fails budget', async () => {
  const report = await qualifyMissionRuntime({
    runner: fakeRunner(),
    runtimeFingerprint: () => RUNTIME,
    benchmark: benchmarkSequence([
      stableRun(),
      stableRun(20, 25, 200, 200),
      stableRun()
    ])
  });
  assert.equal(report.benchmark.budgetsReady, false);
  assert.equal(report.benchmark.ready, false);
  assert.equal(report.readiness, 'NOT READY');
  assert.equal(verifyMissionRuntimeEvidenceDigest(report), true);
});

test('returns NOT READY when repeated p95 measurements are too unstable even if budgets pass', async () => {
  const report = await qualifyMissionRuntime({
    runner: fakeRunner(),
    runtimeFingerprint: () => RUNTIME,
    benchmark: benchmarkSequence([
      stableRun(10, 10, 50, 50),
      stableRun(20, 20, 90, 90),
      stableRun(11, 11, 52, 52)
    ])
  });
  assert.equal(report.benchmark.budgetsReady, true);
  assert.equal(report.benchmark.stability.ready, false);
  assert.equal(report.benchmark.ready, false);
  assert.equal(report.readiness, 'NOT READY');
});
