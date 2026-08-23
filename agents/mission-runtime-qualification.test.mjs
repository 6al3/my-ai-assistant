import test from 'node:test';
import assert from 'node:assert/strict';
import { qualifyMissionRuntime } from './mission-runtime-qualification.mjs';

const SHA = 'a'.repeat(40);

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

test('qualifies clean exact-SHA mission runtime evidence', async () => {
  const report = await qualifyMissionRuntime({ expectedSha: SHA, runner: fakeRunner(), benchmark: goodBenchmark });
  assert.equal(report.gitSha, SHA);
  assert.equal(report.cleanWorktree, true);
  assert.equal(report.tests.passed, true);
  assert.equal(report.benchmark.evaluation.ready, true);
  assert.equal(report.readiness, 'LAB READY');
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
    benchmark: async () => [
      { queueSize: 1000, samples: 15, failedEnqueue: { p95Ms: 20 }, failedClaim: { p95Ms: 25 } },
      { queueSize: 5000, samples: 15, failedEnqueue: { p95Ms: 200 }, failedClaim: { p95Ms: 200 } }
    ]
  });
  assert.equal(report.benchmark.evaluation.ready, false);
  assert.equal(report.readiness, 'NOT READY');
});
