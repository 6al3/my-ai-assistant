import test from 'node:test';
import assert from 'node:assert/strict';
import { runQualificationPreflight, runQualificationPreflightFromEnv, validateQualificationPreflightEnvironment } from './qubes-qrexec-qualification-preflight.mjs';

const SECRET = 's'.repeat(32);
const SHA = 'a'.repeat(40);

test('validates fail-closed qualification environment', () => {
  const config = validateQualificationPreflightEnvironment({
    DIG_QREXEC_SOURCE: 'dig-worker',
    DIG_QREXEC_TARGET: 'dig-coordinator',
    DIG_QREXEC_SERVICE: 'dig.Coordinator',
    DIG_GIT_SHA: SHA,
    DIG_TRANSPORT_SECRET: SECRET
  });
  assert.equal(config.sourceQube, 'dig-worker');
  assert.equal(config.targetQube, 'dig-coordinator');
  assert.equal(config.qrexecBin, 'qrexec-client-vm');
  assert.throws(() => validateQualificationPreflightEnvironment({
    DIG_QREXEC_SOURCE: 'same', DIG_QREXEC_TARGET: 'same', DIG_QREXEC_SERVICE: 'dig.Coordinator', DIG_GIT_SHA: SHA, DIG_TRANSPORT_SECRET: SECRET
  }), /distinct source and target/);
  assert.throws(() => validateQualificationPreflightEnvironment({
    DIG_QREXEC_SOURCE: 'a', DIG_QREXEC_TARGET: 'b', DIG_QREXEC_SERVICE: 'dig.Coordinator', DIG_GIT_SHA: 'bad', DIG_TRANSPORT_SECRET: SECRET
  }), /40-character hex SHA/);
});

test('authenticated stats probe succeeds without worker mutation', async () => {
  let seen;
  const result = await runQualificationPreflight({
    secret: SECRET,
    requestId: 'preflight-1',
    issuedAt: 1234,
    invoke: async envelope => {
      seen = envelope;
      return { response: { ok: true, result: { queued: 0, running: 0, completed: 0 } }, durationMs: 7 };
    }
  });
  assert.equal(seen.requestId, 'preflight-1');
  assert.equal(seen.op, 'stats');
  assert.equal(result.ok, true);
  assert.equal(result.durationMs, 7);
});

test('preflight fails closed on transport/coordinator evidence errors', async () => {
  await assert.rejects(() => runQualificationPreflight({ secret: SECRET, invoke: async () => ({ response: { ok: false, error: 'denied' }, durationMs: 1 }) }), /probe failed: denied/);
  await assert.rejects(() => runQualificationPreflight({ secret: SECRET, invoke: async () => ({ response: { ok: true, result: null }, durationMs: 1 }) }), /stats response must be an object/);
  await assert.rejects(() => runQualificationPreflight({ secret: SECRET, invoke: async () => ({ response: { ok: true, result: {} }, durationMs: -1 }) }), /invalid timing evidence/);
});

test('environment preflight binds probe to expected topology and SHA', async () => {
  const env = {
    DIG_QREXEC_SOURCE: 'dig-worker',
    DIG_QREXEC_TARGET: 'dig-coordinator',
    DIG_QREXEC_SERVICE: 'dig.Coordinator',
    DIG_GIT_SHA: SHA,
    DIG_TRANSPORT_SECRET: SECRET
  };
  const result = await runQualificationPreflightFromEnv({
    env,
    invoke: async () => ({ response: { ok: true, result: { queued: 1 } }, durationMs: 5 })
  });
  assert.deepEqual({ sourceQube: result.sourceQube, targetQube: result.targetQube, service: result.service, gitSha: result.gitSha }, {
    sourceQube: 'dig-worker', targetQube: 'dig-coordinator', service: 'dig.Coordinator', gitSha: SHA
  });
});
