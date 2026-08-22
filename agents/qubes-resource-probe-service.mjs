import os from 'node:os';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

function finite(value, label) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative finite number`);
  return value;
}

export function parseMemInfo(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('meminfo is required');
  const values = new Map();
  for (const line of text.split('\n')) {
    const match = line.match(/^([A-Za-z_()]+):\s+(\d+)\s+kB$/);
    if (match) values.set(match[1], Number(match[2]));
  }
  const totalKb = values.get('MemTotal');
  const availableKb = values.get('MemAvailable');
  if (!Number.isFinite(totalKb) || !Number.isFinite(availableKb) || availableKb > totalKb) throw new Error('invalid MemTotal/MemAvailable');
  return { totalMb: totalKb / 1024, availableMb: availableKb / 1024, usedMb: (totalKb - availableKb) / 1024 };
}

export function parseCpuStat(text) {
  if (typeof text !== 'string') throw new Error('cpu stat is required');
  const line = text.split('\n').find(row => row.startsWith('cpu '));
  if (!line) throw new Error('aggregate cpu line is required');
  const values = line.trim().split(/\s+/).slice(1).map(Number);
  if (values.length < 4 || values.some(value => !Number.isFinite(value) || value < 0)) throw new Error('invalid aggregate cpu counters');
  const accounted = values.slice(0, 8); // user..steal; guest fields are already included in user/nice.
  const total = accounted.reduce((sum, value) => sum + value, 0);
  const idle = accounted[3] + (accounted[4] ?? 0);
  return { total, idle };
}

export function cpuPercentBetween(before, after) {
  const totalDelta = after.total - before.total;
  const idleDelta = after.idle - before.idle;
  if (!Number.isFinite(totalDelta) || totalDelta <= 0 || idleDelta < 0 || idleDelta > totalDelta) throw new Error('invalid cpu counter delta');
  return Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100));
}

export async function sampleLocalQubeResources({
  readText = path => readFile(path, 'utf8'),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  cpuWindowMs = 100,
  cpuCount = () => os.cpus().length
} = {}) {
  if (!Number.isInteger(cpuWindowMs) || cpuWindowMs < 25 || cpuWindowMs > 2000) throw new Error('cpuWindowMs must be an integer between 25 and 2000');
  const mem = parseMemInfo(await readText('/proc/meminfo'));
  const before = parseCpuStat(await readText('/proc/stat'));
  await sleep(cpuWindowMs);
  const after = parseCpuStat(await readText('/proc/stat'));
  const vcpus = cpuCount();
  if (!Number.isInteger(vcpus) || vcpus <= 0) throw new Error('vCPU count must be a positive integer');
  return {
    ramMb: Math.ceil(finite(mem.usedMb, 'used RAM')),
    cpuPercent: Number(cpuPercentBetween(before, after).toFixed(2)),
    vcpus
  };
}

async function main() {
  const cpuWindowMs = process.env.DIG_RESOURCE_PROBE_CPU_WINDOW_MS ? Number(process.env.DIG_RESOURCE_PROBE_CPU_WINDOW_MS) : 100;
  const sample = await sampleLocalQubeResources({ cpuWindowMs });
  process.stdout.write(`${JSON.stringify(sample)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`DIG resource probe failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
