import { pathToFileURL } from 'node:url';
import { collectQrexecCampaign, parseCampaignJsonl } from './qubes-qrexec-campaign-collector.mjs';
import { evaluateMultiRunQualification } from './qubes-multi-run-qualification.mjs';

function nonEmpty(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be a non-empty string`);
  return value.trim();
}

function normalizeAttestation(item, name, { requireRequestId = false } = {}) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError(`${name} must be an object`);
  const normalized = { service: nonEmpty(item.service, `${name}.service`), keyId: nonEmpty(item.keyId, `${name}.keyId`), gitSha: nonEmpty(item.gitSha, `${name}.gitSha`) };
  if (requireRequestId) normalized.requestId = nonEmpty(item.requestId, `${name}.requestId`);
  return normalized;
}

export function evaluateAttestedMultiRunQualification(campaigns, thresholds = {}) {
  const expectedGitSha = nonEmpty(thresholds.expectedGitSha, 'expectedGitSha');
  const expectedService = nonEmpty(thresholds.expectedService, 'expectedService');
  const expectedFaultService = nonEmpty(thresholds.expectedFaultService, 'expectedFaultService');
  const expectedAttestationKeyId = nonEmpty(thresholds.expectedAttestationKeyId, 'expectedAttestationKeyId');
  if (expectedService === expectedFaultService) throw new Error('expectedService and expectedFaultService must differ');

  const base = evaluateMultiRunQualification(campaigns, thresholds);
  const reports = campaigns.map(collectQrexecCampaign);
  const campaignAttestations = reports.flatMap((report, reportIndex) => (report.verifiedAttestations ?? []).map((item, itemIndex) => ({ ...normalizeAttestation(item, `campaignAttestations[${reportIndex}][${itemIndex}]`, { requireRequestId: true }), reportIndex })));
  const preflightAttestations = (thresholds.preflightVerifiedAttestations ?? []).map((item, index) => normalizeAttestation(item, `preflightVerifiedAttestations[${index}]`));
  const allAttestations = [...campaignAttestations, ...preflightAttestations];
  const campaignServices = new Set(campaignAttestations.map(item => item.service));
  const preflightServices = new Set(preflightAttestations.map(item => item.service));
  const allServices = new Set(allAttestations.map(item => item.service));
  const exactBindings = allAttestations.length > 0 && allAttestations.every(item => item.gitSha === expectedGitSha && item.keyId === expectedAttestationKeyId && (item.service === expectedService || item.service === expectedFaultService));
  const requestBindings = campaignAttestations.length > 0 && campaignAttestations.every(item => new Set(reports[item.reportIndex].observedRequestIds ?? []).has(item.requestId));
  const checks = {
    ...base.checks,
    verifiedAttestationEvidencePresent: allAttestations.length > 0,
    verifiedNormalServiceCampaignAttestationObserved: campaignServices.has(expectedService),
    verifiedNormalServicePreflightAttestationObserved: preflightServices.has(expectedService),
    verifiedFaultServicePreflightAttestationObserved: preflightServices.has(expectedFaultService),
    onlyExpectedAttestationBindingsObserved: exactBindings,
    allCampaignAttestationsBoundToObservedRequests: requestBindings
  };
  const failedChecks = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  return { ...base, ready: failedChecks.length === 0, classification: failedChecks.length === 0 ? 'REAL-WORKER READY' : 'LAB READY', failedChecks, checks, metrics: { ...base.metrics, verifiedAttestations: allAttestations.length, verifiedCampaignAttestations: campaignAttestations.length, verifiedPreflightAttestations: preflightAttestations.length, attestedServices: [...allServices].sort(), attestationKeyId: expectedAttestationKeyId } };
}

export function parseAttestedMultiRunJson(input) {
  if (typeof input !== 'string') throw new TypeError('input must be a string');
  const parsed = JSON.parse(input);
  if (!Array.isArray(parsed)) throw new TypeError('input JSON must be an array');
  return parsed.map((campaign, index) => { if (Array.isArray(campaign)) return campaign; if (typeof campaign === 'string') return parseCampaignJsonl(campaign); throw new TypeError(`campaign[${index}] must be an event array or JSONL string`); });
}

async function main() {
  let input = ''; process.stdin.setEncoding('utf8'); for await (const chunk of process.stdin) input += chunk;
  const campaigns = parseAttestedMultiRunJson(input);
  const result = evaluateAttestedMultiRunQualification(campaigns, { expectedGitSha: process.env.DIG_GIT_SHA, expectedSourceQube: process.env.DIG_SOURCE_QUBE, expectedTargetQube: process.env.DIG_TARGET_QUBE, expectedService: process.env.DIG_QREXEC_SERVICE, expectedFaultService: process.env.DIG_QREXEC_FAULT_SERVICE, expectedAttestationKeyId: process.env.DIG_RESPONSE_ATTESTATION_KEY_ID });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); if (!result.ready) process.exitCode = 1;
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch(error => { process.stderr.write(`DIG attested Qubes qualification failed: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
