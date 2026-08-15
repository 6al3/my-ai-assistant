import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { TransactionalMissionStore } from './transactional-mission-store.mjs';
import { DurableWorkerRegistry } from './durable-worker-registry.mjs';
import { WorkerAuthenticator } from './worker-protocol.mjs';
import { TransactionalWorkerRuntime } from './transactional-runtime.mjs';
import { QubesStdioCoordinatorTransport } from './qubes-stdio-transport.mjs';

function absolute(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
  return path.resolve(value);
}

function readJson(filePath, label) {
  const value = JSON.parse(fs.readFileSync(absolute(filePath, label), 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must contain a JSON object`);
  return value;
}

export function readWorkerSecret({ directory, workerId } = {}) {
  const dir = absolute(directory, 'secret directory');
  const id = String(workerId);
  if (!/^[A-Za-z0-9_.-]{1,63}$/.test(id)) throw new Error(`invalid worker id: ${id}`);
  const secretPath = path.join(dir, `${id}.key`);
  const stat = fs.statSync(secretPath);
  if (!stat.isFile()) throw new Error(`worker secret is not a file: ${id}`);
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new Error(`worker secret permissions are too broad: ${id}`);
  const secret = fs.readFileSync(secretPath, 'utf8').trim();
  if (secret.length < 32) throw new Error(`worker secret is too short: ${id}`);
  return secret;
}

export function loadWorkerSecrets({ directory, workerIds } = {}) {
  if (!Array.isArray(workerIds) || workerIds.length === 0) throw new Error('workerIds must be a non-empty array');
  return Object.fromEntries(workerIds.map(workerId => [String(workerId), readWorkerSecret({ directory, workerId })]));
}

export async function buildQrexecCoordinator({
  stateFile,
  registryFile,
  workerManifestFile,
  secretDirectory,
  leaseMs = 30_000,
  workerTtlMs = 30_000,
  now = () => Date.now()
} = {}) {
  const manifest = readJson(workerManifestFile, 'worker manifest');
  if (!Array.isArray(manifest.workers) || manifest.workers.length === 0) throw new Error('worker manifest requires workers');
  const ids = manifest.workers.map(worker => String(worker.id));
  if (new Set(ids).size !== ids.length) throw new Error('worker manifest contains duplicate ids');
  const allowedIds = new Set(ids);
  for (const id of ids) readWorkerSecret({ directory: secretDirectory, workerId: id });
  const registry = new DurableWorkerRegistry({ filePath: absolute(registryFile, 'registryFile'), ttlMs: workerTtlMs, now });
  for (const worker of manifest.workers) {
    await registry.register({
      id: String(worker.id),
      capabilities: Array.isArray(worker.capabilities) ? worker.capabilities.map(String) : [],
      maxConcurrent: worker.maxConcurrent ?? 1,
      metadata: worker.metadata ?? {}
    });
  }
  const store = new TransactionalMissionStore({ filePath: absolute(stateFile, 'stateFile') });
  const secretResolver = workerId => {
    if (!allowedIds.has(String(workerId))) throw new Error(`worker secret unavailable or too short: ${workerId}`);
    return readWorkerSecret({ directory: secretDirectory, workerId });
  };
  const authenticator = new WorkerAuthenticator({ secrets: secretResolver, replayStore: registry, now });
  const runtime = new TransactionalWorkerRuntime({ store, authenticator, registry, leaseMs, now });
  const transport = new QubesStdioCoordinatorTransport({ coordinator: runtime });
  return { transport, runtime, store, registry, workerIds: ids };
}

export async function serveQrexecCoordinator(options = {}, io = {}) {
  const { transport, workerIds } = await buildQrexecCoordinator(options);
  const result = await transport.serve({ input: io.input ?? process.stdin, output: io.output ?? process.stdout });
  return { ...result, workerCount: workerIds.length };
}

async function main() {
  const required = ['DIG_STATE_FILE', 'DIG_WORKER_REGISTRY_FILE', 'DIG_WORKER_MANIFEST_FILE', 'DIG_WORKER_SECRET_DIR'];
  for (const name of required) if (!process.env[name]) throw new Error(`${name} is required`);
  await serveQrexecCoordinator({
    stateFile: process.env.DIG_STATE_FILE,
    registryFile: process.env.DIG_WORKER_REGISTRY_FILE,
    workerManifestFile: process.env.DIG_WORKER_MANIFEST_FILE,
    secretDirectory: process.env.DIG_WORKER_SECRET_DIR
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    process.stderr.write(`DIG coordinator startup failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
