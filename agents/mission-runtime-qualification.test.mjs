import test from 'node:test';
import assert from 'node:assert/strict';
import { computeMissionRuntimeEvidenceDigest, qualifyMissionRuntime, verifyMissionRuntimeEvidenceDigest } from './mission-runtime-qualification.mjs';

const SHA = 'a'.repeat(40);
const RUN_ID = '12345678-1234-4234-8234-123456789abc';
const NOW = Date.parse('2026-08-23T20:00:00.000Z');
const RUNTIME = { nodeVersion: 'v22.0.0', platform: 'linux', arch: 'x64', cpuModel: 'Synthetic CPU', logicalCpus: 4, totalMemoryMiB: 8192 };

function fakeRunner({ status = '', failTest = false } = {}) {
  return async (command, args) => {
    if (command === 'git' && args[0] === 'rev-parse') return { stdout: `${SHA}\n`, stderr: '' };
    if (command === 'git' && args[0] === 'status') return { stdout: status, stderr: '' };
    if (command === 'npm') { if (failTest) throw new Error('mission runtime tests failed'); return { stdout: 'ok', stderr: '' }; }
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
  };
}

const stableRun = (enqueue1000 = 20, claim1000 = 25, enqueue5000 = 90, claim5000 = 100) => [
  { queueSize: 1000, samples: 15, failedEnqueue: { p95Ms: enqueue1000 }, failedClaim: { p95Ms: claim1000 } },
  { queueSize: 5000, samples: 15, failedEnqueue: { p95Ms: enqueue5000 }, failedClaim: { p95Ms: claim5000 } }
];
function benchmarkSequence(sequence) { let index = 0; return async () => sequence[index++]; }
const identity = { executionIdFactory: () => RUN_ID, now: () => NOW };

test('qualifies clean exact-SHA evidence with unique execution identity and stable repeated benchmarks', async () => {
  const report = await qualifyMissionRuntime({
    expectedSha: SHA, runner: fakeRunner(), benchmark: benchmarkSequence([stableRun(20,25,90,100), stableRun(21,24,92,98), stableRun(19,26,88,101)]),
    runtimeFingerprint: () => RUNTIME, ...identity
  });
  assert.equal(report.schemaVersion, 5);
  assert.equal(report.qualificationRunId, RUN_ID);
  assert.equal(report.generatedAt, '2026-08-23T20:00:00.000Z');
  assert.equal(report.gitSha, SHA);
  assert.deepEqual(report.runtime, RUNTIME);
  assert.equal(report.benchmark.runCount, 3);
  assert.equal(report.benchmark.evaluations.every(row => row.ready), true);
  assert.equal(report.benchmark.stability.ready, true);
  assert.equal(report.readiness, 'LAB READY');
  assert.match(report.evidenceDigest, /^[0-9a-f]{64}$/);
  assert.equal(verifyMissionRuntimeEvidenceDigest(report), true);
});

test('execution identity and runtime fingerprint are part of evidence integrity', async () => {
  const report = await qualifyMissionRuntime({ runner: fakeRunner(), runtimeFingerprint: () => RUNTIME, benchmark: benchmarkSequence([stableRun(),stableRun(),stableRun()]), ...identity });
  assert.equal(verifyMissionRuntimeEvidenceDigest(report), true);
  report.qualificationRunId = '87654321-4321-4321-8321-cba987654321';
  assert.equal(verifyMissionRuntimeEvidenceDigest(report), false);
});

test('evidence digest is canonical across object key ordering and detects tampering', () => {
  const left = { z: 1, nested: { b: 2, a: 1 }, list: [{ y: 2, x: 1 }] };
  const right = { list: [{ x: 1, y: 2 }], nested: { a: 1, b: 2 }, z: 1 };
  assert.equal(computeMissionRuntimeEvidenceDigest(left), computeMissionRuntimeEvidenceDigest(right));
  const report = { ...left, evidenceDigest: computeMissionRuntimeEvidenceDigest(left) };
  assert.equal(verifyMissionRuntimeEvidenceDigest(report), true); report.z = 2; assert.equal(verifyMissionRuntimeEvidenceDigest(report), false);
});

test('fails closed on invalid runtime fingerprint or execution identity', async () => {
  await assert.rejects(() => qualifyMissionRuntime({ runner: fakeRunner(), benchmark: benchmarkSequence([stableRun(),stableRun(),stableRun()]), runtimeFingerprint: () => ({ nodeVersion:'22', platform:'linux', arch:'x64' }), ...identity }), /nodeVersion/);
  await assert.rejects(() => qualifyMissionRuntime({ runner: fakeRunner(), benchmark: benchmarkSequence([stableRun(),stableRun(),stableRun()]), runtimeFingerprint: () => RUNTIME, executionIdFactory: () => 'not-a-uuid', now: () => NOW }), /qualificationRunId/);
});

test('fails closed on invalid benchmark run count before running tests', async () => {
  let npmCalled = false;
  const runner = async (command,args) => { if (command==='git'&&args[0]==='rev-parse') return {stdout:`${SHA}\n`,stderr:''}; if (command==='git'&&args[0]==='status') return {stdout:'',stderr:''}; if (command==='npm') npmCalled=true; return {stdout:'',stderr:''}; };
  await assert.rejects(() => qualifyMissionRuntime({ benchmarkRuns: 1, runner, ...identity }), /benchmarkRuns/); assert.equal(npmCalled,false);
});

test('fails closed on dirty worktree, SHA mismatch, or test failure', async () => {
  await assert.rejects(() => qualifyMissionRuntime({ runner: fakeRunner({status:' M agents/mission-queue.mjs'}), benchmark: benchmarkSequence([stableRun(),stableRun(),stableRun()]), ...identity }), /clean worktree/);
  await assert.rejects(() => qualifyMissionRuntime({ expectedSha:'b'.repeat(40), runner:fakeRunner(), benchmark: benchmarkSequence([stableRun(),stableRun(),stableRun()]), ...identity }), /git SHA mismatch/);
  let called=false; await assert.rejects(() => qualifyMissionRuntime({ runner:fakeRunner({failTest:true}), benchmark:async()=>{called=true;return[];}, ...identity }), /mission runtime tests failed/); assert.equal(called,false);
});

test('returns NOT READY on budget failure or unstable repeated p95 measurements', async () => {
  const budgetFail = await qualifyMissionRuntime({ runner:fakeRunner(), runtimeFingerprint:()=>RUNTIME, benchmark: benchmarkSequence([stableRun(),stableRun(20,25,200,200),stableRun()]), ...identity });
  assert.equal(budgetFail.readiness,'NOT READY');
  const unstable = await qualifyMissionRuntime({ runner:fakeRunner(), runtimeFingerprint:()=>RUNTIME, benchmark: benchmarkSequence([stableRun(10,10,50,50),stableRun(20,20,90,90),stableRun(11,11,52,52)]), ...identity });
  assert.equal(unstable.benchmark.stability.ready,false); assert.equal(unstable.readiness,'NOT READY');
});
