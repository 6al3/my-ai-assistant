function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required`);
  return value.trim();
}

function requiredUid(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive non-root uid`);
  return value;
}

/**
 * Build deployment evidence binding the Phase-1 qrexec service to the same dedicated
 * non-root uid used by filesystem qualification. This is metadata only: it does not
 * weaken policy or mutate MissionQueue state.
 */
export function buildReadonlyServiceIdentityContract({
  service,
  coordinatorQube,
  serviceUser,
  serviceUid,
  configuredServiceUid,
  gitSha
} = {}) {
  const expectedUid = requiredUid(serviceUid, 'serviceUid');
  const configuredUid = requiredUid(configuredServiceUid, 'configuredServiceUid');
  if (expectedUid !== configuredUid) {
    throw new Error(`qrexec service uid mismatch: expected ${expectedUid}, configured ${configuredUid}`);
  }
  return Object.freeze({
    schemaVersion: 1,
    service: requiredString(service, 'service'),
    coordinatorQube: requiredString(coordinatorQube, 'coordinatorQube'),
    serviceUser: requiredString(serviceUser, 'serviceUser'),
    expectedServiceUid: expectedUid,
    configuredServiceUid: configuredUid,
    gitSha: requiredString(gitSha, 'gitSha').toLowerCase(),
    nonRootVerified: true,
    deploymentIdentityBound: true
  });
}

export function verifyReadonlyServiceIdentityContract(contract, {
  expectedService,
  expectedCoordinatorQube,
  expectedServiceUser,
  expectedServiceUid,
  expectedGitSha
} = {}) {
  if (!contract || contract.schemaVersion !== 1 || contract.deploymentIdentityBound !== true) {
    throw new Error('invalid read-only qrexec service identity contract');
  }
  if (contract.nonRootVerified !== true) throw new Error('read-only qrexec service non-root identity was not verified');
  if (contract.service !== requiredString(expectedService, 'expectedService')) throw new Error('service identity mismatch');
  if (contract.coordinatorQube !== requiredString(expectedCoordinatorQube, 'expectedCoordinatorQube')) throw new Error('coordinator identity mismatch');
  if (contract.serviceUser !== requiredString(expectedServiceUser, 'expectedServiceUser')) throw new Error('service user identity mismatch');
  if (contract.expectedServiceUid !== requiredUid(expectedServiceUid, 'expectedServiceUid')) throw new Error('service uid mismatch');
  if (contract.configuredServiceUid !== contract.expectedServiceUid) throw new Error('configured service uid mismatch');
  if (contract.gitSha !== requiredString(expectedGitSha, 'expectedGitSha').toLowerCase()) throw new Error('service deployment git sha mismatch');
  return true;
}
