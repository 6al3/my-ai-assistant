import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MAX_DURATION_MS = 120_000;
const MAX_SCHEDULE_ENTRIES = 64;
const LOOP_SLICE_MS = 5;

function safeName(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  const normalized = value.trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(normalized)) throw new Error(`${label} contains unsupported characters`);
  return normalized;
}

function boundedInteger(value, label, { min = 0, max = MAX_DURATION_MS } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label} must be an integer between ${min} and ${max}`);
  return value;
}

export function normalizeSyntheticWorkloadCommand(command) {
  if (!command || typeof command !== 'object' || Array.isArray(command)) throw new Error('workload command must be an object');
  const action = command.action;
  if (!['start', 'stop', 'status'].includes(action)) throw new Error('workload action must be start, stop, or status');
  const runId = safeName(command.runId, 'runId');
  const workloadId = safeName(command.workloadId, 'workloadId');
  if (action === 'stop' || action === 'status') return { action, runId, workloadId };

  const durationMs = boundedInteger(command.durationMs, 'durationMs', { min: 1 });
  if (!Array.isArray(command.schedule) || command.schedule.length > MAX_SCHEDULE_ENTRIES) throw new Error(`schedule must contain at most ${MAX_SCHEDULE_ENTRIES} entries`);
  const seen = new Set();
  const schedule = command.schedule.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new Error(`schedule[${index}] must be an object`);
    const missionId = safeName(entry.missionId, `schedule[${index}].missionId`);
    if (seen.has(missionId)) throw new Error(`duplicate missionId in schedule: ${missionId}`);
    seen.add(missionId);
    const startMs = boundedInteger(entry.startMs, `schedule[${index}].startMs`);
    const missionDurationMs = boundedInteger(entry.durationMs, `schedule[${index}].durationMs`, { min: 1 });
    if (startMs + missionDurationMs > durationMs) throw new Error(`schedule entry exceeds workload duration: ${missionId}`);
    return { missionId, startMs, durationMs: missionDurationMs };
  }).sort((a, b) => a.startMs - b.startMs || a.missionId.localeCompare(b.missionId));

  return { action, runId, workloadId, durationMs, schedule };
}

function stateKey(command) { return `${command.runId}--${command.workloadId}.json`; }

export function createFileWorkloadStore(root) {
  const stateRoot = root?.trim();
  if (!stateRoot) throw new Error('synthetic workload state directory is required');
  const pathFor = command => join(stateRoot, stateKey(command));
  return {
    async get(command) {
      try { return JSON.parse(await readFile(pathFor(command), 'utf8')); }
      catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
    },
    async put(command, state) {
      const path = pathFor(command);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temp = `${path}.${process.pid}.tmp`;
      await writeFile(temp, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temp, path);
      return path;
    },
    pathFor
  };
}

function defaultSpawnExecutor(statePath) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--execute', statePath], { detached: true, stdio: 'ignore', env: { PATH: process.env.PATH ?? '' } });
  child.unref();
  return child.pid;
}

export async function handleSyntheticWorkloadCommand(commandInput, { store, spawnExecutor = defaultSpawnExecutor, now = () => Date.now() } = {}) {
  if (!store || typeof store.get !== 'function' || typeof store.put !== 'function') throw new Error('workload store is required');
  const command = normalizeSyntheticWorkloadCommand(commandInput);
  const existing = await store.get(command);

  if (command.action === 'status') {
    const status = existing?.status ?? 'not-running';
    if (!['starting', 'running', 'stopped', 'completed', 'not-running'].includes(status)) throw new Error(`unsupported workload state: ${status}`);
    return { ok: true, action: 'status', runId: command.runId, workloadId: command.workloadId, status, startedAt: existing?.startedAt ?? null, stoppedAt: existing?.stoppedAt ?? null, completedAt: existing?.completedAt ?? null };
  }
  if (command.action === 'stop') {
    if (!existing) return { ok: true, action: 'stop', runId: command.runId, workloadId: command.workloadId, status: 'not-running' };
    await store.put(command, { ...existing, status: 'stopped', stoppedAt: existing.stoppedAt ?? now() });
    return { ok: true, action: 'stop', runId: command.runId, workloadId: command.workloadId, status: 'stopped' };
  }

  if (existing?.status === 'running' || existing?.status === 'starting') throw new Error('workload already running for runId/workloadId');
  const state = { version: 1, ...command, status: 'starting', pid: null, startedAt: now(), completedAt: null, stoppedAt: null };
  const statePath = await store.put(command, state);
  const pid = spawnExecutor(statePath);
  if (!Number.isInteger(pid) || pid <= 1) throw new Error('failed to start synthetic workload executor');
  await store.put(command, { ...state, status: 'running', pid });
  return { ok: true, action: 'start', runId: command.runId, workloadId: command.workloadId, status: 'running', durationMs: command.durationMs };
}

function busySlice(ms) {
  const until = performance.now() + ms;
  let value = 0.5;
  while (performance.now() < until) value = Math.sin(value + 1.23456789) ** 2 + Math.sqrt(value + 1);
  return value;
}

async function executeState(statePath) {
  const initial = JSON.parse(await readFile(statePath, 'utf8'));
  const command = normalizeSyntheticWorkloadCommand(initial);
  if (command.action !== 'start') throw new Error('executor state must contain a start command');
  const started = performance.now();
  let cancelled = false;
  while (true) {
    const elapsed = performance.now() - started;
    if (elapsed >= command.durationMs) break;
    const latest = JSON.parse(await readFile(statePath, 'utf8'));
    if (latest.status === 'stopped') { cancelled = true; break; }
    if (!['starting', 'running'].includes(latest.status)) break;
    const active = command.schedule.some(item => elapsed >= item.startMs && elapsed < item.startMs + item.durationMs);
    if (active) busySlice(Math.min(LOOP_SLICE_MS, command.durationMs - elapsed));
    else await new Promise(resolve => setTimeout(resolve, Math.min(10, Math.max(1, command.durationMs - elapsed))));
    await new Promise(resolve => setImmediate(resolve));
  }
  const latest = JSON.parse(await readFile(statePath, 'utf8'));
  if (latest.status === 'running' || latest.status === 'starting') {
    const finalState = { ...latest, status: cancelled ? 'stopped' : 'completed', completedAt: cancelled ? null : Date.now(), stoppedAt: cancelled ? (latest.stoppedAt ?? Date.now()) : latest.stoppedAt };
    const temp = `${statePath}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(finalState)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temp, statePath);
  }
}

async function readSingleJsonLine() {
  let input = '';
  for await (const chunk of process.stdin) { input += chunk.toString('utf8'); if (Buffer.byteLength(input) > 64 * 1024) throw new Error('workload request exceeds 64KiB'); }
  const lines = input.split(/\r?\n/).filter(line => line.trim());
  if (lines.length !== 1) throw new Error('exactly one JSON workload request is required');
  return JSON.parse(lines[0]);
}

async function main() {
  if (process.argv[2] === '--execute') { const statePath = process.argv[3]; if (!statePath) throw new Error('executor state path is required'); await executeState(statePath); return; }
  const stateDir = process.env.DIG_SYNTHETIC_WORKLOAD_STATE_DIR?.trim();
  if (!stateDir) throw new Error('DIG_SYNTHETIC_WORKLOAD_STATE_DIR is required');
  const response = await handleSyntheticWorkloadCommand(await readSingleJsonLine(), { store: createFileWorkloadStore(stateDir) });
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { process.stderr.write(`DIG synthetic workload service failed: ${error.message}\n`); process.exitCode = 1; });
