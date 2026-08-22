import assert from 'node:assert/strict';
import test from 'node:test';
import { collectQubesResourceCalibration } from './qubes-resource-calibration.mjs';
import { buildQubesCalibrationRuntime, calibrationCliConfigFromEnv, parseResourceProbeResponse, probeWorkerViaQrexec, runQubesResourceCalibration, validateCalibrationTopology } from './qubes-resource-calibration-harness.mjs';

const SHA = 'a'.repeat(40);
const topology = {
  id: 'two-worker-balanced',
  workers: [
    { id: 'coord-code-qa', qube: 'dig-worker-a', capabilities: ['orchestrator', 'planner', 'coder', 'qa'] },
    { id: 'system', qube: 'dig-worker-b', capabilities: ['system'] }
  ]
};
const missions = [
  { id: 'm-orchestrator', dependsOn: [], metadata: { agentId: 'orchestrator' }, requiredCapabilities: ['orchestrator'] },
  { id: 'm-planner', dependsOn: ['m-orchestrator'], metadata: { agentId: 'planner' }, requiredCapabilities: ['planner'] },
  { id: 'm-coder', dependsOn: ['m-planner'], metadata: { agentId: 'coder' }, requiredCapabilities: ['coder'] },
  { id: 'm-system', dependsOn: ['m-planner'], metadata: { agentId: 'system' }, requiredCapabilities: ['system'] },
  { id: 'm-qa', dependsOn: ['m-coder', 'm-system'], metadata: { agentId: 'qa' }, requiredCapabilities: ['qa'] }
];
const durationsMs = { orchestrator: 20, planner: 30, coder: 80, system: 120, qa: 40 };

test('emits workload-bound collector-compatible calibration evidence', async () => {
  const sleeps = [];
  const lifecycle = [];
  const events = await runQubesResourceCalibration({
    gitSha: SHA,
    topology,
    runId: 'cal-run-1',
    workloadId: 'synthetic-dag-v1',
    sampleCount: 3,
    intervalMs: 250,
    sleep: async ms => sleeps.push(ms),
    startWorkload: async context => lifecycle.push(['start', context.workloadId]),
    stopWorkload: async context => lifecycle.push(['stop', context.workloadId]),
    sampleWorker: async (worker, round) => worker.id === 'system'
      ? { ramMb: 700 + round * 10, cpuPercent: 20 + round, vcpus: 1 }
      : { ramMb: 1200 + round * 10, cpuPercent: 40 + round, vcpus: 2 }
  });
  assert.equal(events[0].type, 'calibration_start');
  assert.equal(events.at(-1).type, 'calibration_end');
  assert.deepEqual(lifecycle, [['start', 'synthetic-dag-v1'], ['stop', 'synthetic-dag-v1']]);
  assert.equal(events.filter(event => event.type === 'worker_resource_sample').length, 6);
  assert.deepEqual(sleeps, [250, 250]);
  const report = collectQubesResourceCalibration(events, { expectedGitSha: SHA, expectedTopologyId: topology.id, expectedWorkloadId: 'synthetic-dag-v1', requireWorkloadEvidence: true, minSamplesPerWorker: 3 });
  assert.equal(report.workloadBound, true);
  assert.equal(report.workloadId, 'synthetic-dag-v1');
  assert.equal(report.workers.length, 2);
  assert.equal(report.workers.find(worker => worker.id === 'system').sampleCount, 3);
});

test('stops workload when resource sampling fails', async () => {
  const lifecycle = [];
  await assert.rejects(() => runQubesResourceCalibration({
    gitSha: SHA,
    topology,
    runId: 'cal-run-fail',
    workloadId: 'synthetic-dag-v1',
    sampleCount: 1,
    intervalMs: 0,
    startWorkload: async () => lifecycle.push('start'),
    stopWorkload: async () => lifecycle.push('stop'),
    sampleWorker: async worker => {
      if (worker.id === 'system') throw new Error('probe failed');
      return { ramMb: 1, cpuPercent: 1, vcpus: 1 };
    }
  }), /probe failed/);
  assert.deepEqual(lifecycle, ['start', 'stop']);
});

