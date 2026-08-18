import assert from 'node:assert/strict';
import test from 'node:test';
import { collectQrexecCampaign } from './qubes-qrexec-campaign-collector.mjs';
import { runQrexecCampaignSteps } from './qubes-qrexec-campaign-harness.mjs';

const secret = 'dig-lab-qrexec-harness-secret-000001';

function scriptedInvoke(script) {
  let index = 0;
  return async (envelope, options) => {
    const action = script[index++];
    assert.ok(action, `unexpected transport invocation ${index}`);
    if (action.service) assert.equal(options.service, action.service);
    if (action.requestId) assert.equal(envelope.requestId, action.requestId);
    if (action.assertBody) action.assertBody(envelope.body);
    if (action.throw) {
      const error = new Error(action.throw);
      error.durationMs = action.durationMs ?? 1;
      throw error;
    }
    return {
      response: action.response,
      durationMs: action.durationMs ?? 1
    };
  };
}

test('clean campaign emits zero blocker counters with measured latency', async () => {
  const invoke = scriptedInvoke([
    { requestId: 'submit-1', response: { ok: true, result: { rootMissionId: 'm1' } }, durationMs: 7 },
    { requestId: 'stale-1', response: { ok: false, error: 'mission not owned by stale worker' }, durationMs: 5 },
    { requestId: 'qa-1', response: { ok: true, result: null }, durationMs: 4 }
  ]);

  const events = await runQrexecCampaignSteps({
    secret,
    issuedAt: () => 1_900_000_000_000,
    invoke,
    steps: [
      { mode: 'request', requestId: 'submit-1', op: 'submit', body: { text: 'synthetic defensive task' }, mutationKey: 'submit:m1' },
      { mode: 'stale_probe', requestId: 'stale-1', op: 'complete', body: { id: 'm1', workerId: 'stale', result: 'late' } },
      { mode: 'qa_barrier_probe', requestId: 'qa-1', op: 'claim', body: { worker: { id: 'qa', capabilities: ['qa'] } } }
    ]
  });

  assert.deepEqual(collectQrexecCampaign(events), {
    provenance: null,
    duplicateCommittedMutations: 0,
    staleCompletions: 0,
    unresolvedPendingRequests: 0,
    qaBeforeJoin: 0,
    recoveryLatencyMs: [],
    roundTripLatencyMs: [7, 5, 4]
  });
});

test('crash retry uses fault then recovery service and records one committed mutation', async () => {
  const invoke = scriptedInvoke([
    { service: 'dig.CoordinatorFault', requestId: 'complete-1', throw: 'qrexec peer exited', durationMs: 9 },
    { service: 'dig.Coordinator', requestId: 'complete-1', response: { ok: true, result: { status: 'completed' } }, durationMs: 12 }
  ]);

  const events = await runQrexecCampaignSteps({
    secret,
    issuedAt: () => 1_900_000_000_000,
    invoke,
    steps: [{
      mode: 'crash_retry',
      requestId: 'complete-1',
      op: 'complete',
      body: { id: 'm1', workerId: 'coder-1', result: { ok: true } },
      faultService: 'dig.CoordinatorFault',
      recoveryService: 'dig.Coordinator',
      mutationKey: 'complete:m1:attempt1'
    }]
  });

  assert.deepEqual(collectQrexecCampaign(events), {
    provenance: null,
    duplicateCommittedMutations: 0,
    staleCompletions: 0,
    unresolvedPendingRequests: 0,
    qaBeforeJoin: 0,
    recoveryLatencyMs: [12],
    roundTripLatencyMs: [12]
  });
});

test('stale acceptance and early QA claim become readiness blockers', async () => {
  const invoke = scriptedInvoke([
    { response: { ok: true, result: { status: 'completed' } }, durationMs: 3 },
    { response: { ok: true, result: { id: 'qa-mission' } }, durationMs: 2 }
  ]);

  const report = collectQrexecCampaign(await runQrexecCampaignSteps({
    secret,
    invoke,
    steps: [
      { mode: 'stale_probe', requestId: 'stale-bad', op: 'complete', body: { id: 'm1', workerId: 'old-worker' } },
      { mode: 'qa_barrier_probe', requestId: 'qa-bad', op: 'claim', body: { worker: { id: 'qa', capabilities: ['qa'] } } }
    ]
  }));

  assert.equal(report.staleCompletions, 1);
  assert.equal(report.qaBeforeJoin, 1);
});

test('fault service must fail before recovery is attempted', async () => {
  const invoke = scriptedInvoke([
    { response: { ok: true, result: { status: 'completed' } }, durationMs: 1 }
  ]);

  await assert.rejects(() => runQrexecCampaignSteps({
    secret,
    invoke,
    steps: [{
      mode: 'crash_retry',
      requestId: 'bad-fault',
      op: 'complete',
      body: { id: 'm1', workerId: 'coder-1' },
      faultService: 'dig.CoordinatorFault',
      recoveryService: 'dig.Coordinator'
    }]
  }), /expected the fault service to terminate/);
});

