import { collectReadonlyQrexecPolicyQualification } from './qrexec-readonly-policy-collector.mjs';
import { createQrexecClientVmInvoker, QREXEC_READONLY_PHASE1_DEFAULTS } from './qrexec-readonly-phase1-harness.mjs';
import { createReadonlyMutationStateSnapshotter } from './qrexec-readonly-mutation-snapshot.mjs';
import { qualifyReadonlyFilesystemEnforcement } from './qrexec-readonly-filesystem-enforcement.mjs';
import { READONLY_QREXEC_POLICY_SCENARIOS } from './qrexec-readonly-policy-qualification.mjs';
import { verifyCoordinatorResponseAttestation } from './qrexec-response-attestation.mjs';

function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required`);
  return value.trim();
}

function requiredFunction(value, name) {
  if (typeof value !== 'function') throw new Error(`${name} must be a function`);
  return value;
}

function validateScenarioDefinitions(scenarios) {
  if (!scenarios || typeof scenarios !== 'object' || Array.isArray(scenarios)) throw new Error('scenarios is required');
  for (const name of READONLY_QREXEC_POLICY_SCENARIOS) {
    const definition = scenarios[name];
    if (!definition || typeof definition !== 'object' || Array.isArray(definition)) throw new Error(`scenario ${name} is required`);
    requiredString(definition.service, `scenario ${name}.service`);
    if (definition.payload == null) throw new Error(`scenario ${name}.payload is required`);
  }
  return scenarios;
}

async function verifyFilesystemGate({ verifyFilesystemEnforcement, missionStorePath, requestJournalPath }) {
  if (verifyFilesystemEnforcement != null) {
    const report = await requiredFunction(verifyFilesystemEnforcement, 'verifyFilesystemEnforcement')();
    if (!report || report.enforcementVerified !== true) throw new Error('read-only filesystem enforcement was not verified');
    return;
  }
  const report = await qualifyReadonlyFilesystemEnforcement({
    missionStorePath: requiredString(missionStorePath, 'missionStorePath'),
    requestJournalPath: requiredString(requestJournalPath, 'requestJournalPath')
  });
  if (report.enforcementVerified !== true) throw new Error('read-only filesystem enforcement was not verified');
}

function resolveMutationSnapshotter({ snapshotMutationState, missionStorePath, requestJournalPath, snapshotMaxAttempts }) {
  if (snapshotMutationState != null) return requiredFunction(snapshotMutationState, 'snapshotMutationState');
  return createReadonlyMutationStateSnapshotter({
    missionStorePath: requiredString(missionStorePath, 'missionStorePath'),
    requestJournalPath: requiredString(requestJournalPath, 'requestJournalPath'),
    ...(snapshotMaxAttempts == null ? {} : { maxAttempts: snapshotMaxAttempts })
  });
}

/**
 * Compose the real Worker-Qube qrexec process invoker with the read-only policy collector.
 * Production/deployment callers provide coordinator-side MissionStore and request-journal paths;
 * the runner first proves that the Phase-1 service identity cannot write those durable targets,
 * then creates the byte+metadata snapshotter. Tests may inject explicit verification/snapshot seams.
 * No state-changing MissionQueue operation is imported or exposed here.
 */
export async function runReadonlyQrexecPhase1Qualification({
  gitSha,
  runtimeFingerprint,
  sourceQube,
  coordinatorQube,
  intendedService,
  scenarios,
  missionStorePath,
  requestJournalPath,
  snapshotMaxAttempts,
  snapshotMutationState,
  verifyFilesystemEnforcement,
  publicKeyPem,
  expectedKeyId,
  clientPath = QREXEC_READONLY_PHASE1_DEFAULTS.clientPath,
  timeoutMs = QREXEC_READONLY_PHASE1_DEFAULTS.timeoutMs,
  maxResponseBytes = QREXEC_READONLY_PHASE1_DEFAULTS.maxResponseBytes,
  spawnImpl
} = {}) {
  const expectedGitSha = requiredString(gitSha, 'gitSha').toLowerCase();
  const expectedService = requiredString(intendedService, 'intendedService');
  const scenarioDefinitions = validateScenarioDefinitions(scenarios);
  await verifyFilesystemGate({
    verifyFilesystemEnforcement,
    missionStorePath,
    requestJournalPath
  });
  const snapshot = resolveMutationSnapshotter({
    snapshotMutationState,
    missionStorePath,
    requestJournalPath,
    snapshotMaxAttempts
  });
  requiredString(publicKeyPem, 'publicKeyPem');
  const keyId = requiredString(expectedKeyId, 'expectedKeyId');

  const invokeScenario = createQrexecClientVmInvoker({
    coordinatorQube: requiredString(coordinatorQube, 'coordinatorQube'),
    scenarios: scenarioDefinitions,
    clientPath,
    timeoutMs,
    maxResponseBytes,
    ...(spawnImpl ? { spawnImpl } : {})
  });

  return collectReadonlyQrexecPolicyQualification({
    gitSha: expectedGitSha,
    runtimeFingerprint: requiredString(runtimeFingerprint, 'runtimeFingerprint'),
    sourceQube: requiredString(sourceQube, 'sourceQube'),
    coordinatorQube: requiredString(coordinatorQube, 'coordinatorQube'),
    intendedService: expectedService,
    maxResponseBytes,
    invokeScenario,
    snapshotMutationState: snapshot,
    verifyAllowedResponse(response) {
      const requestId = response?.attestation?.requestId;
      if (typeof requestId !== 'string' || requestId.trim() === '') return false;
      verifyCoordinatorResponseAttestation(response, {
        publicKeyPem,
        expectedKeyId: keyId,
        expectedGitSha,
        expectedService,
        expectedRequestId: requestId
      });
      return true;
    }
  });
}
