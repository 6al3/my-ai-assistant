import assert from 'node:assert/strict';
import test from 'node:test';
import { signWorkerEnvelope, WorkerEnvelopeVerifier } from './worker-transport-envelope.mjs';

const secret = '0123456789abcdef0123456789abcdef';

test('accepts one authenticated request and rejects replay', () => {
  const now = 1_700_000_000_000;
  const verifier = new WorkerEnvelopeVerifier({ secret, now: () => now });
  const envelope = signWorkerEnvelope({ requestId: 'req-1', issuedAt: now, op: 'claim', body: { workerId: 'coder@session-a' }, secret });
  assert.deepEqual(verifier.verify(envelope), {
    requestId: 'req-1', op: 'claim', body: { workerId: 'coder@session-a' }, issuedAt: now
  });
  assert.throws(() => verifier.verify(envelope), /replay detected/);
});

test('rejects tampered operation, body, timestamp, and mac', () => {
  const now = 1_700_000_000_000;
  for (const mutate of [
    value => ({ ...value, op: 'complete' }),
    value => ({ ...value, body: { missionId: 'other' } }),
    value => ({ ...value, issuedAt: value.issuedAt + 1 }),
    value => ({ ...value, mac: `0${value.mac.slice(1)}` })
  ]) {
    const verifier = new WorkerEnvelopeVerifier({ secret, now: () => now });
    const signed = signWorkerEnvelope({ requestId: crypto.randomUUID(), issuedAt: now, op: 'claim', body: { workerId: 'worker-a' }, secret });
    assert.throws(() => verifier.verify(mutate(signed)), /authentication failed/);
  }
});

test('rejects expired or future-skewed requests before mutation', () => {
  const now = 1_700_000_000_000;
  const verifier = new WorkerEnvelopeVerifier({ secret, maxSkewMs: 5_000, now: () => now });
  const old = signWorkerEnvelope({ requestId: 'old', issuedAt: now - 5_001, op: 'claim', secret });
  const future = signWorkerEnvelope({ requestId: 'future', issuedAt: now + 5_001, op: 'claim', secret });
  assert.throws(() => verifier.verify(old), /expired/);
  assert.throws(() => verifier.verify(future), /expired/);
});

test('failed authentication does not burn requestId and valid retry can succeed', () => {
  const now = 1_700_000_000_000;
  const verifier = new WorkerEnvelopeVerifier({ secret, now: () => now });
  const valid = signWorkerEnvelope({ requestId: 'retryable', issuedAt: now, op: 'complete', body: { missionId: 'm1' }, secret });
  const bad = { ...valid, mac: `f${valid.mac.slice(1)}` };
  assert.throws(() => verifier.verify(bad), /authentication failed/);
  assert.equal(verifier.verify(valid).requestId, 'retryable');
});

test('bounds replay memory while preserving recent replay protection', () => {
  let now = 1_700_000_000_000;
  const verifier = new WorkerEnvelopeVerifier({ secret, maxSeen: 2, maxSkewMs: 60_000, now: () => now });
  for (const id of ['a', 'b', 'c']) {
    verifier.verify(signWorkerEnvelope({ requestId: id, issuedAt: now++, op: 'stats', secret }));
  }
  assert.equal(verifier.seen.size, 2);
  assert.throws(() => verifier.verify(signWorkerEnvelope({ requestId: 'c', issuedAt: now - 1, op: 'stats', secret })), /replay detected/);
});