test('campaign captures claim results and resolves lease token references across qrexec calls', async () => {
  const invoke = scriptedInvoke([
    { requestId: 'claim-old', response: { ok: true, result: { id: 'm1', leaseToken: 'lease-old-000000000000', attempts: 1 } }, durationMs: 2 },
    {
      requestId: 'complete-old',
      assertBody(body) {
        assert.deepEqual(body, { id: 'm1', workerId: 'coder-worker', leaseToken: 'lease-old-000000000000', result: { synthetic: 'late' } });
      },
      response: { ok: false, error: 'mission lease token is stale or missing' },
      durationMs: 3
    }
  ]);

  const events = await runQrexecCampaignSteps({
    secret,
    invoke,
    steps: [
      { mode: 'request', requestId: 'claim-old', op: 'claim', body: { worker: { id: 'coder-worker', capabilities: ['coder'] } }, saveAs: 'oldClaim' },
      {
        mode: 'stale_probe',
        requestId: 'complete-old',
        op: 'complete',
        body: {
          id: { $ref: 'oldClaim.result.id' },
          workerId: 'coder-worker',
          leaseToken: { $ref: 'oldClaim.result.leaseToken' },
          result: { synthetic: 'late' }
        }
      }
    ]
  });

  assert.equal(collectQrexecCampaign(events).staleCompletions, 0);
});

test('campaign can wait for lease expiry then validate same-worker reclaim fencing', async () => {
  const waits = [];
  const invoke = scriptedInvoke([
    { requestId: 'claim-old', response: { ok: true, result: { id: 'm1', leaseToken: 'lease-old-000000000000', attempts: 1 } }, durationMs: 2 },
    { requestId: 'claim-new', response: { ok: true, result: { id: 'm1', leaseToken: 'lease-new-000000000000', attempts: 2 } }, durationMs: 2 },
    {
      requestId: 'complete-stale',
      assertBody(body) {
        assert.equal(body.id, 'm1');
        assert.equal(body.leaseToken, 'lease-old-000000000000');
      },
      response: { ok: false, error: 'mission lease token is stale or missing' },
      durationMs: 2
    },
    {
      requestId: 'complete-current',
      assertBody(body) {
        assert.equal(body.id, 'm1');
        assert.equal(body.leaseToken, 'lease-new-000000000000');
      },
      response: { ok: true, result: { id: 'm1', status: 'completed' } },
      durationMs: 2
    }
  ]);

  const events = await runQrexecCampaignSteps({
    secret,
    invoke,
    sleepFn: async durationMs => { waits.push(durationMs); },
    steps: [
      { mode: 'request', requestId: 'claim-old', op: 'claim', body: { worker: { id: 'coder-worker', capabilities: ['coder'] } }, saveAs: 'oldClaim' },
      { mode: 'wait', durationMs: 31_000 },
      { mode: 'request', requestId: 'claim-new', op: 'claim', body: { worker: { id: 'coder-worker', capabilities: ['coder'] } }, saveAs: 'newClaim' },
      {
        mode: 'stale_probe',
        requestId: 'complete-stale',
        op: 'complete',
        body: { id: { $ref: 'oldClaim.result.id' }, workerId: 'coder-worker', leaseToken: { $ref: 'oldClaim.result.leaseToken' }, result: { synthetic: 'stale' } }
      },
      {
        mode: 'request',
        requestId: 'complete-current',
        op: 'complete',
        body: { id: { $ref: 'newClaim.result.id' }, workerId: 'coder-worker', leaseToken: { $ref: 'newClaim.result.leaseToken' }, result: { synthetic: 'current' } },
        mutationKey: 'complete:m1:attempt2'
      }
    ]
  });

  assert.deepEqual(waits, [31_000]);
  const report = collectQrexecCampaign(events);
  assert.equal(report.staleCompletions, 0);
  assert.equal(report.duplicateCommittedMutations, 0);
  assert.equal(report.unresolvedPendingRequests, 0);
});

test('capture references and waits fail closed on invalid campaign input', async () => {
  const invoke = scriptedInvoke([]);
  await assert.rejects(() => runQrexecCampaignSteps({
    secret,
    invoke,
    steps: [{ mode: 'request', requestId: 'missing-ref', op: 'complete', body: { leaseToken: { $ref: 'missing.result.leaseToken' } } }]
  }), /unknown capture/);
  await assert.rejects(() => runQrexecCampaignSteps({
    secret,
    invoke,
    sleepFn: async () => {},
    steps: [{ mode: 'wait', durationMs: 120_001 }]
  }), /between 0 and 120000/);
});
