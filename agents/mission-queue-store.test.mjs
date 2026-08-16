import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MissionQueueStore } from './mission-queue-store.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dig-queue-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, file: path.join(root, 'nested', 'missions.json') };
}

test('missing store loads an empty versioned snapshot', async t => {
  const { file } = await fixture(t);
  const store = new MissionQueueStore(file);
  assert.deepEqual(await store.load(), { version: 1, missions: [] });
});

test('save then load round-trips mission state', async t => {
  const { file } = await fixture(t);
  const store = new MissionQueueStore(file);
  const missions = [{ id: 'm1', task: 'synthetic QA', status: 'queued', attempts: 0 }];
  await store.save(missions);
  const loaded = await store.load();
  assert.equal(loaded.version, 1);
  assert.ok(Number.isFinite(loaded.savedAt));
  assert.deepEqual(loaded.missions, missions);
});

test('save leaves valid JSON at the target path and no temp file', async t => {
  const { file } = await fixture(t);
  const store = new MissionQueueStore(file);
  await store.save([{ id: 'm1' }]);
  const raw = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(raw.version, 1);
  await assert.rejects(readFile(`${file}.tmp`, 'utf8'), error => error?.code === 'ENOENT');
});

test('corrupt JSON is rejected instead of silently resetting state', async t => {
  const { file } = await fixture(t);
  const store = new MissionQueueStore(file);
  await store.save([]);
  await writeFile(file, '{broken-json', 'utf8');
  await assert.rejects(() => store.load(), SyntaxError);
});

test('unsupported snapshot version is rejected', async t => {
  const { file } = await fixture(t);
  const store = new MissionQueueStore(file);
  await store.save([]);
  await writeFile(file, JSON.stringify({ version: 99, missions: [] }), 'utf8');
  await assert.rejects(() => store.load(), /unsupported mission queue state/);
});

test('malformed missions collection is rejected', async t => {
  const { file } = await fixture(t);
  const store = new MissionQueueStore(file);
  await store.save([]);
  await writeFile(file, JSON.stringify({ version: 1, missions: {} }), 'utf8');
  await assert.rejects(() => store.load(), /unsupported mission queue state/);
});
