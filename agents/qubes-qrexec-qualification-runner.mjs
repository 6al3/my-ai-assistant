import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { evaluateAttestedMultiRunQualification, parseAttestedMultiRunJson } from './qubes-attested-multi-run-qualification.mjs';
import { runQualificationPreflightFromEnv, validateQualificationPreflightEnvironment } from './qubes-qrexec-qualification-preflight.mjs';

const HARNESS = new URL('./qubes-qrexec-campaign-harness.mjs', import.meta.url);
const LEASE_CAMPAIGN = new URL('./qubes-qrexec-lease-fencing-campaign.json', import.meta.url);
const RECOVERY_CAMPAIGN = new URL('./qubes-qrexec-recovery-campaign.json', import.meta.url);

function assertRunId(value, name = 'qualificationRunId') {
  if (typeof value !== 'string' || value.length === 0 || value.length > 96 || !/^[A-Za-z0-9._-]+$/.test(value)) throw new Error(`${name} must be 1-96 characters using letters, digits, dot, underscore, or hyphen`);
  return value;
}

export function buildQualificationRunPlan({ qualificationRunId = randomUUID(), recoveryRuns = 3 } = {}) {
  const prefix = assertRunId(qualificationRunId);
  if (!Number.isInteger(recoveryRuns) || recoveryRuns < 3 || recoveryRuns > 10) throw new Error('recoveryRuns must be an integer between 3 and 10');
  return [{ kind: 'lease-qa', runId: `${prefix}-lease`, manifestUrl: LEASE_CAMPAIGN }, ...Array.from({ length: recoveryRuns }, (_, index) => ({ kind: 'recovery', runId: `${prefix}-recovery-${index + 1}`, manifestUrl: RECOVERY_CAMPAIGN }))];
}

function replaceDeploymentTokens(value, { normalService, faultService }) {
  if (Array.isArray(value)) return value.map(item => replaceDeploymentTokens(item, { normalService, faultService }));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceDeploymentTokens(item, { normalService, faultService })]));
  if (value === '{{NORMAL_SERVICE}}') return normalService;
  if (value === '{{FAULT_SERVICE}}') return faultService;
  return value;
}

export function materializeQualificationManifest(manifest, { env = process.env } = {}) {
  const config = validateQualificationPreflightEnvironment(env);
  let parsed;
  try { parsed = JSON.parse(manifest); } catch (error) { throw new Error(`qualification campaign manifest must be valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  return JSON.stringify(replaceDeploymentTokens(parsed, { normalService: config.service, faultService: config.faultService }));
}

function runHarness({ manifest, runId, harnessPath = fileURLToPath(HARNESS), env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [harnessPath], { env: { ...env, DIG_CAMPAIGN_RUN_ID: runId }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => { if (code !== 0) return reject(new Error(`campaign ${runId} failed: ${stderr.trim() || `exit ${code}`}`)); resolve(stdout.trim()); });
    child.stdin.end(manifest);
  });
}

export async function runQualificationCampaignSet({ qualificationRunId = randomUUID(), recoveryRuns = 3, harnessPath, env = process.env } = {}) {
  const plan = buildQualificationRunPlan({ qualificationRunId, recoveryRuns }), campaigns = [];
  for (const item of plan) {
    const manifestTemplate = await readFile(item.manifestUrl, 'utf8');
    const manifest = materializeQualificationManifest(manifestTemplate, { env });
    const jsonl = await runHarness({ manifest, runId: item.runId, harnessPath, env });
    if (!jsonl) throw new Error(`campaign ${item.runId} produced no evidence`);
    campaigns.push(jsonl);
  }
  return campaigns;
}

export function evaluateQualificationCampaignSet(campaigns, { env = process.env, nowMs = Date.now(), preflightVerifiedAttestations = [] } = {}) {
  const expectedGitSha = env.DIG_GIT_SHA;
  const expectedSourceQube = env.DIG_SOURCE_QUBE || env.DIG_QREXEC_SOURCE;
  const expectedTargetQube = env.DIG_TARGET_QUBE || env.DIG_QREXEC_TARGET;
  const expectedService = env.DIG_QREXEC_SERVICE;
  const expectedFaultService = env.DIG_QREXEC_FAULT_SERVICE;
  const expectedAttestationKeyId = env.DIG_RESPONSE_ATTESTATION_KEY_ID;
  for (const [name, value] of Object.entries({ expectedGitSha, expectedSourceQube, expectedTargetQube, expectedService, expectedFaultService, expectedAttestationKeyId })) {
    if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required for qualification`);
  }
  if (expectedService === expectedFaultService) throw new Error('expectedService and expectedFaultService must differ');
  const parsed = parseAttestedMultiRunJson(JSON.stringify(campaigns));
  return evaluateAttestedMultiRunQualification(parsed, { expectedGitSha, expectedSourceQube, expectedTargetQube, expectedService, expectedFaultService, expectedAttestationKeyId, preflightVerifiedAttestations, nowMs });
}

async function main() {
  const qualificationRunId = process.env.DIG_QUALIFICATION_RUN_ID || randomUUID();
  const recoveryRuns = process.env.DIG_RECOVERY_RUNS ? Number(process.env.DIG_RECOVERY_RUNS) : 3;
  const preflight = await runQualificationPreflightFromEnv();
  const campaigns = await runQualificationCampaignSet({ qualificationRunId, recoveryRuns });
  const qualification = evaluateQualificationCampaignSet(campaigns, { preflightVerifiedAttestations: preflight.verifiedAttestations });
  process.stdout.write(`${JSON.stringify({ qualificationRunId, preflight, qualification, campaigns }, null, 2)}\n`);
  if (!qualification.ready) process.exitCode = 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch(error => { process.stderr.write(`DIG Qubes qualification runner failed: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
