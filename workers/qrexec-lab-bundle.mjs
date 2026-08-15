import { randomBytes } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const SAFE_NAME = /^[A-Za-z0-9_.-]{1,63}$/;
const SAFE_SERVICE = /^[A-Za-z0-9_.-]{1,128}$/;

function requireName(value, label) {
  if (typeof value !== 'string' || !SAFE_NAME.test(value)) throw new Error(`${label} must match ${SAFE_NAME}`);
  return value;
}

function requireService(value) {
  if (typeof value !== 'string' || !SAFE_SERVICE.test(value)) throw new Error(`service must match ${SAFE_SERVICE}`);
  return value;
}

function requireAbsoluteFile(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\n') || value.includes('\r')) throw new Error(`${label} must be an absolute single-line path`);
  return value;
}

export function renderQrexecPolicy({ service = 'dig.Coordinator', sourceQube, targetQube } = {}) {
  requireService(service);
  requireName(sourceQube, 'sourceQube');
  requireName(targetQube, 'targetQube');
  if (sourceQube === targetQube) throw new Error('sourceQube and targetQube must differ');
  return `${service} * ${sourceQube} ${targetQube} allow\n${service} * * * deny\n`;
}

export function renderQrexecService({ nodePath = '/usr/bin/node', entryPath } = {}) {
  requireAbsoluteFile(nodePath, 'nodePath');
  requireAbsoluteFile(entryPath, 'entryPath');
  return `#!/bin/sh\nset -eu\nexec ${shellQuote(nodePath)} ${shellQuote(entryPath)}\n`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export function buildQrexecLabBundle({
  service = 'dig.Coordinator',
  sourceQube,
  targetQube,
  entryPath,
  nodePath = '/usr/bin/node',
  policyFile = '/etc/qubes/policy.d/30-dig-coordinator.policy',
  serviceFile = '/etc/qubes-rpc/dig.Coordinator'
} = {}) {
  requireAbsoluteFile(policyFile, 'policyFile');
  requireAbsoluteFile(serviceFile, 'serviceFile');
  return {
    policyFile,
    serviceFile,
    policy: renderQrexecPolicy({ service, sourceQube, targetQube }),
    serviceScript: renderQrexecService({ nodePath, entryPath }),
    installModes: { policy: 0o644, service: 0o755 },
    safety: {
      networkListenerRequired: false,
      defaultDenyFallback: true,
      secretEmbedded: false,
      sourcePinned: sourceQube,
      targetPinned: targetQube
    }
  };
}

export async function provisionWorkerSecret({ directory, workerId, bytes = 32 } = {}) {
  requireAbsoluteFile(directory, 'directory');
  requireName(workerId, 'workerId');
  if (!Number.isSafeInteger(bytes) || bytes < 32 || bytes > 64) throw new Error('bytes must be an integer from 32 to 64');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const secretPath = path.join(directory, `${workerId}.key`);
  const secret = randomBytes(bytes).toString('base64url');
  await writeFile(secretPath, `${secret}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await chmod(secretPath, 0o600);
  return { secretPath, bytes, workerId };
}
