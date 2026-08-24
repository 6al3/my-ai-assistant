import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DurableRequestJournal, digestWorkerCommand } from './durable-request-journal.mjs';
import { MissionQueue } from './mission-queue.mjs';

test('journal survives restart and rejects requestId command substitution', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dig-journal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'requests.json');
  const digest = digestWorkerCommand({ op: 'complete', body: { id: 'm1', workerId: 'w1', result: { ok: true } } });
  const first = await DurableRequestJournal.open(file);
  await first.begin({ requestId: 'r1', digest });
  await first.commit('r1', { ok: true, result: { id: 'm1' } });
  const restarted = await DurableRequestJournal.open(file);
  assert.equal(restarted.get('r1').status, 'committed');
  assert.deepEqual(restarted.get('r1').response, { ok: true, result: { id: 'm1' } });
  await assert.rejects(() => restarted.begin({ requestId: 'r1', digest: digestWorkerCommand({ op: 'complete', body: { id: 'm2' } }) }), /different command/);
});

test('failed begin rolls memory back and restart sees no phantom request', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dig-journal-begin-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'requests.json');
  const temp = `${file}.tmp`;
  const digest = digestWorkerCommand({ op: 'submit', body: { task: 'synthetic' } });
  const journal = await DurableRequestJournal.open(file);

  await mkdir(temp);
  await assert.rejects(() => journal.begin({ requestId: 'r-begin', digest }));
  assert.equal(journal.get('r-begin'), null);

  await rm(temp, { recursive: true, force: true });
  const restarted = await DurableRequestJournal.open(file);
  assert.equal(restarted.get('r-begin'), null);
});

test('failed commit restores pending state and restart sees last durable state', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dig-journal-commit-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'requests.json');
  const temp = `${file}.tmp`;
  const digest = digestWorkerCommand({ op: 'complete', body: { id: 'm1', workerId: 'w1', result: { ok: true } } });
  const journal = await DurableRequestJournal.open(file);
  await journal.begin({ requestId: 'r-commit', digest });
  const pending = journal.get('r-commit');

  await mkdir(temp);
  await assert.rejects(() => journal.commit('r-commit', { ok: true, result: { id: 'm1' } }));
  assert.deepEqual(journal.get('r-commit'), pending);
  assert.equal(journal.get('r-commit').status, 'pending');
  assert.equal(journal.get('r-commit').response, null);
  assert.equal(journal.get('r-commit').committedAt, null);

  await rm(temp, { recursive: true, force: true });
  const restarted = await DurableRequestJournal.open(file);
  assert.deepEqual(restarted.get('r-commit'), pending);
});

test('journal remains serialized after a failed save and accepts a later durable mutation', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dig-journal-serialize-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'requests.json');
  const temp = `${file}.tmp`;
  const firstDigest = digestWorkerCommand({ op: 'submit', body: { task: 'first' } });
  const secondDigest = digestWorkerCommand({ op: 'submit', body: { task: 'second' } });
  const journal = await DurableRequestJournal.open(file);

  await mkdir(temp);
  await assert.rejects(() => journal.begin({ requestId: 'r-first', digest: firstDigest }));
  assert.equal(journal.get('r-first'), null);

  await rm(temp, { recursive: true, force: true });
  await journal.begin({ requestId: 'r-second', digest: secondDigest });
  assert.equal(journal.get('r-second').status, 'pending');

  const restarted = await DurableRequestJournal.open(file);
  assert.equal(restarted.get('r-first'), null);
  assert.equal(restarted.get('r-second').status, 'pending');
});

test('duplicate completion after committed-response loss returns same result without a second mutation', () => {
  const queue = new MissionQueue();
  const mission = queue.enqueue({ task: 'synthetic work' });
  queue.claim({ id: 'worker-a' });
  const first = queue.complete(mission.id, 'worker-a', { value: 7 });
  const updatedAt = first.updatedAt;
  const retry = queue.complete(mission.id, 'worker-a', { value: 7 });
  assert.deepEqual(retry.result, { value: 7 });
  assert.equal(retry.updatedAt, updatedAt);
  assert.equal(queue.stats().completed, 1);
  assert.throws(() => queue.complete(mission.id, 'worker-a', { value: 8 }), /conflicts with committed result/);
  assert.throws(() => queue.complete(mission.id, 'worker-b', { value: 7 }), /conflicts with committed result/);
});
