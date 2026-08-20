import assert from 'node:assert/strict';
import test from 'node:test';
import { cpuPercentBetween, parseCpuStat, parseMemInfo, sampleLocalQubeResources } from './qubes-resource-probe-service.mjs';

test('parses memory and CPU counters without double-counting guest time', () => {
  const mem = parseMemInfo('MemTotal:       2097152 kB\nMemAvailable:   1048576 kB\n');
  assert.equal(mem.usedMb, 1024);
  const cpu = parseCpuStat('cpu  100 20 30 400 10 5 5 10 50 25\n');
  assert.equal(cpu.total, 580);
  assert.equal(cpu.idle, 410);
});

test('calculates bounded CPU utilization from monotonic counters', () => {
  assert.equal(cpuPercentBetween({ total: 100, idle: 40 }, { total: 200, idle: 90 }), 50);
  assert.throws(() => cpuPercentBetween({ total: 100, idle: 40 }, { total: 100, idle: 40 }), /invalid cpu counter delta/);
});

test('samples local Qube resources with a bounded read-only CPU window', async () => {
  const reads = new Map([
    ['/proc/meminfo', ['MemTotal:       2097152 kB\nMemAvailable:   1048576 kB\n']],
    ['/proc/stat', ['cpu  100 0 0 100 0 0 0 0 0 0\n', 'cpu  150 0 0 150 0 0 0 0 0 0\n']]
  ]);
  const readText = async path => {
    const values = reads.get(path);
    if (!values?.length) throw new Error(`unexpected read ${path}`);
    return values.shift();
  };
  const sleeps = [];
  const sample = await sampleLocalQubeResources({ readText, sleep: async ms => sleeps.push(ms), cpuWindowMs: 100, cpuCount: () => 2 });
  assert.deepEqual(sample, { ramMb: 1024, cpuPercent: 50, vcpus: 2 });
  assert.deepEqual(sleeps, [100]);
});

test('fails closed on malformed /proc data and unsafe sample windows', async () => {
  assert.throws(() => parseMemInfo('MemTotal: 10 kB\nMemAvailable: 20 kB\n'), /invalid MemTotal\/MemAvailable/);
  assert.throws(() => parseCpuStat('intr 1 2 3\n'), /aggregate cpu line/);
  await assert.rejects(() => sampleLocalQubeResources({ cpuWindowMs: 5 }), /between 25 and 2000/);
});
