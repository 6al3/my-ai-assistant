import assert from 'node:assert/strict';
import test from 'node:test';
import { collectQrexecCampaign, parseCampaignJsonl } from './qubes-qrexec-campaign-collector.mjs';

test('collects a clean synthetic Qubes campaign into readiness-gate shape', () => {
  const report = collectQrexecCampaign([
    { type: 'request_pending', requestId: 'r1' },
    { type: 'mutation_committed', mutationKey: 'r1:complete:coder' },
    { type: 'request_resolved', requestId: 'r1' },
    { type: 'qa_started', pendingDependencies: 0 },
    { type: 'round_trip', durationMs: 12 },
    { type: 'round_trip', durationMs: 15 },
    { type: 'round_trip', durationMs: 18 },
    { type: 'recovery', durationMs: 110 },
    { type: 'recovery', durationMs: 120 },
    { type: 'recovery', durationMs: 130 }
  ]);

  assert.deepEqual(report, {
    duplicateCommittedMutations: 0,
    staleCompletions: 0,
    unresolvedPendingRequests: 0,
    qaBeforeJoin: 0,
    recoveryLatencyMs: [110, 120, 130],
    roundTripLatencyMs: [12, 15, 18]
  });
});

test('derives duplicate, stale, unresolved, and QA-before-join failures from events', () => {
  const report = collectQrexecCampaign([
    { type: 'request_pending', requestId: 'left-open' },
    { type: 'mutation_committed', mutationKey: 'same-mutation' },
    { type: 'mutation_committed', mutationKey: 'same-mutation' },
    { type: 'stale_completion' },
    { type: 'qa_started', pendingDependencies: 2 }
  ]);

  assert.equal(report.duplicateCommittedMutations, 1);
  assert.equal(report.staleCompletions, 1);
  assert.equal(report.unresolvedPendingRequests, 1);
  assert.equal(report.qaBeforeJoin, 1);
});

test('request resolution is idempotent and only open request IDs remain unresolved', () => {
  const report = collectQrexecCampaign([
    { type: 'request_pending', requestId: 'a' },
    { type: 'request_pending', requestId: 'a' },
    { type: 'request_pending', requestId: 'b' },
    { type: 'request_resolved', requestId: 'a' },
    { type: 'request_resolved', requestId: 'a' }
  ]);
  assert.equal(report.unresolvedPendingRequests, 1);
});

test('rejects malformed and unsupported events fail-closed', () => {
  assert.throws(() => collectQrexecCampaign([{ type: 'round_trip', durationMs: -1 }]), /non-negative finite/);
  assert.throws(() => collectQrexecCampaign([{ type: 'qa_started', pendingDependencies: -1 }]), /non-negative integer/);
  assert.throws(() => collectQrexecCampaign([{ type: 'mystery' }]), /unsupported campaign event type/);
  assert.throws(() => collectQrexecCampaign([null]), /must be an object/);
});

test('parses JSONL and reports the failing line', () => {
  assert.deepEqual(parseCampaignJsonl('{"type":"stale_completion"}\n\n{"type":"qa_started","pendingDependencies":0}\n'), [
    { type: 'stale_completion' },
    { type: 'qa_started', pendingDependencies: 0 }
  ]);
  assert.throws(() => parseCampaignJsonl('{"type":"stale_completion"}\nnot-json'), /line 2/);
});
