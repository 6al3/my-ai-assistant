import assert from 'node:assert/strict';
import test from 'node:test';
import { collectQrexecCampaign } from './qubes-qrexec-campaign-collector.mjs';
import { runQrexecCampaignSteps } from './qubes-qrexec-campaign-harness.mjs';
import { evaluateCampaignCoverage } from './qubes-real-worker-evidence-gate.mjs';

const secret = 'dig-lab-qrexec-qa-join-secret-000001';

function invokeSequence(responses) {
  let index = 0;
  return async () => ({ response: responses[index++], durationMs: 2 });
}

test('QA evidence proves blocked-before-join then available-after-join', async () => {
  const events = await runQrexecCampaignSteps({
    secret,
    invoke: invokeSequence([
      { ok: true, result: null },
      { ok: true, result: { id: 'qa-mission-1', leaseToken: 'qa-lease-000000000001' } }
    ]),
    steps: [
      { mode: 'qa_barrier_probe', requestId: 'qa-before', op: 'claim', body: { worker: { id: 'qa-worker', capabilities: ['qa'] } } },
      { mode: 'qa_post_join_probe', requestId: 'qa-after', op: 'claim', body: { worker: { id: 'qa-worker', capabilities: ['qa'] } } }
    ]
  });

  assert.ok(events.some(event => event.type === 'qa_barrier_probe' && event.blocked === true));
  assert.ok(events.some(event => event.type === 'qa_post_join_start'));
  assert.equal(collectQrexecCampaign(events).qaBeforeJoin, 0);
});

test('early QA availability is recorded as a readiness blocker', async () => {
  const events = await runQrexecCampaignSteps({
    secret,
    invoke: invokeSequence([{ ok: true, result: { id: 'qa-too-early' } }]),
    steps: [{ mode: 'qa_barrier_probe', requestId: 'qa-early', op: 'claim', body: { worker: { id: 'qa-worker', capabilities: ['qa'] } } }]
  });

  assert.equal(collectQrexecCampaign(events).qaBeforeJoin, 1);
  const framed = [
    { type: 'campaign_start', runId: 'qa-run', transport: 'qrexec', sourceQube: 'AI', targetQube: 'DIG-Coordinator', service: 'dig.Coordinator', gitSha: 'a'.repeat(40), startedAt: '2026-08-18T05:00:00.000Z' },
    ...events,
    { type: 'campaign_end', runId: 'qa-run', finishedAt: '2026-08-18T05:01:00.000Z' }
  ];
  const coverage = evaluateCampaignCoverage(framed);
  assert.ok(coverage.failedChecks.includes('qaWasBlockedBeforeJoin'));
  assert.ok(coverage.failedChecks.includes('qaStartedAfterJoin'));
});

test('post-join probe fails closed when QA is still unavailable', async () => {
  await assert.rejects(() => runQrexecCampaignSteps({
    secret,
    invoke: invokeSequence([{ ok: true, result: null }]),
    steps: [{ mode: 'qa_post_join_probe', requestId: 'qa-missing-after', op: 'claim', body: { worker: { id: 'qa-worker', capabilities: ['qa'] } } }]
  }), /expected QA mission after dependency join/);
});
