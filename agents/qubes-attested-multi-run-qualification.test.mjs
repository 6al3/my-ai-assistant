import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateAttestedMultiRunQualification } from './qubes-attested-multi-run-qualification.mjs';

const SHA = 'a'.repeat(40), NORMAL = 'dig.Coordinator', FAULT = 'dig.CoordinatorFault', KEY = 'dig-key-1';
const thresholds = { expectedGitSha: SHA, expectedSourceQube: 'worker', expectedTargetQube: 'coordinator', expectedService: NORMAL, expectedFaultService: FAULT, expectedAttestationKeyId: KEY, nowMs: Date.parse('2026-08-18T10:00:02Z') };
function campaign(attestations = []) { return [{ type:'campaign_start', runId:'r1', transport:'qrexec', sourceQube:'worker', targetQube:'coordinator', service:NORMAL, gitSha:SHA, startedAt:'2026-08-18T10:00:00Z' }, ...attestations.map(a => ({ type:'attestation_verified', ...a })), { type:'campaign_end', runId:'r1', finishedAt:'2026-08-18T10:00:01Z' }]; }

test('attested qualification fails closed without verified responses', () => {
  const result = evaluateAttestedMultiRunQualification([campaign()], thresholds);
  assert.equal(result.ready, false);
  assert.ok(result.failedChecks.includes('verifiedAttestationEvidencePresent'));
});

test('attested qualification rejects wrong key id, sha, service, and normal-only coverage', () => {
  for (const [name, events] of [
    ['wrong key', [{ service:NORMAL,keyId:'other',gitSha:SHA },{ service:FAULT,keyId:KEY,gitSha:SHA }]],
    ['wrong sha', [{ service:NORMAL,keyId:KEY,gitSha:'b'.repeat(40) },{ service:FAULT,keyId:KEY,gitSha:SHA }]],
    ['third service', [{ service:NORMAL,keyId:KEY,gitSha:SHA },{ service:FAULT,keyId:KEY,gitSha:SHA },{ service:'dig.Other',keyId:KEY,gitSha:SHA }]],
    ['normal only', [{ service:NORMAL,keyId:KEY,gitSha:SHA }]]
  ]) {
    const result = evaluateAttestedMultiRunQualification([campaign(events)], thresholds);
    assert.equal(result.ready, false, name);
    if (name === 'normal only') assert.ok(result.failedChecks.includes('verifiedFaultServiceAttestationObserved'));
    else assert.ok(result.failedChecks.includes('onlyExpectedAttestationBindingsObserved'));
  }
});

test('attestation bindings can pass while base qualification remains fail-closed on missing scenario evidence', () => {
  const result = evaluateAttestedMultiRunQualification([campaign([{ service:NORMAL,keyId:KEY,gitSha:SHA },{ service:FAULT,keyId:KEY,gitSha:SHA }])], thresholds);
  assert.equal(result.checks.verifiedNormalServiceAttestationObserved, true);
  assert.equal(result.checks.verifiedFaultServiceAttestationObserved, true);
  assert.equal(result.checks.onlyExpectedAttestationBindingsObserved, true);
  assert.equal(result.ready, false);
  assert.ok(result.failedChecks.some(name => !name.startsWith('verified') && name !== 'onlyExpectedAttestationBindingsObserved'));
});
