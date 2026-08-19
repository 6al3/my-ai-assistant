import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateAttestedMultiRunQualification } from './qubes-attested-multi-run-qualification.mjs';

const SHA = 'a'.repeat(40), NORMAL = 'dig.Coordinator', FAULT = 'dig.CoordinatorFault', KEY = 'dig-key-1';
const baseThresholds = { expectedGitSha: SHA, expectedSourceQube: 'worker', expectedTargetQube: 'coordinator', expectedService: NORMAL, expectedFaultService: FAULT, expectedAttestationKeyId: KEY, nowMs: Date.parse('2026-08-18T10:00:02Z') };
const a = service => ({ service, keyId: KEY, gitSha: SHA });
function campaign(attestations = []) { return [{ type:'campaign_start', runId:'r1', transport:'qrexec', sourceQube:'worker', targetQube:'coordinator', service:NORMAL, gitSha:SHA, startedAt:'2026-08-18T10:00:00Z' }, ...attestations.map(item => ({ type:'attestation_verified', ...item })), { type:'campaign_end', runId:'r1', finishedAt:'2026-08-18T10:00:01Z' }]; }

test('attested qualification fails closed without verified campaign and dual-service preflight evidence', () => {
  const result = evaluateAttestedMultiRunQualification([campaign()], baseThresholds);
  assert.equal(result.ready, false);
  assert.ok(result.failedChecks.includes('verifiedAttestationEvidencePresent'));
  assert.ok(result.failedChecks.includes('verifiedNormalServiceCampaignAttestationObserved'));
  assert.ok(result.failedChecks.includes('verifiedFaultServicePreflightAttestationObserved'));
});

test('fault service attestation is sourced from read-only preflight while normal campaign response must also be verified', () => {
  const thresholds = { ...baseThresholds, preflightVerifiedAttestations: [a(NORMAL), a(FAULT)] };
  const result = evaluateAttestedMultiRunQualification([campaign([a(NORMAL)])], thresholds);
  assert.equal(result.checks.verifiedNormalServiceCampaignAttestationObserved, true);
  assert.equal(result.checks.verifiedNormalServicePreflightAttestationObserved, true);
  assert.equal(result.checks.verifiedFaultServicePreflightAttestationObserved, true);
  assert.equal(result.checks.onlyExpectedAttestationBindingsObserved, true);
  assert.equal(result.metrics.verifiedCampaignAttestations, 1);
  assert.equal(result.metrics.verifiedPreflightAttestations, 2);
  assert.equal(result.ready, false);
  assert.ok(result.failedChecks.some(name => !name.startsWith('verified') && name !== 'onlyExpectedAttestationBindingsObserved'));
});

test('attested qualification rejects wrong key id, sha, service, and missing fault preflight coverage', () => {
  for (const [name, preflight, campaignEvents, failed] of [
    ['wrong key', [{ service:NORMAL,keyId:'other',gitSha:SHA },a(FAULT)], [a(NORMAL)], 'onlyExpectedAttestationBindingsObserved'],
    ['wrong sha', [{ service:NORMAL,keyId:KEY,gitSha:'b'.repeat(40) },a(FAULT)], [a(NORMAL)], 'onlyExpectedAttestationBindingsObserved'],
    ['third service', [a(NORMAL),a(FAULT),a('dig.Other')], [a(NORMAL)], 'onlyExpectedAttestationBindingsObserved'],
    ['missing fault preflight', [a(NORMAL)], [a(NORMAL)], 'verifiedFaultServicePreflightAttestationObserved'],
    ['missing campaign verification', [a(NORMAL),a(FAULT)], [], 'verifiedNormalServiceCampaignAttestationObserved']
  ]) {
    const result = evaluateAttestedMultiRunQualification([campaign(campaignEvents)], { ...baseThresholds, preflightVerifiedAttestations: preflight });
    assert.equal(result.ready, false, name);
    assert.ok(result.failedChecks.includes(failed), name);
  }
});
