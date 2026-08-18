import assert from 'node:assert/strict';
import test from 'node:test';
import { collectQrexecCampaign, parseCampaignJsonl } from './qubes-qrexec-campaign-collector.mjs';

const start = { type: 'campaign_start', runId: 'run-1', transport: 'qrexec', sourceQube: 'AI', targetQube: 'DIG-Coordinator', service: 'dig.Coordinator', gitSha: 'a'.repeat(40), startedAt: '2026-08-17T15:00:00.000Z' };
const end = { type: 'campaign_end', runId: 'run-1', finishedAt: '2026-08-17T15:01:00.000Z' };

test('collects a clean synthetic Qubes campaign into readiness-gate shape with provenance', () => {
  const report = collectQrexecCampaign([
    start,
    { type: 'qrexec_service_call', service: 'dig.Coordinator' },
    { type: 'qrexec_service_call', service: 'dig.CoordinatorFault' },
    { type: 'request_pending', requestId: 'r1' },
    { type: 'mutation_committed', mutationKey: 'r1:complete:coder' },
    { type: 'stale_completion_probe', rejected: true },
    { type: 'current_lease_completion' },
    { type: 'request_resolved', requestId: 'r1' },
    { type: 'qa_started', pendingDependencies: 0 },
    { type: 'round_trip', durationMs: 12 },
    { type: 'round_trip', durationMs: 15 },
    { type: 'round_trip', durationMs: 18 },
    { type: 'recovery', durationMs: 110 },
    { type: 'recovery', durationMs: 120 },
    { type: 'recovery', durationMs: 130 },
    end
  ]);
  assert.deepEqual(report, {
    provenance: { runId: 'run-1', transport: 'qrexec', sourceQube: 'AI', targetQube: 'DIG-Coordinator', service: 'dig.Coordinator', gitSha: 'a'.repeat(40), startedAt: '2026-08-17T15:00:00.000Z', finishedAt: '2026-08-17T15:01:00.000Z' },
    duplicateCommittedMutations: 0,
    staleCompletions: 0,
    staleCompletionProbes: 1,
    staleCompletionRejections: 1,
    currentLeaseCompletions: 1,
    unresolvedPendingRequests: 0,
    qaBeforeJoin: 0,
    recoveryLatencyMs: [110, 120, 130],
    roundTripLatencyMs: [12, 15, 18]
  });
});

test('bounded wait events are accepted as campaign control metadata without affecting latency samples', () => {
  const report = collectQrexecCampaign([{ type: 'wait', durationMs: 31_000 }, { type: 'round_trip', durationMs: 7 }]);
  assert.equal(report.duplicateCommittedMutations, 0);
  assert.equal(report.unresolvedPendingRequests, 0);
  assert.deepEqual(report.recoveryLatencyMs, []);
  assert.deepEqual(report.roundTripLatencyMs, [7]);
});

test('derives duplicate, stale, fencing, unresolved, and QA-before-join evidence from events', () => {
  const report = collectQrexecCampaign([
    { type: 'request_pending', requestId: 'left-open' },
    { type: 'mutation_committed', mutationKey: 'same-mutation' },
    { type: 'mutation_committed', mutationKey: 'same-mutation' },
    { type: 'stale_completion_probe', rejected: false },
    { type: 'stale_completion' },
    { type: 'current_lease_completion' },
    { type: 'qa_started', pendingDependencies: 2 }
  ]);
  assert.equal(report.duplicateCommittedMutations, 1);
  assert.equal(report.staleCompletions, 1);
  assert.equal(report.staleCompletionProbes, 1);
  assert.equal(report.staleCompletionRejections, 0);
  assert.equal(report.currentLeaseCompletions, 1);
  assert.equal(report.unresolvedPendingRequests, 1);
  assert.equal(report.qaBeforeJoin, 1);
  assert.equal(report.provenance, null);
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

test('provenance framing rejects duplicates, mismatches, same-qube, and inverted time', () => {
  assert.throws(() => collectQrexecCampaign([start, start]), /only once/);
  assert.throws(() => collectQrexecCampaign([end]), /requires campaign_start/);
  assert.throws(() => collectQrexecCampaign([start, { ...end, runId: 'other' }]), /runId mismatch/);
  assert.throws(() => collectQrexecCampaign([{ ...start, targetQube: 'AI' }]), /must differ/);
  assert.throws(() => collectQrexecCampaign([start, { ...end, finishedAt: '2026-08-17T14:59:00.000Z' }]), /precedes/);
});

test('rejects malformed and unsupported events fail-closed', () => {
  assert.throws(() => collectQrexecCampaign([{ type: 'round_trip', durationMs: -1 }]), /non-negative finite/);
  assert.throws(() => collectQrexecCampaign([{ type: 'wait', durationMs: -1 }]), /non-negative finite/);
  assert.throws(() => collectQrexecCampaign([{ type: 'wait', durationMs: 120_001 }]), /at most 120000/);
  assert.throws(() => collectQrexecCampaign([{ type: 'qrexec_service_call', service: '' }]), /non-empty string/);
  assert.throws(() => collectQrexecCampaign([{ type: 'stale_completion_probe', rejected: 'yes' }]), /must be a boolean/);
  assert.throws(() => collectQrexecCampaign([{ type: 'qa_started', pendingDependencies: -1 }]), /non-negative integer/);
  assert.throws(() => collectQrexecCampaign([{ type: 'mystery' }]), /unsupported campaign event type/);
  assert.throws(() => collectQrexecCampaign([null]), /must be an object/);
});

test('parses JSONL and reports the failing line', () => {
  assert.deepEqual(parseCampaignJsonl('{"type":"stale_completion_probe","rejected":true}\n\n{"type":"qa_started","pendingDependencies":0}\n'), [
    { type: 'stale_completion_probe', rejected: true },
    { type: 'qa_started', pendingDependencies: 0 }
  ]);
  assert.throws(() => parseCampaignJsonl('{"type":"stale_completion"}\nnot-json'), /line 2/);
});
