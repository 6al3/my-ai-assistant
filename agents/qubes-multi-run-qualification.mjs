import { pathToFileURL } from 'node:url';
import { collectQrexecCampaign, parseCampaignJsonl } from './qubes-qrexec-campaign-collector.mjs';
import { evaluateCampaignCoverage } from './qubes-real-worker-evidence-gate.mjs';
import { evaluateQrexecReadiness } from './qubes-qrexec-readiness-gate.mjs';

function nonEmpty(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be a non-empty string`);
  return value.trim();
}

function assertCampaigns(campaigns) {
  if (!Array.isArray(campaigns) || campaigns.length === 0) throw new TypeError('campaigns must be a non-empty array');
  for (const [index, events] of campaigns.entries()) {
    if (!Array.isArray(events) || events.length === 0) throw new TypeError(`campaigns[${index}] must be a non-empty event array`);
  }
}

function sameTopology(a, b) {
  return a.gitSha === b.gitSha && a.sourceQube === b.sourceQube && a.targetQube === b.targetQube && a.service === b.service && a.transport === b.transport;
}

function aggregateCoverage(coverages) {
  const metrics = coverages.reduce((sum, coverage) => {
    for (const [name, value] of Object.entries(coverage.metrics)) sum[name] = (sum[name] ?? 0) + value;
    return sum;
  }, {});
  const checks = {
    committedMutationObserved: (metrics.committedMutations ?? 0) > 0,
    pendingRequestWasResolved: (metrics.resolvedAfterPending ?? 0) > 0,
    recoveryWasActuallyExercised: (metrics.recoveryEvents ?? 0) > 0,
    qaBarrierWasActuallyProbed: (metrics.qaBarrierProbes ?? 0) > 0,
    qaWasBlockedBeforeJoin: (metrics.qaBarrierProbes ?? 0) > 0 && metrics.qaBarrierBlocks === metrics.qaBarrierProbes,
    qaStartedAfterJoin: (metrics.qaPostJoinStarts ?? 0) > 0,
    staleLeaseWasActuallyProbed: (metrics.staleLeaseProbes ?? 0) > 0,
    currentLeaseCompletionObserved: (metrics.currentLeaseCompletions ?? 0) > 0
  };
  const failedChecks = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  return { ready: failedChecks.length === 0, failedChecks, checks, metrics };
}

export function evaluateMultiRunQualification(campaigns, thresholds = {}) {
  assertCampaigns(campaigns);
  const reports = campaigns.map(collectQrexecCampaign);
  const coverages = campaigns.map(evaluateCampaignCoverage);
  const provenances = reports.map((report, index) => {
    if (!report.provenance) throw new Error(`campaigns[${index}] is missing complete provenance`);
    return report.provenance;
  });
  const runIds = provenances.map((provenance, index) => nonEmpty(provenance.runId, `campaigns[${index}].provenance.runId`));
  const uniqueRunIds = new Set(runIds);
  const reference = provenances[0];
  const topologyConsistent = provenances.every(provenance => sameTopology(reference, provenance));
  const allQrexec = provenances.every(provenance => provenance.transport === 'qrexec');
  const allDistinctQubes = provenances.every(provenance => provenance.sourceQube !== provenance.targetQube);
  const nowMs = thresholds.nowMs ?? Date.now();
  const maxReportAgeMs = thresholds.maxReportAgeMs ?? 24 * 60 * 60 * 1000;
  if (!Number.isFinite(nowMs)) throw new TypeError('nowMs must be finite');
  if (!Number.isFinite(maxReportAgeMs) || maxReportAgeMs < 0) throw new TypeError('maxReportAgeMs must be non-negative');
  const allFresh = provenances.every(provenance => {
    const finishedAt = Date.parse(provenance.finishedAt);
    return Number.isFinite(finishedAt) && Math.max(0, nowMs - finishedAt) <= maxReportAgeMs;
  });

  const aggregateReport = {
    provenance: { ...reference, finishedAt: provenances.map(item => item.finishedAt).sort().at(-1) },
    duplicateCommittedMutations: reports.reduce((sum, report) => sum + report.duplicateCommittedMutations, 0),
    staleCompletions: reports.reduce((sum, report) => sum + report.staleCompletions, 0),
    staleCompletionProbes: reports.reduce((sum, report) => sum + report.staleCompletionProbes, 0),
    staleCompletionRejections: reports.reduce((sum, report) => sum + report.staleCompletionRejections, 0),
    currentLeaseCompletions: reports.reduce((sum, report) => sum + report.currentLeaseCompletions, 0),
    unresolvedPendingRequests: reports.reduce((sum, report) => sum + report.unresolvedPendingRequests, 0),
    qaBeforeJoin: reports.reduce((sum, report) => sum + report.qaBeforeJoin, 0),
    recoveryLatencyMs: reports.flatMap(report => report.recoveryLatencyMs),
    roundTripLatencyMs: reports.flatMap(report => report.roundTripLatencyMs)
  };

  const readiness = evaluateQrexecReadiness(aggregateReport, { ...thresholds, nowMs, maxReportAgeMs });
  const coverage = aggregateCoverage(coverages);
  const qualificationChecks = {
    multipleIndependentRuns: campaigns.length >= (thresholds.minRuns ?? 3),
    uniqueRunIds: uniqueRunIds.size === campaigns.length,
    consistentGitShaAndTopology: topologyConsistent,
    qrexecTransportOnly: allQrexec,
    sourceAndTargetRemainDistinct: allDistinctQubes,
    everyRunFresh: allFresh,
    aggregateScenarioCoverage: coverage.ready,
    aggregateReadiness: readiness.ready
  };
  const failedChecks = Object.entries(qualificationChecks).filter(([, passed]) => !passed).map(([name]) => name);
  return {
    ready: failedChecks.length === 0,
    classification: failedChecks.length === 0 ? 'REAL-WORKER READY' : 'LAB READY',
    failedChecks,
    checks: qualificationChecks,
    metrics: {
      runs: campaigns.length,
      uniqueRunIds: uniqueRunIds.size,
      recoverySamples: aggregateReport.recoveryLatencyMs.length,
      roundTripSamples: aggregateReport.roundTripLatencyMs.length
    },
    readiness,
    coverage,
    provenance: { gitSha: reference.gitSha, sourceQube: reference.sourceQube, targetQube: reference.targetQube, service: reference.service, transport: reference.transport, runIds }
  };
}

export function parseMultiRunJson(input) {
  if (typeof input !== 'string') throw new TypeError('input must be a string');
  const parsed = JSON.parse(input);
  if (!Array.isArray(parsed)) throw new TypeError('input JSON must be an array of campaign JSONL strings or event arrays');
  return parsed.map((campaign, index) => {
    if (Array.isArray(campaign)) return campaign;
    if (typeof campaign === 'string') return parseCampaignJsonl(campaign);
    throw new TypeError(`campaign[${index}] must be an event array or JSONL string`);
  });
}

async function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  const campaigns = parseMultiRunJson(input);
  const thresholds = {
    expectedGitSha: process.env.DIG_GIT_SHA || null,
    expectedSourceQube: process.env.DIG_SOURCE_QUBE || null,
    expectedTargetQube: process.env.DIG_TARGET_QUBE || null,
    expectedService: process.env.DIG_QREXEC_SERVICE || null
  };
  process.stdout.write(`${JSON.stringify(evaluateMultiRunQualification(campaigns, thresholds), null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch(error => {
  process.stderr.write(`DIG Qubes multi-run qualification failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
