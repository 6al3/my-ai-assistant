import { randomBytes } from 'node:crypto';
import { importReadonlyQrexecDeploymentEvidence } from './qrexec-readonly-evidence-import.mjs';

function requiredFunction(value, name) {
  if (typeof value !== 'function') throw new Error(`${name} is required`);
  return value;
}

export function generateReadonlyEvidenceChallenge({ randomBytesFn = randomBytes } = {}) {
  requiredFunction(randomBytesFn, 'randomBytesFn');
  const bytes = randomBytesFn(24);
  if (!Buffer.isBuffer(bytes) || bytes.length !== 24) {
    throw new Error('randomBytesFn must return exactly 24 bytes');
  }
  return bytes.toString('base64url');
}

/**
 * Owns one Phase-1 deployment-evidence freshness run.
 *
 * The driver generates one unpredictable challenge, supplies the same value once to
 * each independently executed trust-domain exporter, then consumes exactly those two
 * exports through the existing authoritative importer. It adds no shared persistent
 * replay state and performs no MissionQueue mutation.
 */
export async function runReadonlyEvidenceChallengeQualification({
  collectDom0Export,
  collectCoordinatorExport,
  expected,
  randomBytesFn = randomBytes
} = {}) {
  const dom0Collector = requiredFunction(collectDom0Export, 'collectDom0Export');
  const coordinatorCollector = requiredFunction(collectCoordinatorExport, 'collectCoordinatorExport');
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) {
    throw new Error('expected deployment identity is required');
  }

  const evidenceChallenge = generateReadonlyEvidenceChallenge({ randomBytesFn });
  const challengeInput = Object.freeze({ evidenceChallenge });

  // The trust domains are independent. Running collectors concurrently reduces
  // qualification latency without merging their privileges or mutable state.
  const [dom0Export, coordinatorExport] = await Promise.all([
    dom0Collector(challengeInput),
    coordinatorCollector(challengeInput)
  ]);

  const artifact = importReadonlyQrexecDeploymentEvidence({
    exports: [dom0Export, coordinatorExport],
    expected: { ...expected, evidenceChallenge }
  });

  return Object.freeze({ evidenceChallenge, artifact });
}
