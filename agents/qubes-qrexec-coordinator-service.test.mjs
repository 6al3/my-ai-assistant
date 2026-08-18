import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { signWorkerEnvelope } from './worker-transport-envelope.mjs';
import { loadQrexecCoordinatorConfig } from './qubes-qrexec-coordinator-service.mjs';

const SECRET = 'dig-qrexec-synthetic-secret-000000000000';
const SERVICE = new URL('./qubes-qrexec-coordinator-service.mjs', import.meta.url);

function invokeService({ storePath, journalPath, envelope, extraEnv = {} }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVICE.pathname], {
      env: {
        ...process.env,
        DIG_ORCHESTRATION_STORE: storePath,
        DIG_REQUEST_JOURNAL: journalPath,
        DIG_TRANSPORT_SECRET: SECRET,
        ...extraEnv
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      const lines = stdout.trim().split('\n').filter(Boolean);
      resolve({ code, stderr, responses: lines.map(line => JSON.parse(line)) });
    });

    child.stdin.end(`${JSON.stringify(envelope)}\n`);
  });
}

function signed(op, body, requestId = randomUUID()) {
  return signWorkerEnvelope({ requestId, op, body, secret: SECRET });
}

test('qrexec service is fail-closed when durable/auth config is incomplete', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dig-qrexec-config-'));
  try {
    const child = spawn(process.execPath, [SERVICE.pathname], {
      env: { ...process.env, DIG_ORCHESTRATION_STORE: path.join(dir, 'queue.json') },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    child.stdin.end('{}\n');
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });
    const code = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    assert.equal(code, 1);
    assert.match(stderr, /DIG_REQUEST_JOURNAL is required/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('fault-only crash-after-commit mode is explicit and fail-closed', () => {
  const base = {
    DIG_ORCHESTRATION_STORE: '/tmp/dig-store.json',
    DIG_REQUEST_JOURNAL: '/tmp/dig-journal.json',
    DIG_TRANSPORT_SECRET: SECRET
  };
  assert.equal(loadQrexecCoordinatorConfig(base).crashAfterAnyAuthenticatedCommit, false);
  assert.equal(loadQrexecCoordinatorConfig({ ...base, DIG_CRASH_AFTER_COMMIT: '1' }).crashAfterAnyAuthenticatedCommit, true);
  assert.throws(() => loadQrexecCoordinatorConfig({ ...base, DIG_CRASH_AFTER_COMMIT: 'yes' }), /must be 0 or 1/);
});

test('qrexec-style one-process-per-call retries return committed response without duplicate mutation', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dig-qrexec-contract-'));
  const storePath = path.join(dir, 'queue.json');
  const journalPath = path.join(dir, 'journal.json');
  try {
    const submitRequestId = randomUUID();
    const submit = signed('submit', { text: 'Coder: synthetic qrexec contract task', options: { idempotencyKey: 'qrexec-contract-task' } }, submitRequestId);

    const first = await invokeService({ storePath, journalPath, envelope: submit });
    assert.equal(first.code, 0);
    assert.equal(first.responses.length, 1);
    assert.equal(first.responses[0].ok, true);
    const coderMission = first.responses[0].result?.missions?.find?.(mission =>
      mission.metadata?.agentId === 'coder' || mission.requiredCapabilities?.includes?.('coder')
    );
    assert.ok(coderMission?.id, 'submit should return the durable coder mission produced by the runtime contract');

    const retry = await invokeService({ storePath, journalPath, envelope: submit });
    assert.equal(retry.code, 0);
    assert.deepEqual(retry.responses, first.responses);

    const stats = await invokeService({ storePath, journalPath, envelope: signed('stats', null) });
    assert.equal(stats.code, 0);
    assert.equal(stats.responses[0].ok, true);
    assert.equal(stats.responses[0].result.total >= 1, true);

    const tampered = { ...submit, body: { text: 'Coder: changed command', options: { idempotencyKey: 'qrexec-contract-task' } } };
    const rejected = await invokeService({ storePath, journalPath, envelope: tampered });
    assert.equal(rejected.code, 0);
    assert.equal(rejected.responses[0].ok, false);
    assert.match(rejected.responses[0].error, /authentication failed|different command/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('fault-only service crashes after a run-scoped commit and normal service reconciles the same request', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dig-qrexec-fault-any-'));
  const storePath = path.join(dir, 'queue.json');
  const journalPath = path.join(dir, 'journal.json');
  try {
    const runId = `run-${randomUUID()}`;
    const requestId = `recovery-submit-${runId}`;
    const envelope = signed('submit', {
      text: 'Coder: synthetic run-scoped committed-response-loss task',
      options: { idempotencyKey: `recovery-${runId}` }
    }, requestId);

    const fault = await invokeService({
      storePath,
      journalPath,
      envelope,
      extraEnv: { DIG_CRASH_AFTER_COMMIT: '1' }
    });
    assert.equal(fault.code, 86);
    assert.equal(fault.responses.length, 0);

    const recovered = await invokeService({ storePath, journalPath, envelope });
    assert.equal(recovered.code, 0);
    assert.equal(recovered.responses.length, 1);
    assert.equal(recovered.responses[0].ok, true);

    const retry = await invokeService({ storePath, journalPath, envelope });
    assert.equal(retry.code, 0);
    assert.deepEqual(retry.responses, recovered.responses);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('qrexec process-per-call preserves live claim fencing through complete', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dig-qrexec-lease-'));
  const storePath = path.join(dir, 'queue.json');
  const journalPath = path.join(dir, 'journal.json');
  try {
    const submit = await invokeService({
      storePath,
      journalPath,
      envelope: signed('submit', { text: 'Build code for a synthetic durable lease task', options: { idempotencyKey: 'qrexec-lease-task' } })
    });
    assert.equal(submit.responses[0].ok, true);

    for (const agentId of ['orchestrator', 'planner', 'coder']) {
      const claim = await invokeService({
        storePath,
        journalPath,
        envelope: signed('claim', { worker: { id: `${agentId}-worker`, capabilities: [agentId] } })
      });
      assert.equal(claim.code, 0);
      assert.equal(claim.responses[0].ok, true);
      const mission = claim.responses[0].result;
      assert.ok(mission?.id, `${agentId} should claim a mission`);
      assert.equal(typeof mission.leaseToken, 'string');
      assert.ok(mission.leaseToken.length >= 16);

      const complete = await invokeService({
        storePath,
        journalPath,
        envelope: signed('complete', {
          id: mission.id,
          workerId: `${agentId}-worker`,
          leaseToken: mission.leaseToken,
          result: { synthetic: true, agentId }
        })
      });
      assert.equal(complete.code, 0);
      assert.equal(complete.responses[0].ok, true, complete.responses[0].error);
      assert.equal(complete.responses[0].result.status, 'completed');
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
