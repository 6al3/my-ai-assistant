import assert from 'node:assert/strict';
import test from 'node:test';
import { handleSyntheticWorkloadCommand, normalizeSyntheticWorkloadCommand } from './qubes-synthetic-workload-service.mjs';

function memoryStore() {
  const states = new Map();
  const key = command => `${command.runId}--${command.workloadId}`;
  return {
    async get(command) { return states.has(key(command)) ? structuredClone(states.get(key(command))) : null; },
    async put(command, state) { states.set(key(command), structuredClone(state)); return `/tmp/${key(command)}.json`; },
    read(runId, workloadId) { return structuredClone(states.get(`${runId}--${workloadId}`)); }
  };
}

const startCommand = {
  action: 'start',
  runId: 'run-1',
  workloadId: 'synthetic-dag-v1',
  durationMs: 210,
  schedule: [
    { missionId: 'm-orchestrator', startMs: 0, durationMs: 20 },
    { missionId: 'm-coder', startMs: 40, durationMs: 80 }
  ]
};

test('normalizes a bounded deterministic workload schedule', () => {
  const normalized = normalizeSyntheticWorkloadCommand({ ...startCommand, schedule: [...startCommand.schedule].reverse() });
  assert.deepEqual(normalized.schedule.map(item => item.missionId), ['m-orchestrator', 'm-coder']);
  assert.equal(normalized.durationMs, 210);
});

test('rejects schedules that can escape workload duration or duplicate missions', () => {
  assert.throws(() => normalizeSyntheticWorkloadCommand({ ...startCommand, durationMs: 100, schedule: [{ missionId: 'm1', startMs: 90, durationMs: 20 }] }), /exceeds workload duration/);
  assert.throws(() => normalizeSyntheticWorkloadCommand({ ...startCommand, schedule: [{ missionId: 'm1', startMs: 0, durationMs: 10 }, { missionId: 'm1', startMs: 20, durationMs: 10 }] }), /duplicate missionId/);
  assert.throws(() => normalizeSyntheticWorkloadCommand({ ...startCommand, durationMs: 120001 }), /durationMs/);
  assert.throws(() => normalizeSyntheticWorkloadCommand({ ...startCommand, runId: '../escape' }), /unsupported characters/);
});

test('start persists bounded state and launches exactly one detached executor', async () => {
  const store = memoryStore();
  const spawned = [];
  const response = await handleSyntheticWorkloadCommand(startCommand, {
    store,
    now: () => 1234,
    spawnExecutor: statePath => { spawned.push(statePath); return 4242; }
  });
  assert.equal(response.ok, true);
  assert.equal(response.status, 'running');
  assert.deepEqual(spawned, ['/tmp/run-1--synthetic-dag-v1.json']);
  const state = store.read('run-1', 'synthetic-dag-v1');
  assert.equal(state.pid, 4242);
  assert.equal(state.status, 'running');
  assert.equal(state.startedAt, 1234);
  assert.equal(state.schedule.length, 2);
});

test('duplicate running start fails closed instead of spawning a second executor', async () => {
  const store = memoryStore();
  let spawns = 0;
  await handleSyntheticWorkloadCommand(startCommand, { store, spawnExecutor: () => (++spawns, 4242) });
  await assert.rejects(handleSyntheticWorkloadCommand(startCommand, { store, spawnExecutor: () => (++spawns, 4343) }), /already running/);
  assert.equal(spawns, 1);
});

test('stop uses state-based cancellation and never signals a possibly recycled PID', async () => {
  const store = memoryStore();
  await handleSyntheticWorkloadCommand(startCommand, { store, spawnExecutor: () => 4242, now: () => 1000 });
  const response = await handleSyntheticWorkloadCommand({ action: 'stop', runId: 'run-1', workloadId: 'synthetic-dag-v1' }, {
    store,
    now: () => 2000
  });
  assert.equal(response.status, 'stopped');
  const state = store.read('run-1', 'synthetic-dag-v1');
  assert.equal(state.status, 'stopped');
  assert.equal(state.stoppedAt, 2000);
  assert.equal(state.pid, 4242, 'PID is evidence only; stop does not signal it');
});

test('stop is idempotent when no workload state exists', async () => {
  const response = await handleSyntheticWorkloadCommand({ action: 'stop', runId: 'missing-run', workloadId: 'synthetic-dag-v1' }, { store: memoryStore() });
  assert.deepEqual(response, { ok: true, action: 'stop', runId: 'missing-run', workloadId: 'synthetic-dag-v1', status: 'not-running' });
});

test('repeated stop preserves the original stoppedAt timestamp', async () => {
  const store = memoryStore();
  await handleSyntheticWorkloadCommand(startCommand, { store, spawnExecutor: () => 4242, now: () => 1000 });
  await handleSyntheticWorkloadCommand({ action: 'stop', runId: 'run-1', workloadId: 'synthetic-dag-v1' }, { store, now: () => 2000 });
  await handleSyntheticWorkloadCommand({ action: 'stop', runId: 'run-1', workloadId: 'synthetic-dag-v1' }, { store, now: () => 3000 });
  assert.equal(store.read('run-1', 'synthetic-dag-v1').stoppedAt, 2000);
});
