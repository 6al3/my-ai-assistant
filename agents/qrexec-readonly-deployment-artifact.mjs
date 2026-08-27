function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required`);
  return value.trim();
}

function requiredUid(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive non-root uid`);
  return value;
}

function policyRulesForService(policyText, service) {
  return policyText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .filter((line) => line.split(/\s+/)[0] === service);
}

/**
 * Verify evidence captured from the actual Qubes deployment artifacts before it is
 * allowed to become the Phase-1 deployment manifest. The policy is intentionally
 * narrow: only the empty service argument from one source Qube to one coordinator
 * Qube may be allowed, under the dedicated non-root service user; every other call
 * to this service must be denied by the same policy artifact.
 */
export function verifyReadonlyQrexecDeploymentArtifact(artifact, {
  expectedService,
  expectedSourceQube,
  expectedCoordinatorQube,
  expectedServiceUser,
  expectedServiceUid,
  expectedGitSha,
  expectedServiceTarget
} = {}) {
  if (!artifact || artifact.schemaVersion !== 1) throw new Error('invalid read-only qrexec deployment artifact');

  const service = requiredString(expectedService, 'expectedService');
  const sourceQube = requiredString(expectedSourceQube, 'expectedSourceQube');
  const coordinatorQube = requiredString(expectedCoordinatorQube, 'expectedCoordinatorQube');
  const serviceUser = requiredString(expectedServiceUser, 'expectedServiceUser');
  const serviceUid = requiredUid(expectedServiceUid, 'expectedServiceUid');
  const gitSha = requiredString(expectedGitSha, 'expectedGitSha').toLowerCase();
  const serviceTarget = requiredString(expectedServiceTarget, 'expectedServiceTarget');

  if (artifact.service !== service) throw new Error('deployment artifact service mismatch');
  if (artifact.sourceQube !== sourceQube) throw new Error('deployment artifact source mismatch');
  if (artifact.coordinatorQube !== coordinatorQube) throw new Error('deployment artifact coordinator mismatch');
  if (artifact.serviceUser !== serviceUser) throw new Error('deployment artifact service user mismatch');
  if (artifact.serviceUid !== serviceUid) throw new Error('deployment artifact service uid mismatch');
  if (artifact.gitSha !== gitSha) throw new Error('deployment artifact git sha mismatch');

  const policy = artifact.policy;
  if (!policy || typeof policy.text !== 'string') throw new Error('deployment artifact policy is required');
  const policyPath = requiredString(policy.path, 'policy.path');
  if (!policyPath.startsWith('/etc/qubes/policy.d/') || !policyPath.endsWith('.policy')) {
    throw new Error('deployment artifact policy path must be a persistent Qubes policy file');
  }

  const rules = policyRulesForService(policy.text, service);
  const requiredAllow = `${service} + ${sourceQube} ${coordinatorQube} allow user=${serviceUser}`;
  const requiredDeny = `${service} * * * deny`;
  if (rules.length !== 2 || rules[0] !== requiredAllow || rules[1] !== requiredDeny) {
    throw new Error('deployment artifact policy must contain exact allow-then-deny rules');
  }

  const handler = artifact.serviceHandler;
  if (!handler) throw new Error('deployment artifact service handler is required');
  const handlerPath = requiredString(handler.path, 'serviceHandler.path');
  const allowedHandlerPaths = [`/etc/qubes-rpc/${service}`, `/usr/local/etc/qubes-rpc/${service}`];
  if (!allowedHandlerPaths.includes(handlerPath)) throw new Error('deployment artifact service handler path mismatch');
  if (requiredString(handler.target, 'serviceHandler.target') !== serviceTarget) throw new Error('deployment artifact service target mismatch');
  if (handler.executable !== true) throw new Error('deployment artifact service handler must be executable');
  if (handler.writableByServiceUser !== false) throw new Error('deployment artifact service handler must not be writable by service user');
  if (handler.targetGitSha !== gitSha) throw new Error('deployment artifact service target git sha mismatch');

  return true;
}

export function buildReadonlyQrexecDeploymentManifestFromArtifact(artifact, expected = {}) {
  verifyReadonlyQrexecDeploymentArtifact(artifact, expected);
  return {
    schemaVersion: 1,
    service: artifact.service,
    coordinatorQube: artifact.coordinatorQube,
    serviceUser: artifact.serviceUser,
    serviceUid: artifact.serviceUid,
    gitSha: artifact.gitSha,
    readOnly: true,
    allowStateChangingOperations: false
  };
}
