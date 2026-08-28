function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required`);
  return value.trim();
}

function requiredUid(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive non-root uid`);
  return value;
}

export function verifyReadonlyQrexecDeploymentManifest(manifest, {
  expectedService,
  expectedCoordinatorQube,
  expectedServiceUser,
  expectedServiceUid,
  expectedGitSha
} = {}) {
  if (!manifest || manifest.schemaVersion !== 1 || manifest.readOnly !== true) {
    throw new Error('invalid read-only qrexec deployment manifest');
  }
  if (manifest.service !== requiredString(expectedService, 'expectedService')) throw new Error('deployment manifest service mismatch');
  if (manifest.coordinatorQube !== requiredString(expectedCoordinatorQube, 'expectedCoordinatorQube')) throw new Error('deployment manifest coordinator mismatch');
  if (manifest.serviceUser !== requiredString(expectedServiceUser, 'expectedServiceUser')) throw new Error('deployment manifest service user mismatch');
  if (manifest.serviceUid !== requiredUid(expectedServiceUid, 'expectedServiceUid')) throw new Error('deployment manifest service uid mismatch');
  if (manifest.gitSha !== requiredString(expectedGitSha, 'expectedGitSha').toLowerCase()) throw new Error('deployment manifest git sha mismatch');
  if (manifest.allowStateChangingOperations !== false) throw new Error('deployment manifest must deny state-changing operations');
  return true;
}
