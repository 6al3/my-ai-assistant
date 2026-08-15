import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FrameDecoder, encodeFrame } from './qubes-stdio-transport.mjs';
import { QubesWorkerClient } from './qubes-worker-client.mjs';
import { WorkerRequestState } from './worker-request-state.mjs';

const makePath = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dig-worker-recovery-')), 'requests.json');
const signer = { sign: async ({ action, payload }) => ({ workerId: 'worker', action, payload }) };
const decode = bytes => { const d = new FrameDecoder(); const out = d.push(bytes); d.finish(); return out[0]; };

test('lost response leaves durable request id that restart can reconcile', async () => {
  const filePath = makePath();
  let committedRequestId = null;
  const first = new QubesWorkerClient({
    signer,
    requestIdFactory: () => 'req-lost',
    requestState: new WorkerRequestState({ filePath }),
    exchange: async frame => {
      const envelope = decode(frame);
      committedRequestId = envelope.payload.requestId;
      throw new Error('simulated response loss after coordinator commit');
    }
  });

  await assert.rejects(() => first.claim(), error => error.requestId === 'req-lost');
  assert.equal(committedRequestId, 'req-lost');
  assert.equal(new WorkerRequestState({ filePath }).listPending().length, 1);

  const restarted = new QubesWorkerClient({
    signer,
    requestState: new WorkerRequestState({ filePath }),
    exchange: async frame => {
      const envelope = decode(frame);
      assert.equal(envelope.action, 'request-status');
      assert.equal(envelope.payload.requestId, 'req-lost');
      return encodeFrame({ ok: true, result: { requestId: 'req-lost', action: 'claim', status: 'completed', result: { id: 'mission-1' } } });
    }
  });

  const recovered = await restarted.recoverPending();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].state, 'completed');
  assert.equal(restarted.requestState.listPending().length, 0);
});

test('unknown coordinator outcome remains pending and is not invented', async () => {
  const filePath = makePath();
  const state = new WorkerRequestState({ filePath });
  await state.reserve({ action: 'complete', payload: { missionId: 'm1' }, requestId: 'req-unknown' });
  const client = new QubesWorkerClient({
    signer,
    requestState: state,
    exchange: async () => encodeFrame({ ok: true, result: null })
  });
  const recovered = await client.recoverPending();
  assert.equal(recovered[0].state, 'unresolved');
  assert.equal(state.get('req-unknown').requestId, 'req-unknown');
});

test('retry with same durable request id reuses identity instead of allocating a new one', async () => {
  const filePath = makePath();
  const state = new WorkerRequestState({ filePath });
  await state.reserve({ action: 'claim', payload: {}, requestId: 'req-retry' });
  let seen;
  const client = new QubesWorkerClient({
    signer,
    requestState: state,
    exchange: async frame => {
      seen = decode(frame).payload.requestId;
      return encodeFrame({ ok: true, result: { id: 'mission-retry' } });
    }
  });
  const result = await client.claim({ requestId: 'req-retry' });
  assert.equal(seen, 'req-retry');
  assert.equal(result.id, 'mission-retry');
  assert.equal(state.get('req-retry'), null);
});
