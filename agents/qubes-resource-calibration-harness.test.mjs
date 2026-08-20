import assert from 'node:assert/strict';
import test from 'node:test';
import { collectQubesResourceCalibration } from './qubes-resource-calibration.mjs';
import { parseResourceProbeResponse, probeWorkerViaQrexec, runQubesResourceCalibration, validateCalibrationTopology } from './qubes-resource-calibration-harness.mjs';

const SHA = 'a'.repeat(40);
const topology = {
  id: 'two-worker-balanced',
  workers: [
    { id: 'coord-code-qa', qube: 'dig-worker-a', capabilities: ['orchestrator', 'planner', 'coder', 'qa'] },
    { id: 'system', qube: 'dig-worker-b', capabilities: ['system'] }
  ]
};

test('emits collector-compatible calibration evidence from real worker identities', async () => {
  const sleeps = [];
  const events = await runQubesResourceCalibration({
    gitSha: SHA,
    topology,
    runId: 'cal-run-1',
    sampleCount: 3,
    intervalMs: 250,
    sleep: async ms => sleeps.push(ms),
    sampleWorker: async (worker, round) => worker.id === 'system'
      ? { ramMb: 700 + round * 10, cpuPercent: 20 + round, vcpus: 1 }
      : { ramMb: 1200 + round * 10, cpuPercent: 40 + round, vcpus: 2 }
  });
  assert.equal(events[0].type, 'calibration_start');
  assert.equal(events.at(-1).type, 'calibration_end');
  assert.equal(events.filter(event => event.type === 'worker_resource_sample').length, 6);
  assert.deepEqual(sleeps, [250, 250]);
  const report = collectQubesResourceCalibration(events, { expectedGitSha: SHA, expectedTopologyId: topology.id, minSamplesPerWorker: 3 });
  assert.equal(report.workers.length, 2);
  assert.equal(report.workers.find(worker => worker.id === 'system').sampleCount, 3);
});

test('samples each round concurrently and preserves deterministic worker output order', async () => {
  const completion = [];
  const events = await runQubesResourceCalibration({
    gitSha: SHA,
    topology,
    runId: 'cal-run-order',
    sampleCount: 1,
    intervalMs: 0,
    sampleWorker: async worker => {
      if (worker.id === 'coord-code-qa') await new Promise(resolve => setTimeout(resolve, 5));
      completion.push(worker.id);
      return { ramMb: 1, cpuPercent: 1, vcpus: 1 };
    }
  });
  assert.deepEqual(completion, ['system', 'coord-code-qa']);
  assert.deepEqual(events.filter(event => event.type === 'worker_resource_sample').map(event => event.workerId), ['coord-code-qa', 'system']);
});

test('qrexec probe is read-only, bounded, and validates response schema', async () => {
  const calls = [];
  const sample = await probeWorkerViaQrexec({ id: 'system', qube: 'dig-worker-b' }, {
    service: 'dig.ResourceProbe',
    timeoutMs: 1500,
    execFileFn: async (command, args, options) => {
      calls.push({ command, args, options });
      return { stdout: '{"ramMb":700,"cpuPercent":35.5,"vcpus":1}\n', stderr: '' };
    }
  });
  assert.deepEqual(sample, { ramMb: 700, cpuPercent: 35.5, vcpus: 1 });
  assert.deepEqual(calls[0].args, ['dig-worker-b', 'dig.ResourceProbe']);
  assert.equal(calls[0].options.timeout, 1500);
});

test('fails closed on malformed topology, service names, probes, and unsafe limits', async () => {
  assert.throws(() => validateCalibrationTopology({ id: 'x', workers: [{ id: 'same', capabilities: ['coder'] }, { id: 'same', capabilities: ['qa'] }] }), /duplicate worker id/);
  assert.throws(() => parseResourceProbeResponse('{"ramMb":1,"cpuPercent":101,"vcpus":1}'), /cpuPercent is invalid/);
  await assert.rejects(() => probeWorkerViaQrexec({ id: 'x', qube: 'bad qube' }, { service: 'dig.ResourceProbe', execFileFn: async () => ({ stdout: '{}' }) }), /resource probe/);
  await assert.rejects(() => runQubesResourceCalibration({ gitSha: SHA, topology, sampleCount: 101, sampleWorker: async () => ({}) }), /sampleCount/);
});
