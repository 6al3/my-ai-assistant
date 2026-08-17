import { pathToFileURL } from 'node:url';

function assertFiniteDuration(value, name) {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${name} must be a non-negative finite number`);
}

function assertString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be a non-empty string`);
  return value.trim();
}

export function collectQrexecCampaign(events) {
  if (!Array.isArray(events)) throw new TypeError('events must be an array');

  const recoveryLatencyMs = [];
  const roundTripLatencyMs = [];
  const committedMutationKeys = new Set();
  const pendingRequests = new Set();
  let duplicateCommittedMutations = 0;
  let staleCompletions = 0;
  let qaBeforeJoin = 0;

  for (const [index, event] of events.entries()) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new TypeError(`event[${index}] must be an object`);
    const type = assertString(event.type, `event[${index}].type`);

    switch (type) {
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
      case 'mutation_committed': {
        const mutationKey = assertString(event.mutationKey, `event[${index}].mutationKey`);
        if (committedMutationKeys.has(mutationKey)) duplicateCommittedMutations += 1;
        else committedMutationKeys.add(mutationKey);
        break;
      }
      case 'stale_completion': {
        staleCompletions += 1;
        break;
      }
      case 'request_pending': {
        pendingRequests.add(assertString(event.requestId, `event[${index}].requestId`));
        break;
      }
      case 'request_resolved': {
        pendingRequests.delete(assertString(event.requestId, `event[${index}].requestId`));
        break;
      }
      case 'qa_started': {
        if (!Number.isInteger(event.pendingDependencies) || event.pendingDependencies < 0) {
          throw new TypeError(`event[${index}].pendingDependencies must be a non-negative integer`);
        }
        if (event.pendingDependencies > 0) qaBeforeJoin += 1;
        break;
      }
      default:
        throw new Error(`unsupported campaign event type: ${type}`);
    }
  }

  return {
    duplicateCommittedMutations,
    staleCompletions,
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
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`invalid campaign JSON on line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
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