test('collector rejects samples outside the active workload lifecycle', () => {
  const events = [
    { type: 'calibration_start', runId: 'r', gitSha: SHA, topologyId: topology.id, workloadId: 'synthetic-dag-v1' },
    { type: 'worker_resource_sample', runId: 'r', workerId: 'system', capabilities: ['system'], ramMb: 1, cpuPercent: 1, vcpus: 1 },
    { type: 'calibration_end', runId: 'r' }
  ];
  assert.throws(() => collectQubesResourceCalibration(events, { expectedGitSha: SHA, expectedTopologyId: topology.id, expectedWorkloadId: 'synthetic-dag-v1', requireWorkloadEvidence: true, minSamplesPerWorker: 1 }), /outside active workload/);
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

test('real calibration runtime binds the benchmark DAG to workload control and resource probes', async () => {
  const workloadCalls = [];
  const probeCalls = [];
  const runtime = buildQubesCalibrationRuntime({
    topology,
    missions,
    durationsMs,
    workloadId: 'synthetic-dag-v1',
    resourceService: 'dig.ResourceProbe',
    workloadService: 'dig.SyntheticWorkload',
    probeTimeoutMs: 1200,
    workloadTimeoutMs: 1400,
    reconciliationDelayMs: 0,
    sendWorkloadCommand: async (worker, command, options) => {
      workloadCalls.push({ workerId: worker.workerId, command, options });
      return command.action === 'status' ? { ok: true, status: 'stopped' } : { ok: true, status: command.action === 'start' ? 'running' : 'stopped' };
    },
    probeWorker: async (worker, options) => {
      probeCalls.push({ workerId: worker.id, options });
      return { ramMb: worker.id === 'system' ? 700 : 900, cpuPercent: 25, vcpus: worker.id === 'system' ? 1 : 2 };
    }
  });

  assert.equal(runtime.plan.durationMs, 210);
  assert.equal(runtime.plan.metrics.constrainedLatencyMs, 210);
  const events = await runQubesResourceCalibration({
    gitSha: SHA,
    topology: runtime.topology,
    runId: 'real-cli-shape',
    workloadId: runtime.plan.workloadId,
    sampleCount: 1,
    intervalMs: 0,
    sampleWorker: runtime.sampleWorker,
    startWorkload: runtime.startWorkload,
    stopWorkload: runtime.stopWorkload
  });

  assert.deepEqual(workloadCalls.filter(call => call.command.action === 'start').map(call => call.workerId), ['coord-code-qa', 'system']);
  assert.deepEqual(workloadCalls.filter(call => call.command.action === 'stop').map(call => call.workerId), ['coord-code-qa', 'system']);
  assert.deepEqual(probeCalls.map(call => call.workerId), ['coord-code-qa', 'system']);
  assert.ok(workloadCalls.every(call => call.options.service === 'dig.SyntheticWorkload'));
  assert.ok(probeCalls.every(call => call.options.service === 'dig.ResourceProbe'));
  assert.equal(events.some(event => event.type === 'calibration_workload_started'), true);
  assert.equal(events.some(event => event.type === 'calibration_workload_stopped'), true);
});

test('CLI configuration fails closed instead of silently performing idle-only calibration', () => {
  const env = {
    DIG_GIT_SHA: SHA,
    DIG_QREXEC_RESOURCE_SERVICE: 'dig.ResourceProbe',
    DIG_QREXEC_WORKLOAD_SERVICE: 'dig.SyntheticWorkload',
    DIG_CALIBRATION_TOPOLOGY_JSON: JSON.stringify(topology),
    DIG_CALIBRATION_MISSIONS_JSON: JSON.stringify(missions),
    DIG_CALIBRATION_DURATIONS_JSON: JSON.stringify(durationsMs),
    DIG_CALIBRATION_RUN_ID: 'cli-run',
    DIG_CALIBRATION_WORKLOAD_ID: 'synthetic-dag-v1'
  };
  const config = calibrationCliConfigFromEnv(env);
  assert.equal(config.workloadService, 'dig.SyntheticWorkload');
  assert.equal(config.missions.length, 5);
  assert.equal(config.durationsMs.system, 120);
  assert.throws(() => calibrationCliConfigFromEnv({ ...env, DIG_QREXEC_WORKLOAD_SERVICE: '' }), /DIG_QREXEC_WORKLOAD_SERVICE/);
  assert.throws(() => calibrationCliConfigFromEnv({ ...env, DIG_CALIBRATION_MISSIONS_JSON: '' }), /DIG_CALIBRATION_MISSIONS_JSON/);
  assert.throws(() => calibrationCliConfigFromEnv({ ...env, DIG_CALIBRATION_DURATIONS_JSON: '' }), /DIG_CALIBRATION_DURATIONS_JSON/);
});

test('fails closed on malformed topology, service names, probes, workload hooks, and unsafe limits', async () => {
  assert.throws(() => validateCalibrationTopology({ id: 'x', workers: [{ id: 'same', capabilities: ['coder'] }, { id: 'same', capabilities: ['qa'] }] }), /duplicate worker id/);
  assert.throws(() => parseResourceProbeResponse('{"ramMb":1,"cpuPercent":101,"vcpus":1}'), /cpuPercent is invalid/);
  await assert.rejects(() => probeWorkerViaQrexec({ id: 'x', qube: 'bad qube' }, { service: 'dig.ResourceProbe', execFileFn: async () => ({ stdout: '{}' }) }), /resource probe/);
  await assert.rejects(() => runQubesResourceCalibration({ gitSha: SHA, topology, sampleCount: 101, sampleWorker: async () => ({}) }), /sampleCount/);
  await assert.rejects(() => runQubesResourceCalibration({ gitSha: SHA, topology, sampleCount: 1, sampleWorker: async () => ({ ramMb: 1, cpuPercent: 1, vcpus: 1 }), startWorkload: async () => {} }), /configured together/);
  assert.throws(() => buildQubesCalibrationRuntime({ topology, missions, durationsMs, resourceService: 'dig.ResourceProbe', workloadService: '' }), /qrexec workload service/);
});
