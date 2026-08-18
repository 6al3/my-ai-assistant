import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildQualificationRunPlan, runQualificationCampaignSet } from './qubes-qrexec-qualification-runner.mjs';

const REQUIRED_ENV = {
  DIG_QREXEC_TARGET: 'coordinator',
  DIG_QREXEC_SOURCE: 'worker',
  DIG_QREXEC_SERVICE: 'dig.Coordinator',
  DIG_GIT_SHA: 'a'.repeat(40),
  DIG_TRANSPORT_SECRET: 'qualification-test-secret-000000000000'
};

test('qualification plan uses one lease/QA run plus at least three independent recovery runs', () => {
  const plan = buildQualificationRunPlan({ qualificationRunId: 'qual-1', recoveryRuns: 3 });
  assert.equal(plan.length, 4);
  assert.deepEqual(plan.map(item => item.kind), ['lease-qa', 'recovery', 'recovery', 'recovery']);
  assert.equal(new Set(plan.map(item => item.runId)).size, 4);
  assert.ok(plan.every(item => item.runId.startsWith('qual-1-')));
  assert.throws(() => buildQualificationRunPlan({ qualificationRunId: 'qual-2', recoveryRuns: 2 }), /between 3 and 10/);
  assert.throws(() => buildQualificationRunPlan({ qualificationRunId: 'bad id', recoveryRuns: 3 }), /qualificationRunId/);
});

test('qualification runner executes every planned campaign with a distinct run-scoped id', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dig-qualification-runner-'));
  const fakeHarness = path.join(dir, 'fake-harness.mjs');
  try {
    await writeFile(fakeHarness, `
      let input = ''; for await (const chunk of process.stdin) input += chunk;
      JSON.parse(input);
      const runId = process.env.DIG_CAMPAIGN_RUN_ID;
      const base = { runId, transport: 'qrexec', sourceQube: 'worker', targetQube: 'coordinator', service: 'dig.Coordinator', gitSha: '${'a'.repeat(40)}' };
      console.log(JSON.stringify({ type: 'campaign_start', ...base, startedAt: '2026-08-18T10:00:00.000Z' }));
      console.log(JSON.stringify({ type: 'campaign_end', runId, finishedAt: '2026-08-18T10:00:01.000Z' }));
    `);
    const campaigns = await runQualificationCampaignSet({ qualificationRunId: 'qual-live', recoveryRuns: 3, harnessPath: fakeHarness, env: { ...process.env, ...REQUIRED_ENV } });
    assert.equal(campaigns.length, 4);
    const runIds = campaigns.map(jsonl => JSON.parse(jsonl.split('\n')[0]).runId);
    assert.deepEqual(runIds, ['qual-live-lease', 'qual-live-recovery-1', 'qual-live-recovery-2', 'qual-live-recovery-3']);
    assert.equal(new Set(runIds).size, 4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
