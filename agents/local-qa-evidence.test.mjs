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
  assert.equal(report.allPassed, true);
  assert.deepEqual(report.results.map(result => result.passed), [true, true]);
  assert.equal(report.gitSha, 'abc123');
  assert.match(report.digestSha256, /^[0-9a-f]{64}$/);
});

test('local QA evidence fails closed on any failed shard', async () => {
  const report = await runLocalQaEvidence({ shards, run: fakeRun([ok, fail]), git });
  assert.equal(report.allPassed, false);
  assert.deepEqual(report.results.map(result => result.passed), [true, false]);
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
  const timed = { ...ok, timedOut: true };
  const report = await runLocalQaEvidence({ shards: [shards[0]], run: fakeRun([timed]), git });
  assert.equal(report.allPassed, false);
  assert.equal(report.results[0].passed, false);
});
