import { runReadonlyQrexecPhase1Qualification } from './qrexec-readonly-phase1-runner.mjs';
import { verifyReadonlyServiceIdentityContract } from './qrexec-readonly-service-identity-contract.mjs';
import { verifyReadonlyQrexecDeploymentManifest } from './qrexec-readonly-deployment-manifest.mjs';
import { buildReadonlyQrexecDeploymentManifestFromArtifact } from './qrexec-readonly-deployment-artifact.mjs';

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
 * Real-Qubes boundary: derive the manifest from captured dom0 policy + coordinator
 * qrexec service evidence instead of trusting a hand-authored deployment manifest.
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
