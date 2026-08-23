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

const goodBenchmark = async () => [
  { queueSize: 1000, samples: 15, failedEnqueue: { p95Ms: 20 }, failedClaim: { p95Ms: 25 } },
  { queueSize: 5000, samples: 15, failedEnqueue: { p95Ms: 90 }, failedClaim: { p95Ms: 100 } }
];

test('qualifies clean exact-SHA mission runtime evidence with runtime fingerprint and digest', async () => {
  const report = await qualifyMissionRuntime({
    expectedSha: SHA,
    runner: fakeRunner(),
    benchmark: goodBenchmark,
    runtimeFingerprint: () => RUNTIME
  });
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.gitSha, SHA);
  assert.equal(report.cleanWorktree, true);
  assert.deepEqual(report.runtime, RUNTIME);
  assert.equal(report.tests.passed, true);
  assert.equal(report.benchmark.evaluation.ready, true);
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
    benchmark: goodBenchmark,
    runtimeFingerprint: () => ({ nodeVersion: '22', platform: 'linux', arch: 'x64' })
  }), /runtime fingerprint requires nodeVersion/);
});

test('fails closed on dirty worktree', async () => {
  await assert.rejects(() => qualifyMissionRuntime({ runner: fakeRunner({ status: ' M agents/mission-queue.mjs' }), benchmark: goodBenchmark }), /clean worktree/);
});

test('fails closed on SHA mismatch', async () => {
  await assert.rejects(() => qualifyMissionRuntime({ expectedSha: 'b'.repeat(40), runner: fakeRunner(), benchmark: goodBenchmark }), /git SHA mismatch/);
});

test('does not benchmark when mission runtime tests fail', async () => {
  let benchmarkCalled = false;
  await assert.rejects(() => qualifyMissionRuntime({
    runner: fakeRunner({ failTest: true }),
    benchmark: async () => { benchmarkCalled = true; return []; }
  }), /mission runtime tests failed/);
  assert.equal(benchmarkCalled, false);
});

test('returns NOT READY when benchmark budget fails', async () => {
  const report = await qualifyMissionRuntime({
    runner: fakeRunner(),
    runtimeFingerprint: () => RUNTIME,
    benchmark: async () => [
      { queueSize: 1000, samples: 15, failedEnqueue: { p95Ms: 20 }, failedClaim: { p95Ms: 25 } },
      { queueSize: 5000, samples: 15, failedEnqueue: { p95Ms: 200 }, failedClaim: { p95Ms: 200 } }
    ]
  });
  assert.equal(report.benchmark.evaluation.ready, false);
  assert.equal(report.readiness, 'NOT READY');
  assert.equal(verifyMissionRuntimeEvidenceDigest(report), true);
});
