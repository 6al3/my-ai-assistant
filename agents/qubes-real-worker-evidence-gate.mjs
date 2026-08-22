import { pathToFileURL } from 'node:url';
import { collectQrexecCampaign, parseCampaignJsonl } from './qubes-qrexec-campaign-collector.mjs';
import { evaluateQrexecReadiness } from './qubes-qrexec-readiness-gate.mjs';

function nonEmpty(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be a non-empty string`);
  return value.trim();
}

export function evaluateCampaignCoverage(events) {
  if (!Array.isArray(events)) throw new TypeError('events must be an array');
  const pending = new Set();
  const resolvedAfterPending = new Set();
  let campaignStarts = 0;
  let campaignEnds = 0;
  let committedMutations = 0;
  let recoveryEvents = 0;
  let qaBarrierProbes = 0;
  let qaBarrierBlocks = 0;
  let qaPostJoinStarts = 0;
  let staleLeaseProbes = 0;
  let currentLeaseCompletions = 0;

  for (const [index, event] of events.entries()) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new TypeError(`event[${index}] must be an object`);
    const type = nonEmpty(event.type, `event[${index}].type`);
    if (type === 'campaign_start') campaignStarts += 1;
    else if (type === 'campaign_end') campaignEnds += 1;
    else if (type === 'mutation_committed') committedMutations += 1;
    else if (type === 'recovery') recoveryEvents += 1;
    else if (type === 'qa_barrier_probe') {
      if (typeof event.blocked !== 'boolean') throw new TypeError(`event[${index}].blocked must be a boolean`);
      qaBarrierProbes += 1;
      if (event.blocked) qaBarrierBlocks += 1;
    }
    else if (type === 'qa_post_join_start') qaPostJoinStarts += 1;
    else if (type === 'stale_completion_probe') staleLeaseProbes += 1;
    else if (type === 'current_lease_completion') currentLeaseCompletions += 1;
    else if (type === 'request_pending') pending.add(nonEmpty(event.requestId, `event[${index}].requestId`));
    else if (type === 'request_resolved') {
      const requestId = nonEmpty(event.requestId, `event[${index}].requestId`);
      if (pending.has(requestId)) resolvedAfterPending.add(requestId);
    }
  }

  const checks = {
    exactlyOneCampaignStart: campaignStarts === 1,
    exactlyOneCampaignEnd: campaignEnds === 1,
    committedMutationObserved: committedMutations > 0,
    pendingRequestWasResolved: resolvedAfterPending.size > 0,
    recoveryWasActuallyExercised: recoveryEvents > 0,
    qaBarrierWasActuallyProbed: qaBarrierProbes > 0,
    qaWasBlockedBeforeJoin: qaBarrierProbes > 0 && qaBarrierBlocks === qaBarrierProbes,
    qaStartedAfterJoin: qaPostJoinStarts > 0,
    staleLeaseWasActuallyProbed: staleLeaseProbes > 0,
    currentLeaseCompletionObserved: currentLeaseCompletions > 0
  };
  const failedChecks = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  return {
    ready: failedChecks.length === 0,
    failedChecks,
    checks,
    metrics: {
      campaignStarts,
      campaignEnds,
      committedMutations,
      resolvedAfterPending: resolvedAfterPending.size,
      recoveryEvents,
      qaBarrierProbes,
      qaBarrierBlocks,
      qaPostJoinStarts,
      staleLeaseProbes,
      currentLeaseCompletions
    }
  };
}

export function evaluateRealWorkerEvidence(events, thresholds = {}) {
  const report = collectQrexecCampaign(events);
  const readiness = evaluateQrexecReadiness(report, thresholds);
  const coverage = evaluateCampaignCoverage(events);
  const failedChecks = [
    ...readiness.failedChecks.map(name => `readiness:${name}`),
    ...coverage.failedChecks.map(name => `coverage:${name}`)
  ];
  return {
    ready: failedChecks.length === 0,
    classification: failedChecks.length === 0 ? 'REAL-WORKER READY' : 'LAB READY',
    failedChecks,
    readiness,
    coverage
  };
}

async function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  const events = parseCampaignJsonl(input);
  const thresholds = {
    expectedGitSha: process.env.DIG_GIT_SHA || null,
    expectedSourceQube: process.env.DIG_SOURCE_QUBE || null,
    expectedTargetQube: process.env.DIG_TARGET_QUBE || null,
    expectedService: process.env.DIG_QREXEC_SERVICE || null
  };
  process.stdout.write(`${JSON.stringify(evaluateRealWorkerEvidence(events, thresholds), null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch(error => {
  process.stderr.write(`DIG Qubes real-worker evidence gate failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
