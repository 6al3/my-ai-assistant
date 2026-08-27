import { buildReadonlyQrexecPolicyQualification, verifyReadonlyQrexecPolicyQualification, READONLY_QREXEC_POLICY_SCENARIOS } from './qrexec-readonly-policy-qualification.mjs';

function requiredFunction(value, name) { if (typeof value !== 'function') throw new Error(`${name} must be a function`); return value; }
function requiredString(value, name) { if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required`); return value.trim(); }
function mutationEvidence(before, after, label) {
  return {
    missionStoreBefore: requiredString(before?.missionStoreDigest, `${label}.before.missionStoreDigest`),
    missionStoreAfter: requiredString(after?.missionStoreDigest, `${label}.after.missionStoreDigest`),
    requestJournalBefore: requiredString(before?.requestJournalDigest, `${label}.before.requestJournalDigest`),
    requestJournalAfter: requiredString(after?.requestJournalDigest, `${label}.after.requestJournalDigest`)
  };
}
function normalizeInvocation(result, scenario) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error(`scenario ${scenario} returned no observation`);
  if (!Number.isInteger(result.exitCode) || result.exitCode < 0 || result.exitCode > 255) throw new Error(`scenario ${scenario}.exitCode must be an integer from 0 to 255`);
  const allowed = scenario === 'intended-service-allowed';
  if (allowed && result.exitCode !== 0) throw new Error(`scenario ${scenario} must exit 0`);
  if (!allowed && result.exitCode === 0) throw new Error(`scenario ${scenario} must fail non-zero`);
  return { outcome: allowed ? 'allowed' : 'denied', exitCode: result.exitCode, response: result.response ?? null, responseBytes: Number.isSafeInteger(result.responseBytes) && result.responseBytes >= 0 ? result.responseBytes : null, responseFrames: Number.isSafeInteger(result.responseFrames) && result.responseFrames >= 0 ? result.responseFrames : null };
}

export async function collectReadonlyQrexecPolicyQualification({ gitSha, runtimeFingerprint, sourceQube, coordinatorQube, intendedService, maxResponseBytes, invokeScenario, snapshotMutationState, verifyAllowedResponse } = {}) {
  const invoke = requiredFunction(invokeScenario, 'invokeScenario');
  const snapshot = requiredFunction(snapshotMutationState, 'snapshotMutationState');
  const verifyResponse = requiredFunction(verifyAllowedResponse, 'verifyAllowedResponse');
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) throw new Error('maxResponseBytes must be a positive integer');

  const campaignBefore = await snapshot();
  const observations = {};
  const scenarioMutationEvidence = {};
  for (const scenario of READONLY_QREXEC_POLICY_SCENARIOS) {
    const before = await snapshot();
    observations[scenario] = normalizeInvocation(await invoke(scenario), scenario);
    const after = await snapshot();
    scenarioMutationEvidence[scenario] = mutationEvidence(before, after, `scenario ${scenario}`);
  }
  const campaignAfter = await snapshot();

  const allowed = observations['intended-service-allowed'];
  if (allowed.response === null) throw new Error('allowed scenario must return an attested response');
  if (await verifyResponse(allowed.response) !== true) throw new Error('allowed response attestation verification failed');
  if (allowed.responseBytes === null || allowed.responseBytes > maxResponseBytes) throw new Error('allowed response exceeds configured byte bound');
  if (allowed.responseFrames !== 1) throw new Error('allowed response must contain exactly one response frame');

  const report = buildReadonlyQrexecPolicyQualification({
    gitSha: requiredString(gitSha, 'gitSha'), runtimeFingerprint: requiredString(runtimeFingerprint, 'runtimeFingerprint'), sourceQube: requiredString(sourceQube, 'sourceQube'), coordinatorQube: requiredString(coordinatorQube, 'coordinatorQube'), intendedService: requiredString(intendedService, 'intendedService'),
    scenarios: Object.fromEntries(Object.entries(observations).map(([name, observation]) => [name, { outcome: observation.outcome, exitCode: observation.exitCode }])),
    attestationVerified: true, responseBounded: true, singleResponseFrame: true,
    mutationEvidence: mutationEvidence(campaignBefore, campaignAfter, 'campaign'),
    scenarioMutationEvidence
  });
  verifyReadonlyQrexecPolicyQualification(report);
  return report;
}
