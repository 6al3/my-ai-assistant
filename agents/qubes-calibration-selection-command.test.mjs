import assert from 'node:assert/strict';
import test from 'node:test';
import { digestCalibrationEvidenceSet, runQubesCalibrationSelectionCommand } from './qubes-calibration-selection-command.mjs';

const SHA = 'a'.repeat(40);
const missions = [{ id: 'm1', requiredCapabilities: ['coder'], dependencies: [] }];
const candidates = [
  { id: 'fast', workers: [{ id: 'w1', capabilities: ['coder'] }] },
  { id: 'stable', workers: [{ id: 'w2', capabilities: ['coder'] }] }
];

function report(topologyId, latency) {
  return { topologyId, gitSha: SHA, workers: [{ id: topologyId === 'fast' ? 'w1' : 'w2', capabilities: ['coder'], resources: { ramMb: 512, vcpus: 1, cpuP95Percent: 40, probeLatencyP95Ms: latency }, sampleCount: 5 }] };
}

test('runs duration-bound calibration sequentially and binds winner to exact evidence digest', async () => {
  const seen = [];
  let active = 0;
  let peak = 0;
  const reports = [report('fast', 18), report('stable', 4)];
  const result = await runQubesCalibrationSelectionCommand({
    gitSha: SHA,
    missions,
    durationsMs: { coder: 10 },
    candidates,
    calibrationConfigs: candidates.map(candidate => ({ topologyId: candidate.id, gitSha: SHA })),
    resourceBudget: { maxRamMb: 2048, maxVcpus: 4, maxQubes: 2, maxProbeLatencyP95Ms: 10 }
  }, {
    runCalibration: async config => {
      active += 1;
      peak = Math.max(peak, active);
      seen.push(config.topologyId);
      await Promise.resolve();
      active -= 1;
      return { report: reports.find(item => item.topologyId === config.topologyId) };
    },
    evaluate: (_missions, _durations, _candidates, calibrations) => ({ winner: { id: calibrations.find(item => item.workers[0].resources.probeLatencyP95Ms <= 10).topologyId }, results: [] })
  });
  assert.deepEqual(seen, ['fast', 'stable']);
  assert.equal(peak, 1, 'candidate calibrations must not overlap and contaminate measurements');
  assert.equal(result.schemaVersion, 2);
  assert.equal(result.winner.id, 'stable');
  assert.equal(result.calibrationEvidenceDigest, digestCalibrationEvidenceSet(reports));
});

test('calibration evidence digest is order-independent but changes when report evidence changes', () => {
  const fast = report('fast', 18);
  const stable = report('stable', 4);
  assert.equal(digestCalibrationEvidenceSet([fast, stable]), digestCalibrationEvidenceSet([stable, fast]));
  assert.notEqual(digestCalibrationEvidenceSet([fast, stable]), digestCalibrationEvidenceSet([fast, report('stable', 5)]));
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

test('validates complete candidate/config bijection before starting any Qubes calibration', async () => {
  let calls = 0;
  const runCalibration = async config => {
    calls += 1;
    return { report: report(config.topologyId, 4) };
  };
  const base = {
    gitSha: SHA,
    missions,
    durationsMs: { coder: 10 },
    candidates,
    calibrationConfigs: [
      { topologyId: 'fast', gitSha: SHA },
      { topologyId: 'fast', gitSha: SHA }
    ]
  };
  await assert.rejects(() => runQubesCalibrationSelectionCommand(base, { runCalibration }), /calibration topology ids must be unique/);
  assert.equal(calls, 0);
  await assert.rejects(() => runQubesCalibrationSelectionCommand({ ...base, calibrationConfigs: [{ topologyId: 'fast', gitSha: SHA }, { topologyId: 'unexpected', gitSha: SHA }] }, { runCalibration }), /unexpected calibration topology unexpected/);
  assert.equal(calls, 0);
  await assert.rejects(() => runQubesCalibrationSelectionCommand({ ...base, calibrationConfigs: [{ topologyId: 'fast', gitSha: SHA }, { topologyId: 'stable', gitSha: 'b'.repeat(40) }] }, { runCalibration }), /calibration stable git SHA mismatch/);
  assert.equal(calls, 0);
});
