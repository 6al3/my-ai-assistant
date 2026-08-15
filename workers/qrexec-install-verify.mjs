import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

function requireBundle(bundle) {
  if (!bundle || typeof bundle !== 'object') throw new Error('bundle is required');
  for (const key of ['policyFile', 'serviceFile', 'policy', 'serviceScript']) {
    if (typeof bundle[key] !== 'string' || !bundle[key]) throw new Error(`bundle.${key} is required`);
  }
  if (!path.isAbsolute(bundle.policyFile) || !path.isAbsolute(bundle.serviceFile)) throw new Error('install targets must be absolute paths');
  return bundle;
}

function sha256(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

async function inspectTarget(filePath, expected, mode) {
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink()) return { path: filePath, ok: false, reason: 'symlink-target-refused' };
    if (!stat.isFile()) return { path: filePath, ok: false, reason: 'target-not-file' };
    const content = await fs.readFile(filePath, 'utf8');
    const actualMode = stat.mode & 0o777;
    return {
      path: filePath,
      ok: content === expected && (process.platform === 'win32' || actualMode === mode),
      contentMatches: content === expected,
      modeMatches: process.platform === 'win32' || actualMode === mode,
      expectedSha256: sha256(expected),
      actualSha256: sha256(content)
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return { path: filePath, ok: false, reason: 'missing', expectedSha256: sha256(expected) };
    throw error;
  }
}

async function atomicWrite(filePath, content, mode) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    const existing = await fs.lstat(filePath);
    if (existing.isSymbolicLink()) throw new Error(`refusing symlink install target: ${filePath}`);
    if (!existing.isFile()) throw new Error(`refusing non-file install target: ${filePath}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const temp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temp, content, { encoding: 'utf8', mode, flag: 'wx' });
    await fs.chmod(temp, mode);
    await fs.rename(temp, filePath);
    await fs.chmod(filePath, mode);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}

export async function verifyQrexecInstall(bundleInput) {
  const bundle = requireBundle(bundleInput);
  const policyMode = bundle.installModes?.policy ?? 0o644;
  const serviceMode = bundle.installModes?.service ?? 0o755;
  const policy = await inspectTarget(bundle.policyFile, bundle.policy, policyMode);
  const service = await inspectTarget(bundle.serviceFile, bundle.serviceScript, serviceMode);
  return { ok: policy.ok && service.ok, policy, service, secretMaterialReported: false };
}

export async function installQrexecBundle(bundleInput, { dryRun = true } = {}) {
  const bundle = requireBundle(bundleInput);
  const before = await verifyQrexecInstall(bundle);
  const plan = [
    { path: bundle.policyFile, mode: bundle.installModes?.policy ?? 0o644, sha256: sha256(bundle.policy), needsWrite: !before.policy.ok },
    { path: bundle.serviceFile, mode: bundle.installModes?.service ?? 0o755, sha256: sha256(bundle.serviceScript), needsWrite: !before.service.ok }
  ];
  if (dryRun) return { dryRun: true, changed: false, plan, before, secretMaterialReported: false };
  for (const operation of plan) {
    if (!operation.needsWrite) continue;
    const content = operation.path === bundle.policyFile ? bundle.policy : bundle.serviceScript;
    await atomicWrite(operation.path, content, operation.mode);
  }
  const after = await verifyQrexecInstall(bundle);
  if (!after.ok) throw new Error('qrexec install verification failed');
  return { dryRun: false, changed: plan.some(item => item.needsWrite), plan, before, after, secretMaterialReported: false };
}
