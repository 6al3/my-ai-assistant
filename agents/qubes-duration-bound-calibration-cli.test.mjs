import assert from 'node:assert/strict';
import test from 'node:test';
import { durationBoundCliConfigFromEnv, runDurationBoundCalibrationCli } from './qubes-duration-bound-calibration-cli.mjs';

const SHA = 'a'.repeat(40);
const topology = { id: 'two-worker-balanced', workers: [
  { id: 'coord-code-qa', qube: 'dig-worker-a', capabilities: ['orchestrator', 'planner', 'coder', 'qa'] },
  { id: 'system', qube: 'dig-worker-b', capabilities: ['system'] }
] };
const missions = [
  { id: 'm-orchestrator', dependsOn: [], metadata: { agentId: 'orchestrator' }, requiredCapabilities: ['orchestrator'] },
  { id: 'm-planner', dependsOn: ['m-orchestrator'], metadata: { agentId: 'planner' }, requiredCapabilities: ['planner'] },
  { id: 'm-coder', dependsOn: ['m-planner'], metadata: { agentId: 'coder' }, requiredCapabilities: ['coder'] },
  { id: 'm-system', dependsOn: ['m-planner'], metadata: { agentId: 'system' }, requiredCapabilities: ['system'] },
  { id: 'm-qa', dependsOn: ['m-coder', 'm-system'], metadata: { agentId: 'qa' }, requiredCapabilities: ['qa'] }
];
const durationsMs = { orchestrator: 20, planner: 30, coder: 80, system: 120, qa: 40 };

function env(extra = {}) {
  return {
    DIG_GIT_SHA: SHA,
    DIG_QREXEC_RESOURCE_SERVICE: 'dig.ResourceProbe',
    DIG_QREXEC_WORKLOAD_SERVICE: 'dig.SyntheticWorkload',
    DIG_CALIBRATION_TOPOLOGY_JSON: JSON.stringify(topology),
    DIG_CALIBRATION_MISSIONS_JSON: JSON.stringify(missions),
    DIG_CALIBRATION_DURATIONS_JSON: JSON.stringify(durationsMs),
    DIG_CALIBRATION_RUN_ID: 'cli-duration-run',
    DIG_CALIBRATION_WORKLOAD_ID: 'synthetic-dag-v1',
    DIG_CALIBRATION_SAMPLE_COUNT: '5',
    ...extra
  };
}

test('CLI omits a fixed interval so the duration policy becomes authoritative', () => {
  const config = durationBoundCliConfigFromEnv(env());
  assert.equal(config.requestedIntervalMs, null);
});

test('CLI preserves an explicit interval for fail-closed duration validation', () => {
  const config = durationBoundCliConfigFromEnv(env({ DIG_CALIBRATION_INTERVAL_MS: '1000' }));
  assert.equal(config.requestedIntervalMs, 1000);
});

test('real CLI authority derives 52ms for the canonical 210ms/5-sample DAG and emits observed timing', async () => {
  let current = 1000;
  const config = durationBoundCliConfigFromEnv(env());
  const { events, policy, runtime } = await runDurationBoundCalibrationCli(config, {
    buildRuntime: cfg => ({
      topology: cfg.topology,
      plan: { durationMs: 210, workloadId: cfg.workloadId },
      startWorkload: async () => {},
      stopWorkload: async () => {},
      sampleWorker: async worker => ({ ramMb: worker.id === 'system' ? 700 : 1200, cpuPercent: 40, vcpus: worker.id === 'system' ? 1 : 2 })
    }),
    sleep: async ms => { current += ms; },
    now: () => current
  });
  assert.equal(runtime.plan.durationMs, 210);
  assert.equal(policy.intervalMs, 52);
  assert.equal(policy.lastSampleOffsetMs, 208);
  const samples = events.filter(event => event.type === 'worker_resource_sample');
  assert.equal(samples.length, 10);
  assert.ok(samples.every(event => Number.isInteger(event.sampleOffsetMs) && event.workloadDurationMs === 210));
  assert.equal(Math.max(...samples.map(event => event.sampleOffsetMs)), 208);
});

test('real CLI authority rejects an explicit 1000ms interval for a 210ms workload', async () => {
  const config = durationBoundCliConfigFromEnv(env({ DIG_CALIBRATION_INTERVAL_MS: '1000' }));
  await assert.rejects(() => runDurationBoundCalibrationCli(config, {
    buildRuntime: cfg => ({ topology: cfg.topology, plan: { durationMs: 210, workloadId: cfg.workloadId }, sampleWorker: async () => ({ ramMb: 1, cpuPercent: 1, vcpus: 1 }) })
  }), /sampling window exceeds active workload/);
});
