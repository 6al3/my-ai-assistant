import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateMultiRunQualification, parseMultiRunJson } from './qubes-multi-run-qualification.mjs';

const SHA = 'a'.repeat(40);
const NOW = Date.parse('2026-08-18T07:00:00.000Z');

function campaign(runId, offsetMs, scenario = {}) {
  const startedAt = new Date(NOW - 60_000 + offsetMs).toISOString();
  const finishedAt = new Date(NOW - 50_000 + offsetMs).toISOString();
  const events = [
    { type: 'campaign_start', runId, transport: 'qrexec', sourceQube: 'dig-worker', targetQube: 'dig-coordinator', service: 'dig.Coordinator', gitSha: SHA, startedAt },
    { type: 'round_trip', durationMs: 40 + offsetMs / 1000 },
    { type: 'recovery', durationMs: 100 + offsetMs / 1000 }
  ];
  if (scenario.recovery) events.push(
    { type: 'request_pending', requestId: `${runId}-request` },
    { type: 'mutation_committed', mutationKey: `${runId}-mutation` },
    { type: 'request_resolved', requestId: `${runId}-request` }
  );
  if (scenario.qa) events.push(
    { type: 'qa_barrier_probe', blocked: true },
    { type: 'qa_post_join_start' }
  );
  if (scenario.fencing) events.push(
    { type: 'stale_completion_probe', rejected: true },
    { type: 'current_lease_completion' }
  );
  events.push({ type: 'campaign_end', runId, finishedAt });
  return events;
}

function goodCampaigns() {
  return [
    campaign('run-1', 0, { recovery: true }),
    campaign('run-2', 1000, { qa: true }),
    campaign('run-3', 2000, { fencing: true })
  ];
}

const thresholds = {
  nowMs: NOW,
  expectedGitSha: SHA,
  expectedSourceQube: 'dig-worker',
  expectedTargetQube: 'dig-coordinator',
  expectedService: 'dig.Coordinator',
  maxRecoveryP95Ms: 500,
  maxRoundTripP95Ms: 200
};

test('qualifies multiple independent runs only when aggregate evidence is complete', () => {
  const result = evaluateMultiRunQualification(goodCampaigns(), thresholds);
  assert.equal(result.ready, true);
  assert.equal(result.classification, 'REAL-WORKER READY');
  assert.equal(result.metrics.runs, 3);
  assert.equal(result.metrics.recoverySamples, 3);
  assert.equal(result.metrics.roundTripSamples, 3);
  assert.equal(result.coverage.checks.pendingRequestWasResolved, true);
  assert.equal(result.coverage.checks.qaWasBlockedBeforeJoin, true);
  assert.equal(result.coverage.checks.qaStartedAfterJoin, true);
  assert.equal(result.coverage.checks.staleLeaseWasActuallyProbed, true);
  assert.equal(result.readiness.checks.everyStaleLeaseProbeRejected, true);
});

test('rejects duplicate run ids even when counters and latency pass', () => {
  const campaigns = goodCampaigns();
  campaigns[2][0].runId = 'run-2';
  campaigns[2].at(-1).runId = 'run-2';
  const result = evaluateMultiRunQualification(campaigns, thresholds);
  assert.equal(result.ready, false);
  assert.ok(result.failedChecks.includes('uniqueRunIds'));
});

test('rejects mixed commit or topology evidence', () => {
  const mixedSha = goodCampaigns();
  mixedSha[1][0].gitSha = 'b'.repeat(40);
  const shaResult = evaluateMultiRunQualification(mixedSha, thresholds);
  assert.equal(shaResult.ready, false);
  assert.ok(shaResult.failedChecks.includes('consistentGitShaAndTopology'));

  const mixedTarget = goodCampaigns();
  mixedTarget[1][0].targetQube = 'other-coordinator';
  const topologyResult = evaluateMultiRunQualification(mixedTarget, thresholds);
  assert.equal(topologyResult.ready, false);
  assert.ok(topologyResult.failedChecks.includes('consistentGitShaAndTopology'));
});

test('rejects insufficient independent runs and insufficient latency evidence', () => {
  const result = evaluateMultiRunQualification(goodCampaigns().slice(0, 2), thresholds);
  assert.equal(result.ready, false);
  assert.ok(result.failedChecks.includes('multipleIndependentRuns'));
  assert.equal(result.readiness.checks.enoughRecoverySamples, false);
  assert.equal(result.readiness.checks.enoughRoundTripSamples, false);
});

test('rejects stale runs even if the aggregate report looks fresh', () => {
  const campaigns = goodCampaigns();
  campaigns[0][0].startedAt = '2026-08-15T00:00:00.000Z';
  campaigns[0].at(-1).finishedAt = '2026-08-15T00:01:00.000Z';
  const result = evaluateMultiRunQualification(campaigns, { ...thresholds, maxReportAgeMs: 60 * 60 * 1000 });
  assert.equal(result.ready, false);
  assert.ok(result.failedChecks.includes('everyRunFresh'));
});

test('rejects future-dated campaign provenance beyond bounded clock skew', () => {
  const campaigns = goodCampaigns();
  campaigns[0][0].startedAt = new Date(NOW + 10 * 60 * 1000).toISOString();
  campaigns[0].at(-1).finishedAt = new Date(NOW + 11 * 60 * 1000).toISOString();
  const result = evaluateMultiRunQualification(campaigns, { ...thresholds, maxFutureSkewMs: 5 * 60 * 1000 });
  assert.equal(result.ready, false);
  assert.ok(result.failedChecks.includes('everyRunFresh'));
});

test('rejects evidence outside explicit campaign boundaries', () => {
  const beforeStart = goodCampaigns();
  beforeStart[0].unshift({ type: 'round_trip', durationMs: 1 });
  assert.throws(() => evaluateMultiRunQualification(beforeStart, thresholds), /must start with campaign_start/);

  const afterEnd = goodCampaigns();
  afterEnd[0].push({ type: 'mutation_committed', mutationKey: 'after-end' });
  assert.throws(() => evaluateMultiRunQualification(afterEnd, thresholds), /must end with campaign_end/);

  const duplicateBoundary = goodCampaigns();
  duplicateBoundary[0].splice(1, 0, { ...duplicateBoundary[0][0] });
  assert.throws(() => evaluateMultiRunQualification(duplicateBoundary, thresholds), /exactly one campaign_start and campaign_end/);
});

test('fails closed when aggregate scenario coverage is missing', () => {
  const campaigns = goodCampaigns();
  campaigns[1] = campaign('run-2', 1000, {});
  const result = evaluateMultiRunQualification(campaigns, thresholds);
  assert.equal(result.ready, false);
  assert.ok(result.failedChecks.includes('aggregateScenarioCoverage'));
  assert.equal(result.coverage.checks.qaBarrierWasActuallyProbed, false);
});

test('parses arrays containing JSONL strings or event arrays', () => {
  const source = goodCampaigns();
  const jsonl = source[0].map(event => JSON.stringify(event)).join('\n');
  const parsed = parseMultiRunJson(JSON.stringify([jsonl, source[1], source[2]]));
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0][0].type, 'campaign_start');
  assert.throws(() => parseMultiRunJson('{}'), /must be an array/);
});
