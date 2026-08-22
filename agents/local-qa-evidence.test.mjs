import assert from 'node:assert/strict';
import test from 'node:test';
import { runLocalQaEvidence } from './local-qa-evidence.mjs';

function fakeRun(outcomes) {
  let index = 0;
  return async () => outcomes[index++];
}

const ok = { exitCode: 0, signal: null, timedOut: false, durationMs: 5, stdout: 'ok', stderr: '' };
const fail = { exitCode: 1, signal: null, timedOut: false, durationMs: 5, stdout: '', stderr: 'boom' };

const shards = [
  { name: 'a', command: ['node', ['a.test.mjs']] },
  { name: 'b', command: ['node', ['b.test.mjs']] }
];

const git = async () => ({ sha: 'abc123', clean: true });

test('local QA evidence passes only when every shard passes', async () => {
  const report = await runLocalQaEvidence({ shards, run: fakeRun([ok, ok]), git });
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.allPassed, true);
  assert.deepEqual(report.results.map(result => result.passed), [true, true]);
  assert.equal(report.gitSha, 'abc123');
  assert.match(report.digestSha256, /^[0-9a-f]{64}$/);
  assert.equal(report.results[0].stdout.bytes, 2);
  assert.match(report.results[0].stdout.sha256, /^[0-9a-f]{64}$/);
  assert.equal(report.results[0].stdout.diagnosticTail, undefined);
});

test('local QA evidence fails closed on any failed shard', async () => {
  const report = await runLocalQaEvidence({ shards, run: fakeRun([ok, fail]), git });
  assert.equal(report.allPassed, false);
  assert.deepEqual(report.results.map(result => result.passed), [true, false]);
  assert.equal(report.results[1].stderr.diagnosticTail, 'boom');
});

test('failed diagnostic tails redact common secret forms and remain bounded', async () => {
  const longPrefix = 'x'.repeat(5000);
  const secret = 'token=super-secret-value';
  const outcome = { ...fail, stderr: `${longPrefix}\n${secret}\nAuthorization: bearer-value\nghp_abcdefghijklmnopqrstuvwxyz123456` };
  const report = await runLocalQaEvidence({ shards: [shards[0]], run: fakeRun([outcome]), git });
  const evidence = report.results[0].stderr;
  assert.equal(evidence.diagnosticTailTruncated, true);
  assert.doesNotMatch(evidence.diagnosticTail, /super-secret-value|bearer-value|ghp_abcdefghijklmnopqrstuvwxyz123456/);
  assert.match(evidence.diagnosticTail, /\[REDACTED/);
  assert.ok(Buffer.byteLength(evidence.diagnosticTail) <= 4096);
});

test('successful shards do not store raw output even when output is large', async () => {
  const outcome = { ...ok, stdout: 'y'.repeat(10000) };
  const report = await runLocalQaEvidence({ shards: [shards[0]], run: fakeRun([outcome]), git });
  assert.equal(report.results[0].stdout.bytes, 10000);
  assert.equal(report.results[0].stdout.diagnosticTail, undefined);
});

test('local QA evidence rejects dirty worktrees', async () => {
  await assert.rejects(
    () => runLocalQaEvidence({ shards, run: fakeRun([ok, ok]), git: async () => ({ sha: 'abc123', clean: false }) }),
    /clean git worktree/
  );
});

test('local QA evidence rejects DIG_GIT_SHA mismatch', async () => {
  const previous = process.env.DIG_GIT_SHA;
  process.env.DIG_GIT_SHA = 'different';
  try {
    await assert.rejects(() => runLocalQaEvidence({ shards, run: fakeRun([ok, ok]), git }), /DIG_GIT_SHA mismatch/);
  } finally {
    if (previous === undefined) delete process.env.DIG_GIT_SHA;
    else process.env.DIG_GIT_SHA = previous;
  }
});

test('timeouts are failures even if exit code is zero', async () => {
  const timed = { ...ok, timedOut: true, stderr: 'token=timeout-secret' };
  const report = await runLocalQaEvidence({ shards: [shards[0]], run: fakeRun([timed]), git });
  assert.equal(report.allPassed, false);
  assert.equal(report.results[0].passed, false);
  assert.doesNotMatch(report.results[0].stderr.diagnosticTail, /timeout-secret/);
});
