import { constants as fsConstants } from 'node:fs';
import { access, lstat, readFile, readlink, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

const MAX_POLICY_BYTES = 64 * 1024;
const MAX_MARKER_BYTES = 16 * 1024;

function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required`);
  return value.trim();
}

function requiredUid(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive non-root uid`);
  return value;
}

async function readBoundedRegularFile(path, maxBytes, label) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  if (before.size > maxBytes) throw new Error(`${label} exceeds byte limit`);
  const content = await readFile(path, 'utf8');
  const after = await lstat(path);
  if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
    throw new Error(`${label} changed while being collected`);
  }
  return content;
}

async function writable(path) {
  try {
    await access(path, fsConstants.W_OK);
    return true;
  } catch (error) {
    if (error?.code === 'EACCES' || error?.code === 'EPERM' || error?.code === 'EROFS') return false;
    throw error;
  }
}

/**
 * Run in dom0. Captures only the persistent policy file needed for the read-only
 * qualification artifact. It intentionally does not execute qrexec or inspect VM state.
 */
export async function collectDom0ReadonlyPolicyEvidence({ policyPath } = {}) {
  const path = requiredString(policyPath, 'policyPath');
  if (!path.startsWith('/etc/qubes/policy.d/') || !path.endsWith('.policy')) {
    throw new Error('policyPath must reference a persistent Qubes policy file');
  }
  const text = await readBoundedRegularFile(path, MAX_POLICY_BYTES, 'policy');
  return { path, text };
}

/**
 * Run inside the coordinator Qube under the dedicated read-only qrexec service UID.
 * The handler is required to be an immutable symlink to the intended service target;
 * an immutable deployment marker binds that target to the exact Git SHA.
 */
export async function collectCoordinatorReadonlyServiceEvidence({
  service,
  serviceUser,
  serviceUid,
  expectedGitSha,
  serviceHandlerPath,
  deploymentMarkerPath,
  getEuid = () => process.geteuid?.(),
  getEgid = () => process.getegid?.()
} = {}) {
  const expectedService = requiredString(service, 'service');
  const expectedUser = requiredString(serviceUser, 'serviceUser');
  const expectedUid = requiredUid(serviceUid, 'serviceUid');
  const expectedSha = requiredString(expectedGitSha, 'expectedGitSha').toLowerCase();
  const handlerPath = requiredString(serviceHandlerPath, 'serviceHandlerPath');
  const markerPath = requiredString(deploymentMarkerPath, 'deploymentMarkerPath');

  const euid = getEuid();
  const egid = getEgid();
  if (!Number.isSafeInteger(euid) || euid <= 0) throw new Error('collector must run as a non-root service identity');
  if (euid !== expectedUid) throw new Error('collector effective uid does not match service uid');

  const allowedHandlerPaths = [`/etc/qubes-rpc/${expectedService}`, `/usr/local/etc/qubes-rpc/${expectedService}`];
  if (!allowedHandlerPaths.includes(handlerPath)) throw new Error('service handler path mismatch');

  const handlerInfo = await lstat(handlerPath);
  if (!handlerInfo.isSymbolicLink()) throw new Error('service handler must be an immutable symlink');
  const target = await readlink(handlerPath);
  const resolvedTarget = target.startsWith('/') ? target : `${dirname(handlerPath)}/${target}`;
  const targetInfo = await stat(resolvedTarget);
  if (!targetInfo.isFile()) throw new Error('service target must be a regular file');

  const markerText = await readBoundedRegularFile(markerPath, MAX_MARKER_BYTES, 'deployment marker');
  let marker;
  try {
    marker = JSON.parse(markerText);
  } catch {
    throw new Error('deployment marker must be valid JSON');
  }
  if (marker?.schemaVersion !== 1) throw new Error('invalid deployment marker schema');
  if (requiredString(marker.service, 'deployment marker service') !== expectedService) throw new Error('deployment marker service mismatch');
  if (requiredString(marker.serviceTarget, 'deployment marker serviceTarget') !== resolvedTarget) throw new Error('deployment marker target mismatch');
  if (requiredString(marker.gitSha, 'deployment marker gitSha').toLowerCase() !== expectedSha) throw new Error('deployment marker git sha mismatch');

  if (await writable(handlerPath)) throw new Error('service handler is writable by service identity');
  if (await writable(resolvedTarget)) throw new Error('service target is writable by service identity');
  if (await writable(markerPath)) throw new Error('deployment marker is writable by service identity');
  if (await writable(dirname(handlerPath))) throw new Error('service handler directory is writable by service identity');
  if (await writable(dirname(resolvedTarget))) throw new Error('service target directory is writable by service identity');

  return {
    serviceUser: expectedUser,
    serviceUid: expectedUid,
    effectiveUid: euid,
    effectiveGid: Number.isSafeInteger(egid) ? egid : null,
    serviceHandler: {
      path: handlerPath,
      target: resolvedTarget,
      executable: (targetInfo.mode & 0o111) !== 0,
      writableByServiceUser: false,
      targetGitSha: expectedSha
    }
  };
}

export function assembleReadonlyQrexecDeploymentArtifact({
  service,
  sourceQube,
  coordinatorQube,
  serviceUser,
  serviceUid,
  gitSha,
  policyEvidence,
  coordinatorEvidence
} = {}) {
  const artifact = {
    schemaVersion: 1,
    service: requiredString(service, 'service'),
    sourceQube: requiredString(sourceQube, 'sourceQube'),
    coordinatorQube: requiredString(coordinatorQube, 'coordinatorQube'),
    serviceUser: requiredString(serviceUser, 'serviceUser'),
    serviceUid: requiredUid(serviceUid, 'serviceUid'),
    gitSha: requiredString(gitSha, 'gitSha').toLowerCase(),
    policy: policyEvidence,
    serviceHandler: coordinatorEvidence?.serviceHandler
  };

  if (!policyEvidence || typeof policyEvidence.path !== 'string' || typeof policyEvidence.text !== 'string') {
    throw new Error('policyEvidence is required');
  }
  if (!coordinatorEvidence || coordinatorEvidence.serviceUid !== artifact.serviceUid || coordinatorEvidence.serviceUser !== artifact.serviceUser) {
    throw new Error('coordinator evidence identity mismatch');
  }
  if (coordinatorEvidence.effectiveUid !== artifact.serviceUid) throw new Error('coordinator evidence effective uid mismatch');
  return artifact;
}
