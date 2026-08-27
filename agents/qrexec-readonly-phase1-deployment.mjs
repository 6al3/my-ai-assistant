import { runReadonlyQrexecPhase1Qualification } from './qrexec-readonly-phase1-runner.mjs';
import { verifyReadonlyServiceIdentityContract } from './qrexec-readonly-service-identity-contract.mjs';
import { verifyReadonlyQrexecDeploymentManifest } from './qrexec-readonly-deployment-manifest.mjs';
import { buildReadonlyQrexecDeploymentManifestFromArtifact } from './qrexec-readonly-deployment-artifact.mjs';
import { assembleReadonlyQrexecDeploymentArtifact } from './qrexec-readonly-deployment-evidence-collector.mjs';

function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required`);
  return value.trim();
}

function requiredUid(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive non-root uid`);
  return value;
}

/**
 * Deployment-facing Phase-1 entrypoint. Real qualification enters here so both the
 * declared identity contract and the deployed read-only qrexec manifest are checked
 * before filesystem qualification or any qrexec invocation occurs.
 */
export async function runIdentityBoundReadonlyQrexecPhase1Qualification(options = {}) {
  const gitSha = requiredString(options.gitSha, 'gitSha').toLowerCase();
  const intendedService = requiredString(options.intendedService, 'intendedService');
  const coordinatorQube = requiredString(options.coordinatorQube, 'coordinatorQube');
  const expectedServiceUser = requiredString(options.expectedServiceUser, 'expectedServiceUser');
  const expectedServiceUid = requiredUid(options.expectedServiceUid, 'expectedServiceUid');

  const expected = {
    expectedService: intendedService,
    expectedCoordinatorQube: coordinatorQube,
    expectedServiceUser,
    expectedServiceUid,
    expectedGitSha: gitSha
  };
  verifyReadonlyServiceIdentityContract(options.serviceIdentityContract, expected);
  verifyReadonlyQrexecDeploymentManifest(options.deploymentManifest, expected);

  return runReadonlyQrexecPhase1Qualification({
    ...options,
    gitSha,
    intendedService,
    coordinatorQube,
    expectedServiceUser,
    expectedServiceUid
  });
}

/**
 * Real-Qubes boundary: derive the manifest from independently captured dom0 policy +
 * coordinator qrexec service evidence instead of trusting a hand-authored manifest.
 */
export async function runArtifactBoundReadonlyQrexecPhase1Qualification(options = {}) {
  const gitSha = requiredString(options.gitSha, 'gitSha').toLowerCase();
  const intendedService = requiredString(options.intendedService, 'intendedService');
  const sourceQube = requiredString(options.sourceQube, 'sourceQube');
  const coordinatorQube = requiredString(options.coordinatorQube, 'coordinatorQube');
  const expectedServiceUser = requiredString(options.expectedServiceUser, 'expectedServiceUser');
  const expectedServiceUid = requiredUid(options.expectedServiceUid, 'expectedServiceUid');
  const expectedServiceTarget = requiredString(options.expectedServiceTarget, 'expectedServiceTarget');

  const deploymentManifest = buildReadonlyQrexecDeploymentManifestFromArtifact(options.deploymentArtifact, {
    expectedService: intendedService,
    expectedSourceQube: sourceQube,
    expectedCoordinatorQube: coordinatorQube,
    expectedServiceUser,
    expectedServiceUid,
    expectedGitSha: gitSha,
    expectedServiceTarget
  });

  return runIdentityBoundReadonlyQrexecPhase1Qualification({
    ...options,
    gitSha,
    intendedService,
    sourceQube,
    coordinatorQube,
    expectedServiceUser,
    expectedServiceUid,
    deploymentManifest
  });
}

/**
 * Split-domain real deployment boundary. dom0 policy evidence and coordinator service
 * evidence MUST be collected independently in their own trust domains and supplied here.
 * A single process cannot truthfully collect both in real Qubes. Collector injection is
 * therefore test-only and requires an explicit opt-in so production cannot accidentally
 * collapse the dom0/coordinator trust boundary.
 */
export async function runCollectedArtifactBoundReadonlyQrexecPhase1Qualification(options = {}) {
  const gitSha = requiredString(options.gitSha, 'gitSha').toLowerCase();
  const intendedService = requiredString(options.intendedService, 'intendedService');
  const sourceQube = requiredString(options.sourceQube, 'sourceQube');
  const coordinatorQube = requiredString(options.coordinatorQube, 'coordinatorQube');
  const expectedServiceUser = requiredString(options.expectedServiceUser, 'expectedServiceUser');
  const expectedServiceUid = requiredUid(options.expectedServiceUid, 'expectedServiceUid');

  const hasInjectedCollectors =
    typeof options.collectDom0PolicyEvidence === 'function' ||
    typeof options.collectCoordinatorServiceEvidence === 'function';

  let policyEvidence = options.policyEvidence;
  let coordinatorEvidence = options.coordinatorEvidence;

  if (hasInjectedCollectors) {
    if (options.allowTestCrossDomainCollectors !== true) {
      throw new Error('cross-domain collector injection is test-only; collect dom0 and coordinator evidence separately');
    }
    if (typeof options.collectDom0PolicyEvidence !== 'function' || typeof options.collectCoordinatorServiceEvidence !== 'function') {
      throw new Error('both test collectors are required when cross-domain collector injection is enabled');
    }
    policyEvidence = await options.collectDom0PolicyEvidence({ policyPath: options.policyPath });
    coordinatorEvidence = await options.collectCoordinatorServiceEvidence({
      service: intendedService,
      serviceUser: expectedServiceUser,
      serviceUid: expectedServiceUid,
      expectedGitSha: gitSha,
      serviceHandlerPath: options.serviceHandlerPath,
      deploymentMarkerPath: options.deploymentMarkerPath,
      getEuid: options.getEuid,
      getEgid: options.getEgid
    });
  }

  if (!policyEvidence || !coordinatorEvidence) {
    throw new Error('split-domain policyEvidence and coordinatorEvidence are required');
  }

  const deploymentArtifact = assembleReadonlyQrexecDeploymentArtifact({
    service: intendedService,
    sourceQube,
    coordinatorQube,
    serviceUser: expectedServiceUser,
    serviceUid: expectedServiceUid,
    gitSha,
    policyEvidence,
    coordinatorEvidence
  });

  return runArtifactBoundReadonlyQrexecPhase1Qualification({
    ...options,
    gitSha,
    intendedService,
    sourceQube,
    coordinatorQube,
    expectedServiceUser,
    expectedServiceUid,
    deploymentArtifact
  });
}
