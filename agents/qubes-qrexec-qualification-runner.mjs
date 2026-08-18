import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { evaluateMultiRunQualification, parseMultiRunJson } from './qubes-multi-run-qualification.mjs';

const HARNESS = new URL('./qubes-qrexec-campaign-harness.mjs', import.meta.url);
const LEASE_CAMPAIGN = new URL('./qubes-qrexec-lease-fencing-campaign.json', import.meta.url);
const RECOVERY_CAMPAIGN = new URL('./qubes-qrexec-recovery-campaign.json', import.meta.url);

function assertRunId(value, name = 'qualificationRunId') {
  if (typeof value !== 'string' || value.length === 0 || value.length > 96 || !/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error(`${name} must be 1-96 characters using letters, digits, dot, underscore, or hyphen`);
  }
  return value;
}

export function buildQualificationRunPlan({ qualificationRunId = randomUUID(), recoveryRuns = 3 } = {}) {
  const prefix = assertRunId(qualificationRunId);
  if (!Number.isInteger(recoveryRuns) || recoveryRuns < 3 || recoveryRuns > 10) throw new Error('recoveryRuns must be an integer between 3 and 10');
  return [
    { kind: 'lease-qa', runId: `${prefix}-lease`, manifestUrl: LEASE_CAMPAIGN },
    ...Array.from({ length: recoveryRuns }, (_, index) => ({ kind: 'recovery', runId: `${prefix}-recovery-${index + 1}`, manifestUrl: RECOVERY_CAMPAIGN }))
  ];
}

function runHarness({ manifest, runId, harnessPath = fileURLToPath(HARNESS), env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [harnessPath], {
      env: { ...env, DIG_CAMPAIGN_RUN_ID: runId },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => {
      if (code !== 0) return reject(new Error(`campaign ${runId} failed: ${stderr.trim() || `exit ${code}`}`));
      resolve(stdout.trim());
    });
    child.stdin.end(manifest);
  });
}

export async function runQualificationCampaignSet({ qualificationRunId = randomUUID(), recoveryRuns = 3, harnessPath, env = process.env } = {}) {
  const plan = buildQualificationRunPlan({ qualificationRunId, recoveryRuns });
  const campaigns = [];
  for (const item of plan) {
    const manifest = await readFile(item.manifestUrl, 'utf8');
    const jsonl = await runHarness({ manifest, runId: item.runId, harnessPath, env });
    if (!jsonl) throw new Error(`campaign ${item.runId} produced no evidence`);
    campaigns.push(jsonl);
  }
  return campaigns;
}

export function evaluateQualificationCampaignSet(campaigns, { env = process.env, nowMs = Date.now() } = {}) {
  const expectedGitSha = env.DIG_GIT_SHA;
  const expectedSourceQube = env.DIG_SOURCE_QUBE || env.DIG_QREXEC_SOURCE;
  const expectedTargetQube = env.DIG_TARGET_QUBE || env.DIG_QREXEC_TARGET;
  const expectedService = env.DIG_QREXEC_SERVICE;
  for (const [name, value] of Object.entries({ expectedGitSha, expectedSourceQube, expectedTargetQube, expectedService })) {
    if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required for qualification`);
  }
  const parsed = parseMultiRunJson(JSON.stringify(campaigns));
  return evaluateMultiRunQualification(parsed, { expectedGitSha, expectedSourceQube, expectedTargetQube, expectedService, nowMs });
}

async function main() {
  const qualificationRunId = process.env.DIG_QUALIFICATION_RUN_ID || randomUUID();
  const recoveryRuns = process.env.DIG_RECOVERY_RUNS ? Number(process.env.DIG_RECOVERY_RUNS) : 3;
  const campaigns = await runQualificationCampaignSet({ qualificationRunId, recoveryRuns });
  const qualification = evaluateQualificationCampaignSet(campaigns);
  process.stdout.write(`${JSON.stringify({ qualificationRunId, qualification, campaigns }, null, 2)}\n`);
  if (!qualification.ready) process.exitCode = 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    process.stderr.write(`DIG Qubes qualification runner failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
