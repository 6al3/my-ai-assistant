import { pathToFileURL } from 'node:url';

function assertFiniteDuration(value, name) {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${name} must be a non-negative finite number`);
}

function assertString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be a non-empty string`);
  return value.trim();
}

function assertIsoDate(value, name) {
  const text = assertString(value, name);
  if (!Number.isFinite(Date.parse(text))) throw new TypeError(`${name} must be an ISO date`);
  return text;
}

export function collectQrexecCampaign(events) {
  if (!Array.isArray(events)) throw new TypeError('events must be an array');

  const recoveryLatencyMs = [];
  const roundTripLatencyMs = [];
  const committedMutationKeys = new Set();
  const pendingRequests = new Set();
  let duplicateCommittedMutations = 0;
  let staleCompletions = 0;
  let staleCompletionProbes = 0;
  let staleCompletionRejections = 0;
  let currentLeaseCompletions = 0;
  let qaBeforeJoin = 0;
  let provenance = null;
  let endedAt = null;

  for (const [index, event] of events.entries()) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new TypeError(`event[${index}] must be an object`);
    const type = assertString(event.type, `event[${index}].type`);

    switch (type) {
      case 'campaign_start': {
        if (provenance) throw new Error('campaign_start may appear only once');
        const sourceQube = assertString(event.sourceQube, `event[${index}].sourceQube`);
        const targetQube = assertString(event.targetQube, `event[${index}].targetQube`);
        if (sourceQube === targetQube) throw new Error('sourceQube and targetQube must differ');
        provenance = {
          runId: assertString(event.runId, `event[${index}].runId`),
          transport: assertString(event.transport, `event[${index}].transport`),
          sourceQube,
          targetQube,
          service: assertString(event.service, `event[${index}].service`),
          gitSha: assertString(event.gitSha, `event[${index}].gitSha`),
          startedAt: assertIsoDate(event.startedAt, `event[${index}].startedAt`)
        };
        break;
      }
      case 'campaign_end': {
        if (!provenance) throw new Error('campaign_end requires campaign_start');
        if (endedAt) throw new Error('campaign_end may appear only once');
        if (assertString(event.runId, `event[${index}].runId`) !== provenance.runId) throw new Error('campaign_end runId mismatch');
        endedAt = assertIsoDate(event.finishedAt, `event[${index}].finishedAt`);
        if (Date.parse(endedAt) < Date.parse(provenance.startedAt)) throw new Error('campaign_end precedes campaign_start');
        break;
      }
      case 'qrexec_service_call': {
        assertString(event.service, `event[${index}].service`);
        break;
      }
      case 'round_trip': {
        assertFiniteDuration(event.durationMs, `event[${index}].durationMs`);
        roundTripLatencyMs.push(event.durationMs);
        break;
      }
      case 'recovery': {
        assertFiniteDuration(event.durationMs, `event[${index}].durationMs`);
        recoveryLatencyMs.push(event.durationMs);
        break;
      }
      case 'wait': {
        assertFiniteDuration(event.durationMs, `event[${index}].durationMs`);
        if (event.durationMs > 120_000) throw new TypeError(`event[${index}].durationMs must be at most 120000`);
        break;
      }
      case 'mutation_committed': {
        const mutationKey = assertString(event.mutationKey, `event[${index}].mutationKey`);
        if (committedMutationKeys.has(mutationKey)) duplicateCommittedMutations += 1;
        else committedMutationKeys.add(mutationKey);
        break;
      }
      case 'stale_completion': staleCompletions += 1; break;
      case 'stale_completion_probe': {
        if (typeof event.rejected !== 'boolean') throw new TypeError(`event[${index}].rejected must be a boolean`);
        staleCompletionProbes += 1;
        if (event.rejected) staleCompletionRejections += 1;
        break;
      }
      case 'current_lease_completion': currentLeaseCompletions += 1; break;
      case 'request_pending': pendingRequests.add(assertString(event.requestId, `event[${index}].requestId`)); break;
      case 'request_resolved': pendingRequests.delete(assertString(event.requestId, `event[${index}].requestId`)); break;
      case 'qa_barrier_probe': {
        if (typeof event.blocked !== 'boolean') throw new TypeError(`event[${index}].blocked must be a boolean`);
        if (!event.blocked) qaBeforeJoin += 1;
        break;
      }
      case 'qa_post_join_start': break;
      case 'qa_started': {
        if (!Number.isInteger(event.pendingDependencies) || event.pendingDependencies < 0) throw new TypeError(`event[${index}].pendingDependencies must be a non-negative integer`);
        if (event.pendingDependencies > 0) qaBeforeJoin += 1;
        break;
      }
      default: throw new Error(`unsupported campaign event type: ${type}`);
    }
  }

  return {
    provenance: provenance && endedAt ? { ...provenance, finishedAt: endedAt } : null,
    duplicateCommittedMutations,
    staleCompletions,
    staleCompletionProbes,
    staleCompletionRejections,
    currentLeaseCompletions,
    unresolvedPendingRequests: pendingRequests.size,
    qaBeforeJoin,
    recoveryLatencyMs,
    roundTripLatencyMs
  };
}

export function parseCampaignJsonl(input) {
  if (typeof input !== 'string') throw new TypeError('input must be a string');
  const lines = input.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return lines.map((line, index) => {
    try { return JSON.parse(line); }
    catch (error) { throw new Error(`invalid campaign JSON on line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`); }
  });
}

async function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  const report = collectQrexecCampaign(parseCampaignJsonl(input));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    process.stderr.write(`DIG Qubes campaign collector failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
