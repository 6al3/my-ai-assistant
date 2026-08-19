import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateAttestedMultiRunQualification } from './qubes-attested-multi-run-qualification.mjs';

const SHA = 'a'.repeat(40), NORMAL = 'dig.Coordinator', FAULT = 'dig.CoordinatorFault', KEY = 'dig-key-1';
const baseThresholds = { expectedGitSha: SHA, expectedSourceQube: 'worker', expectedTargetQube: 'coordinator', expectedService: NORMAL, expectedFaultService: FAULT, expectedAttestationKeyId: KEY, nowMs: Date.parse('2026-08-18T10:00:02Z') };
const a = (service, requestId) => ({ service, keyId: KEY, gitSha: SHA, ...(requestId ? { requestId } : {}) });
function campaign(attestations = []) {
  const requestIds = [...new Set(attestations.map(item => item.requestId).filter(Boolean))];
  return [
    { type:'campaign_start', runId:'r1', transport:'qrexec', sourceQube:'worker', targetQube:'coordinator', service:NORMAL, gitSha:SHA, startedAt:'2026-08-18T10:00:00Z' },
    ...requestIds.map(requestId => ({ type:'request_pending', requestId })),
    ...attestations.map(item => ({ type:'attestation_verified', ...item })),
    ...requestIds.map(requestId => ({ type:'request_resolved', requestId })),
    { type:'campaign_end', runId:'r1', finishedAt:'2026-08-18T10:00:01Z' }
  ];
}

test('attested qualification fails closed without verified campaign and dual-service preflight evidence', () => {
  const result = evaluateAttestedMultiRunQualification([campaign()], baseThresholds);
  assert.equal(result.ready, false);
  assert.ok(result.failedChecks.includes('verifiedAttestationEvidencePresent'));
  assert.ok(result.failedChecks.includes('verifiedNormalServiceCampaignAttestationObserved'));
  assert.ok(result.failedChecks.includes('verifiedFaultServicePreflightAttestationObserved'));
  assert.ok(result.failedChecks.includes('allCampaignAttestationsBoundToObservedRequests'));
  assert.ok(result.failedChecks.includes('allCampaignAttestationsBoundToCompletedLifecycles'));
});

test('fault service attestation is sourced from read-only preflight while normal campaign response is request-bound and resolved', () => {
  const thresholds = { ...baseThresholds, preflightVerifiedAttestations: [a(NORMAL), a(FAULT)] };
  const result = evaluateAttestedMultiRunQualification([campaign([a(NORMAL, 'req-1')])], thresholds);
  assert.equal(result.checks.verifiedNormalServiceCampaignAttestationObserved, true);
  assert.equal(result.checks.verifiedNormalServicePreflightAttestationObserved, true);
  assert.equal(result.checks.verifiedFaultServicePreflightAttestationObserved, true);
  assert.equal(result.checks.onlyExpectedAttestationBindingsObserved, true);
  assert.equal(result.checks.allCampaignAttestationsBoundToObservedRequests, true);
  assert.equal(result.checks.allCampaignAttestationsBoundToCompletedLifecycles, true);
  assert.equal(result.metrics.completedVerifiedRequestLifecycles, 1);
  assert.equal(result.metrics.verifiedCampaignAttestations, 1);
  assert.equal(result.metrics.verifiedPreflightAttestations, 2);
  assert.equal(result.ready, false);
  assert.ok(result.failedChecks.some(name => !name.startsWith('verified') && name !== 'onlyExpectedAttestationBindingsObserved' && name !== 'allCampaignAttestationsBoundToObservedRequests' && name !== 'allCampaignAttestationsBoundToCompletedLifecycles'));
});

test('collector rejects a verified response whose request lifecycle never started', () => {
  const events = campaign([a(NORMAL, 'req-1')]).filter(event => event.type !== 'request_pending');
  assert.throws(() => evaluateAttestedMultiRunQualification([events], { ...baseThresholds, preflightVerifiedAttestations: [a(NORMAL), a(FAULT)] }), /attestation_verified requires pending request/);
});

test('attested qualification rejects verified evidence whose request never resolves', () => {
  const events = campaign([a(NORMAL, 'req-1')]).filter(event => event.type !== 'request_resolved');
  const result = evaluateAttestedMultiRunQualification([events], { ...baseThresholds, preflightVerifiedAttestations: [a(NORMAL), a(FAULT)] });
  assert.equal(result.ready, false);
  assert.equal(result.checks.allCampaignAttestationsBoundToObservedRequests, true);
  assert.equal(result.checks.allCampaignAttestationsBoundToCompletedLifecycles, false);
  assert.equal(result.metrics.completedVerifiedRequestLifecycles, 0);
  assert.ok(result.failedChecks.includes('allCampaignAttestationsBoundToCompletedLifecycles'));
});

test('attested qualification rejects wrong key id, sha, service, and missing fault preflight coverage', () => {
  for (const [name, preflight, campaignEvents, failed] of [
    ['wrong key', [{ service:NORMAL,keyId:'other',gitSha:SHA },a(FAULT)], [a(NORMAL,'req-1')], 'onlyExpectedAttestationBindingsObserved'],
    ['wrong sha', [{ service:NORMAL,keyId:KEY,gitSha:'b'.repeat(40) },a(FAULT)], [a(NORMAL,'req-1')], 'onlyExpectedAttestationBindingsObserved'],
    ['third service', [a(NORMAL),a(FAULT),a('dig.Other')], [a(NORMAL,'req-1')], 'onlyExpectedAttestationBindingsObserved'],
    ['missing fault preflight', [a(NORMAL)], [a(NORMAL,'req-1')], 'verifiedFaultServicePreflightAttestationObserved'],
    ['missing campaign verification', [a(NORMAL),a(FAULT)], [], 'verifiedNormalServiceCampaignAttestationObserved']
  ]) {
    const result = evaluateAttestedMultiRunQualification([campaign(campaignEvents)], { ...baseThresholds, preflightVerifiedAttestations: preflight });
    assert.equal(result.ready, false, name);
    assert.ok(result.failedChecks.includes(failed), name);
  }
});
