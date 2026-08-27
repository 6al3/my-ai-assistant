import { collectReadonlyQrexecPolicyQualification } from './qrexec-readonly-policy-collector.mjs';
import { createQrexecClientVmInvoker, QREXEC_READONLY_PHASE1_DEFAULTS } from './qrexec-readonly-phase1-harness.mjs';
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

/**
 * Compose the real Worker-Qube qrexec process invoker with the read-only policy collector.
 * The caller supplies only coordinator-side mutation snapshots and the public attestation
 * identity. No state-changing MissionQueue operation is exposed by this runner.
 */
export async function runReadonlyQrexecPhase1Qualification({
  gitSha,
  runtimeFingerprint,
  sourceQube,
  coordinatorQube,
  intendedService,
  scenarios,
  snapshotMutationState,
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
  const snapshot = requiredFunction(snapshotMutationState, 'snapshotMutationState');
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
