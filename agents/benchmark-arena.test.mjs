import assert from 'node:assert/strict';
import test from 'node:test';
import { MissionQueue } from './mission-queue.mjs';
import { BenchmarkArena, scheduleCompetition } from './benchmark-arena.mjs';

test('review mission is blocked until every independent attempt completes', () => {
  const q = new MissionQueue();
  const { attempts, review } = scheduleCompetition(q, {
    task: 'harden mission queue', competitors: ['coder', 'system']
  });
  assert.equal(q.stats().blocked, 1);
  assert.equal(q.claim({ id: 'qa-early', capabilities: ['qa'] }), null);

  for (const [i, attempt] of attempts.entries()) {
    const capability = attempt.requiredCapabilities[0];
    const claimed = q.claim({ id: `worker-${i}`, capabilities: [capability] });
    assert.equal(claimed.id, attempt.id);
    q.complete(attempt.id, `worker-${i}`, { ok: true });
  }

  assert.equal(q.stats().blocked, 0);
  assert.equal(q.claim({ id: 'qa', capabilities: ['qa'] }).id, review.id);
});

test('arena retains strongest weighted approach and records lessons', () => {
  const arena = new BenchmarkArena({ now: () => 123 });
  const c = arena.create({ task: 'queue reliability', competitors: ['coder', 'system'] });
  arena.submit(c.id, 'coder', {
    output: { patch: 'A' }, correctness: 0.98, robustness: 0.95, qa: 1,
    regressionRisk: 0.05, latencyMs: 20, resourceUnits: 3,
    failures: [], lessons: ['lease tests caught race']
  });
  arena.submit(c.id, 'system', {
    output: { patch: 'B' }, correctness: 0.90, robustness: 0.92, qa: 0.9,
    regressionRisk: 0.1, latencyMs: 10, resourceUnits: 2,
    failures: ['missed owner check'], lessons: ['faster but less correct']
  });
  const result = arena.finalize(c.id);
  assert.equal(result.status, 'finalized');
  assert.equal(result.winner, 'coder');
  assert.match(result.decision.whyWon, /highest weighted score/);
  assert.equal(result.decision.failures.length, 1);
  assert.equal(result.decision.lessons.length, 2);
});

test('arena rejects invalid metrics and premature finalization', () => {
  const arena = new BenchmarkArena();
  const c = arena.create({ task: 'x', competitors: ['a', 'b'] });
  assert.throws(() => arena.submit(c.id, 'a', { correctness: 2, robustness: 1, qa: 1, regressionRisk: 0, latencyMs: 1, resourceUnits: 1 }), /between 0 and 1/);
  assert.throws(() => arena.finalize(c.id), /at least two submissions/);
});
