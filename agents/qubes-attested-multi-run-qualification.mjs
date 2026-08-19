import { pathToFileURL } from 'node:url';
import { collectQrexecCampaign, parseCampaignJsonl } from './qubes-qrexec-campaign-collector.mjs';
import { evaluateMultiRunQualification } from './qubes-multi-run-qualification.mjs';

function nonEmpty(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be a non-empty string`);
  return value.trim();
}

export function evaluateAttestedMultiRunQualification(campaigns, thresholds = {}) {
  const expectedGitSha = nonEmpty(thresholds.expectedGitSha, 'expectedGitSha');
  const expectedService = nonEmpty(thresholds.expectedService, 'expectedService');
  const expectedFaultService = nonEmpty(thresholds.expectedFaultService, 'expectedFaultService');
  const expectedAttestationKeyId = nonEmpty(thresholds.expectedAttestationKeyId, 'expectedAttestationKeyId');
  if (expectedService === expectedFaultService) throw new Error('expectedService and expectedFaultService must differ');

  const base = evaluateMultiRunQualification(campaigns, thresholds);
  const reports = campaigns.map(collectQrexecCampaign);
  const attestations = reports.flatMap(report => report.verifiedAttestations ?? []);
  const services = new Set(attestations.map(item => item.service));
  const exactBindings = attestations.length > 0 && attestations.every(item =>
    item.gitSha === expectedGitSha &&
    item.keyId === expectedAttestationKeyId &&
    (item.service === expectedService || item.service === expectedFaultService)
  );
  const checks = {
    ...base.checks,
    verifiedAttestationEvidencePresent: attestations.length > 0,
    verifiedNormalServiceAttestationObserved: services.has(expectedService),
    verifiedFaultServiceAttestationObserved: services.has(expectedFaultService),
    onlyExpectedAttestationBindingsObserved: exactBindings
  };
  const failedChecks = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  return {
    ...base,
    ready: failedChecks.length === 0,
    classification: failedChecks.length === 0 ? 'REAL-WORKER READY' : 'LAB READY',
    failedChecks,
    checks,
    metrics: { ...base.metrics, verifiedAttestations: attestations.length, attestedServices: [...services].sort(), attestationKeyId: expectedAttestationKeyId }
  };
}

export function parseAttestedMultiRunJson(input) {
  if (typeof input !== 'string') throw new TypeError('input must be a string');
  const parsed = JSON.parse(input);
  if (!Array.isArray(parsed)) throw new TypeError('input JSON must be an array');
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
  const campaigns = parseAttestedMultiRunJson(input);
  const result = evaluateAttestedMultiRunQualification(campaigns, {
    expectedGitSha: process.env.DIG_GIT_SHA,
    expectedSourceQube: process.env.DIG_SOURCE_QUBE,
    expectedTargetQube: process.env.DIG_TARGET_QUBE,
    expectedService: process.env.DIG_QREXEC_SERVICE,
    expectedFaultService: process.env.DIG_QREXEC_FAULT_SERVICE,
    expectedAttestationKeyId: process.env.DIG_RESPONSE_ATTESTATION_KEY_ID
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ready) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch(error => {
  process.stderr.write(`DIG attested Qubes qualification failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
