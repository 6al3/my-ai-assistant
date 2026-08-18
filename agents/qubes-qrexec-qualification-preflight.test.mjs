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
    DIG_QREXEC_FAULT_SERVICE: 'dig.CoordinatorFault',
    DIG_GIT_SHA: SHA,
    DIG_TRANSPORT_SECRET: SECRET
  });
  assert.equal(config.sourceQube, 'dig-worker');
  assert.equal(config.targetQube, 'dig-coordinator');
  assert.equal(config.service, 'dig.Coordinator');
  assert.equal(config.faultService, 'dig.CoordinatorFault');
  assert.equal(config.qrexecBin, 'qrexec-client-vm');
  assert.throws(() => validateQualificationPreflightEnvironment({
    DIG_QREXEC_SOURCE: 'same', DIG_QREXEC_TARGET: 'same', DIG_QREXEC_SERVICE: 'dig.Coordinator', DIG_GIT_SHA: SHA, DIG_TRANSPORT_SECRET: SECRET
  }), /distinct source and target/);
  assert.throws(() => validateQualificationPreflightEnvironment({
    DIG_QREXEC_SOURCE: 'a', DIG_QREXEC_TARGET: 'b', DIG_QREXEC_SERVICE: 'dig.Coordinator', DIG_QREXEC_FAULT_SERVICE: 'dig.Coordinator', DIG_GIT_SHA: SHA, DIG_TRANSPORT_SECRET: SECRET
  }), /distinct normal and fault/);
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

test('environment preflight probes both normal and fault qrexec services', async () => {
  const env = {
    DIG_QREXEC_SOURCE: 'dig-worker',
    DIG_QREXEC_TARGET: 'dig-coordinator',
    DIG_QREXEC_SERVICE: 'dig.Coordinator',
    DIG_QREXEC_FAULT_SERVICE: 'dig.CoordinatorFault',
    DIG_GIT_SHA: SHA,
    DIG_TRANSPORT_SECRET: SECRET
  };
  let normalCalls = 0;
  let faultCalls = 0;
  const result = await runQualificationPreflightFromEnv({
    env,
    invoke: async envelope => {
      normalCalls += 1;
      assert.match(envelope.requestId, /^qualification-preflight-normal-/);
      return { response: { ok: true, result: { queued: 1 } }, durationMs: 5 };
    },
    faultInvoke: async envelope => {
      faultCalls += 1;
      assert.match(envelope.requestId, /^qualification-preflight-fault-/);
      return { response: { ok: true, result: { queued: 1 } }, durationMs: 6 };
    }
  });
  assert.equal(normalCalls, 1);
  assert.equal(faultCalls, 1);
  assert.equal(result.durationMs, 11);
  assert.equal(result.probes.normal.durationMs, 5);
  assert.equal(result.probes.fault.durationMs, 6);
  assert.deepEqual({ sourceQube: result.sourceQube, targetQube: result.targetQube, service: result.service, faultService: result.faultService, gitSha: result.gitSha }, {
    sourceQube: 'dig-worker', targetQube: 'dig-coordinator', service: 'dig.Coordinator', faultService: 'dig.CoordinatorFault', gitSha: SHA
  });
});

test('environment preflight fails before campaigns when fault service is unreachable or rejects auth', async () => {
  const env = {
    DIG_QREXEC_SOURCE: 'dig-worker',
    DIG_QREXEC_TARGET: 'dig-coordinator',
    DIG_QREXEC_SERVICE: 'dig.Coordinator',
    DIG_QREXEC_FAULT_SERVICE: 'dig.CoordinatorFault',
    DIG_GIT_SHA: SHA,
    DIG_TRANSPORT_SECRET: SECRET
  };
  await assert.rejects(() => runQualificationPreflightFromEnv({
    env,
    invoke: async () => ({ response: { ok: true, result: {} }, durationMs: 1 }),
    faultInvoke: async () => ({ response: { ok: false, error: 'fault service denied' }, durationMs: 1 })
  }), /probe failed: fault service denied/);
});
