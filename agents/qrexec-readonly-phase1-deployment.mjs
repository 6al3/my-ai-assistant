import { runReadonlyQrexecPhase1Qualification } from './qrexec-readonly-phase1-runner.mjs';
import { verifyReadonlyServiceIdentityContract } from './qrexec-readonly-service-identity-contract.mjs';

function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required`);
  return value.trim();
}

function requiredUid(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive non-root uid`);
  return value;
}

/**
 * Deployment-facing Phase-1 entrypoint.
 *
 * The lower-level runner remains useful for isolated contract tests, but real Qubes
 * qualification must enter here so the declared qrexec service deployment identity
 * is verified before filesystem qualification or any qrexec invocation occurs.
 */
export async function runIdentityBoundReadonlyQrexecPhase1Qualification(options = {}) {
  const gitSha = requiredString(options.gitSha, 'gitSha').toLowerCase();
  const intendedService = requiredString(options.intendedService, 'intendedService');
  const coordinatorQube = requiredString(options.coordinatorQube, 'coordinatorQube');
  const expectedServiceUser = requiredString(options.expectedServiceUser, 'expectedServiceUser');
  const expectedServiceUid = requiredUid(options.expectedServiceUid, 'expectedServiceUid');

  verifyReadonlyServiceIdentityContract(options.serviceIdentityContract, {
    expectedService: intendedService,
    expectedCoordinatorQube: coordinatorQube,
    expectedServiceUser,
    expectedServiceUid,
    expectedGitSha: gitSha
  });

  return runReadonlyQrexecPhase1Qualification({
    ...options,
    gitSha,
    intendedService,
    coordinatorQube,
    expectedServiceUser,
    expectedServiceUid
  });
}
