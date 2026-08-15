import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WorkerAuthenticator, AuthenticatedCoordinator } from './worker-protocol.mjs';
import { DurableMissionQueue } from '../agents/durable-mission-queue.mjs';

const SECRET_A = 'a'.repeat(64);
const SECRET_B = 'b'.repeat(64);
const tempStore = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dig-auth-'));
  return { dir, filePath: path.join(dir, 'missions.json') };
};

function fixture() {
  const { dir, filePath } = tempStore();
  let now = 1_000;
  const clock = () => now;
  const queue = new DurableMissionQueue({ filePath, leaseMs: 100, now: clock, lockRetryMs: 1 });
  const auth = new WorkerAuthenticator({ secrets: { a: SECRET_A, b: SECRET_B }, now: clock, maxClockSkewMs: 50 });
  const coordinator = new AuthenticatedCoordinator({ queue, authenticator: auth });
  return { dir, queue, auth, coordinator, advance: ms => { now += ms; } };
}

test('authenticated worker can claim and complete with fenced lease', async t => {
  const f = fixture(); t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  const mission = await f.queue.enqueue({ task: 'safe job', requiredCapabilities: ['coder'] });
  const claim = await f.coordinator.handle(f.auth.sign({ workerId: 'a', action: 'claim', payload: { capabilities: ['coder'] } }));
  assert.equal(claim.id, mission.id);
  const done = await f.coordinator.handle(f.auth.sign({ workerId: 'a', action: 'complete', payload: { missionId: mission.id, leaseToken: claim.leaseToken, result: { ok: true } } }));
  assert.equal(done.status, 'completed');
  assert.deepEqual(done.result, { ok: true });
});

test('tampering with authenticated payload is rejected', async t => {
  const f = fixture(); t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  const signed = f.auth.sign({ workerId: 'a', action: 'claim', payload: { capabilities: ['coder'] } });
  signed.payload.capabilities.push('qa');
  await assert.rejects(() => f.coordinator.handle(signed), /invalid worker signature/);
});

test('nonce replay is rejected', async t => {
  const f = fixture(); t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  const signed = f.auth.sign({ workerId: 'a', action: 'claim', payload: { capabilities: [] } });
  await f.coordinator.handle(signed);
  await assert.rejects(() => f.coordinator.handle(signed), /replay detected/);
});

test('stale timestamp is rejected before queue mutation', async t => {
  const f = fixture(); t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  const signed = f.auth.sign({ workerId: 'a', action: 'claim', timestamp: 900, payload: { capabilities: [] } });
  await assert.rejects(() => f.coordinator.handle(signed), /timestamp outside allowed skew/);
  assert.equal((await f.queue.stats()).running, 0);
});

test('worker identity cannot be forged with another worker secret', async t => {
  const f = fixture(); t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  const forgedByB = new WorkerAuthenticator({ secrets: { a: SECRET_B }, now: () => 1_000 });
  const signed = forgedByB.sign({ workerId: 'a', action: 'claim', payload: { capabilities: [] }, timestamp: 1_000 });
  await assert.rejects(() => f.coordinator.handle(signed), /invalid worker signature/);
});

test('old authenticated owner remains fenced after lease expiry and reclaim', async t => {
  const f = fixture(); t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  const mission = await f.queue.enqueue({ task: 'reassign' });
  const first = await f.coordinator.handle(f.auth.sign({ workerId: 'a', action: 'claim' }));
  f.advance(101);
  await f.queue.requeueExpired();
  const second = await f.coordinator.handle(f.auth.sign({ workerId: 'b', action: 'claim' }));
  await assert.rejects(() => f.coordinator.handle(f.auth.sign({ workerId: 'a', action: 'complete', payload: { missionId: mission.id, leaseToken: first.leaseToken } })), /not owned|stale|invalid/);
  const done = await f.coordinator.handle(f.auth.sign({ workerId: 'b', action: 'complete', payload: { missionId: mission.id, leaseToken: second.leaseToken, result: 'current' } }));
  assert.equal(done.result, 'current');
});
