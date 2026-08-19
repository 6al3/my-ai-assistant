import test from 'node:test';
import assert from 'node:assert/strict';
import { runQualificationPreflight, runQualificationPreflightFromEnv, validateQualificationPreflightEnvironment } from './qubes-qrexec-qualification-preflight.mjs';

const SECRET = 's'.repeat(32);
const SHA = 'a'.repeat(40);
const KEY = 'dig-key-1';
const PUB = 'test-public-key';
const ENV = {
  DIG_QREXEC_SOURCE: 'dig-worker', DIG_QREXEC_TARGET: 'dig-coordinator', DIG_QREXEC_SERVICE: 'dig.Coordinator', DIG_QREXEC_FAULT_SERVICE: 'dig.CoordinatorFault',
  DIG_GIT_SHA: SHA, DIG_TRANSPORT_SECRET: SECRET, DIG_RESPONSE_ATTESTATION_PUBLIC_KEY: PUB, DIG_RESPONSE_ATTESTATION_KEY_ID: KEY
};
const verified = service => ({ service, keyId: KEY, gitSha: SHA });

test('validates fail-closed qualification environment including attestation binding', () => {
  const config = validateQualificationPreflightEnvironment(ENV);
  assert.equal(config.sourceQube, 'dig-worker');
  assert.equal(config.targetQube, 'dig-coordinator');
  assert.equal(config.service, 'dig.Coordinator');
  assert.equal(config.faultService, 'dig.CoordinatorFault');
  assert.equal(config.attestationKeyId, KEY);
  assert.equal(config.qrexecBin, 'qrexec-client-vm');
  assert.throws(() => validateQualificationPreflightEnvironment({ ...ENV, DIG_QREXEC_TARGET: 'dig-worker' }), /distinct source and target/);
  assert.throws(() => validateQualificationPreflightEnvironment({ ...ENV, DIG_QREXEC_FAULT_SERVICE: 'dig.Coordinator' }), /distinct normal and fault/);
  assert.throws(() => validateQualificationPreflightEnvironment({ ...ENV, DIG_GIT_SHA: 'bad' }), /40-character hex SHA/);
  const noKey = { ...ENV }; delete noKey.DIG_RESPONSE_ATTESTATION_PUBLIC_KEY;
  assert.throws(() => validateQualificationPreflightEnvironment(noKey), /DIG_RESPONSE_ATTESTATION_PUBLIC_KEY/);
});

test('authenticated stats probe requires verified coordinator attestation', async () => {
  let seen;
  const result = await runQualificationPreflight({
    secret: SECRET, requestId: 'preflight-1', issuedAt: 1234,
    expectedService: 'dig.Coordinator', expectedKeyId: KEY, expectedGitSha: SHA,
    invoke: async envelope => {
      seen = envelope;
      return { response: { ok: true, result: { queued: 0, running: 0, completed: 0 } }, durationMs: 7, attestationVerified: verified('dig.Coordinator') };
    }
  });
  assert.equal(seen.requestId, 'preflight-1');
  assert.equal(seen.op, 'stats');
  assert.equal(result.ok, true);
  assert.equal(result.durationMs, 7);
  assert.deepEqual(result.attestation, verified('dig.Coordinator'));
});

test('preflight fails closed on transport, coordinator, or attestation evidence errors', async () => {
  await assert.rejects(() => runQualificationPreflight({ secret: SECRET, invoke: async () => ({ response: { ok: false, error: 'denied' }, durationMs: 1, attestationVerified: verified('dig.Coordinator') }) }), /probe failed: denied/);
  await assert.rejects(() => runQualificationPreflight({ secret: SECRET, invoke: async () => ({ response: { ok: true, result: null }, durationMs: 1, attestationVerified: verified('dig.Coordinator') }) }), /stats response must be an object/);
  await assert.rejects(() => runQualificationPreflight({ secret: SECRET, invoke: async () => ({ response: { ok: true, result: {} }, durationMs: -1, attestationVerified: verified('dig.Coordinator') }) }), /invalid timing evidence/);
  await assert.rejects(() => runQualificationPreflight({ secret: SECRET, invoke: async () => ({ response: { ok: true, result: {} }, durationMs: 1 }) }), /requires verified coordinator response attestation/);
  await assert.rejects(() => runQualificationPreflight({ secret: SECRET, expectedService: 'dig.Coordinator', expectedKeyId: KEY, expectedGitSha: SHA, invoke: async () => ({ response: { ok: true, result: {} }, durationMs: 1, attestationVerified: verified('dig.Other') }) }), /service mismatch/);
});

test('environment preflight probes and attests both normal and fault qrexec services', async () => {
  let normalCalls = 0, faultCalls = 0;
  const result = await runQualificationPreflightFromEnv({
    env: ENV,
    invoke: async envelope => {
      normalCalls += 1; assert.match(envelope.requestId, /^qualification-preflight-normal-/);
      return { response: { ok: true, result: { queued: 1 } }, durationMs: 5, attestationVerified: verified('dig.Coordinator') };
    },
    faultInvoke: async envelope => {
      faultCalls += 1; assert.match(envelope.requestId, /^qualification-preflight-fault-/);
      return { response: { ok: true, result: { queued: 1 } }, durationMs: 6, attestationVerified: verified('dig.CoordinatorFault') };
    }
  });
  assert.equal(normalCalls, 1); assert.equal(faultCalls, 1); assert.equal(result.durationMs, 11);
  assert.deepEqual(result.verifiedAttestations, [verified('dig.Coordinator'), verified('dig.CoordinatorFault')]);
  assert.equal(result.attestationKeyId, KEY);
});

test('environment preflight fails before campaigns when fault service lacks verified attestation', async () => {
  await assert.rejects(() => runQualificationPreflightFromEnv({
    env: ENV,
    invoke: async () => ({ response: { ok: true, result: {} }, durationMs: 1, attestationVerified: verified('dig.Coordinator') }),
    faultInvoke: async () => ({ response: { ok: true, result: {} }, durationMs: 1 })
  }), /requires verified coordinator response attestation/);
});
