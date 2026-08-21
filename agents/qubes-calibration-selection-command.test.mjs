import assert from 'node:assert/strict';
import test from 'node:test';
import { runQubesCalibrationSelectionCommand } from './qubes-calibration-selection-command.mjs';

const SHA = 'a'.repeat(40);
const missions = [{ id: 'm1', requiredCapabilities: ['coder'], dependencies: [] }];
const candidates = [
  { id: 'fast', workers: [{ id: 'w1', capabilities: ['coder'] }] },
  { id: 'stable', workers: [{ id: 'w2', capabilities: ['coder'] }] }
];

function report(topologyId, latency) {
  return { topologyId, gitSha: SHA, workers: [{ id: topologyId === 'fast' ? 'w1' : 'w2', capabilities: ['coder'], resources: { ramMb: 512, vcpus: 1, cpuP95Percent: 40, probeLatencyP95Ms: latency }, sampleCount: 5 }] };
}

test('runs duration-bound calibration for every candidate before selecting winner', async () => {
  const seen = [];
  const result = await runQubesCalibrationSelectionCommand({
    gitSha: SHA,
    missions,
    durationsMs: { coder: 10 },
    candidates,
    calibrationConfigs: candidates.map(candidate => ({ topologyId: candidate.id, gitSha: SHA })),
    resourceBudget: { maxRamMb: 2048, maxVcpus: 4, maxQubes: 2, maxProbeLatencyP95Ms: 10 }
  }, {
    runCalibration: async config => { seen.push(config.topologyId); return { report: report(config.topologyId, config.topologyId === 'fast' ? 18 : 4) }; },
    evaluate: (_missions, _durations, _candidates, calibrations) => ({ winner: { id: calibrations.find(item => item.workers[0].resources.probeLatencyP95Ms <= 10).topologyId }, results: [] })
  });
  assert.deepEqual(seen, ['fast', 'stable']);
  assert.equal(result.winner.id, 'stable');
});

test('fails closed on calibration provenance mismatch or no winner', async () => {
  const base = { gitSha: SHA, missions, durationsMs: { coder: 10 }, candidates: [candidates[0]], calibrationConfigs: [{ topologyId: 'fast', gitSha: SHA }] };
  await assert.rejects(() => runQubesCalibrationSelectionCommand(base, {
    runCalibration: async () => ({ report: report('other', 4) }),
    evaluate: () => ({ winner: { id: 'fast' } })
  }), /mismatched report provenance/);
  await assert.rejects(() => runQubesCalibrationSelectionCommand(base, {
    runCalibration: async () => ({ report: report('fast', 4) }),
    evaluate: () => ({ winner: null, results: [] })
  }), /no calibrated Qubes topology/);
});
