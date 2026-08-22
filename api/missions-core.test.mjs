import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildMissionControlPlaneSnapshot, loadMissionControlPlaneSnapshot } from './missions-core.mjs';

function mission(overrides = {}) {
  return {
    id: 'm-1',
    task: 'secret task text that must never leave the server',
    status: 'running',
    requiredCapabilities: ['coder', 'coder'],
    attempts: 1,
    workerId: 'worker-secret',
    result: { secret: 'hidden-result' },
    error: 'hidden-error',
    metadata: {
      executionPhase: 'parallel-work',
      privatePrompt: 'hidden-metadata'
    },
    updatedAt: 1_787_000_000_000,
    ...overrides
  };
}

test('snapshot exposes only the documented read-only control-plane fields', () => {
  const snapshot = buildMissionControlPlaneSnapshot({ version: 1, missions: [mission()] });
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.count, 1);
  assert.match(snapshot.revision, /^[0-9a-f]{64}$/);
  assert.deepEqual(snapshot.missions[0], {
    id: 'm-1',
    status: 'running',
    executionPhase: 'parallel-work',
    requiredCapabilities: ['coder'],
    attempts: 1,
    maxAttempts: 3,
    updatedAt: new Date(1_787_000_000_000).toISOString()
  });
  const serialized = JSON.stringify(snapshot);
  for (const forbidden of ['secret task text', 'worker-secret', 'hidden-result', 'hidden-error', 'hidden-metadata', 'privatePrompt']) {
    assert.equal(serialized.includes(forbidden), false, `telemetry leaked ${forbidden}`);
  }
});

test('revision is deterministic across mission ordering and changes when safe state changes', () => {
  const a = mission({ id: 'a', status: 'queued', attempts: 0 });
  const b = mission({ id: 'b', status: 'completed', attempts: 2 });
  const first = buildMissionControlPlaneSnapshot({ version: 1, missions: [b, a] });
  const reordered = buildMissionControlPlaneSnapshot({ version: 1, missions: [a, b] });
  assert.equal(first.revision, reordered.revision);
  const changed = buildMissionControlPlaneSnapshot({ version: 1, missions: [a, { ...b, status: 'failed' }] });
  assert.notEqual(first.revision, changed.revision);
});

test('malformed mission snapshots fail closed', () => {
  assert.throws(() => buildMissionControlPlaneSnapshot(null), /unsupported/);
  assert.throws(() => buildMissionControlPlaneSnapshot({ version: 2, missions: [] }), /unsupported/);
  assert.throws(() => buildMissionControlPlaneSnapshot({ version: 1, missions: [mission({ status: 'unknown' })] }), /status/);
  assert.throws(() => buildMissionControlPlaneSnapshot({ version: 1, missions: [mission({ updatedAt: 'yesterday' })] }), /timestamp/);
  assert.throws(() => buildMissionControlPlaneSnapshot({ version: 1, missions: [mission({ requiredCapabilities: [7] })] }), /capabilities/);
});

test('file loader supports missing store as empty but rejects corrupt snapshots', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dig-mission-api-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'missions.json');

  const empty = await loadMissionControlPlaneSnapshot(file);
  assert.equal(empty.count, 0);

  await writeFile(file, '{broken json', 'utf8');
  await assert.rejects(() => loadMissionControlPlaneSnapshot(file));
  await assert.rejects(() => loadMissionControlPlaneSnapshot(''), /not configured/);
});
