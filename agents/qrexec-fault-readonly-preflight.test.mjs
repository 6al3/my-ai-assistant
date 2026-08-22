import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { signWorkerEnvelope } from './worker-transport-envelope.mjs';

const SECRET = 'dig-qrexec-synthetic-secret-000000000000';
const SERVICE = new URL('./qubes-qrexec-coordinator-service.mjs', import.meta.url);

function signed(op, body = null, requestId = randomUUID()) {
  return signWorkerEnvelope({ requestId, op, body, secret: SECRET });
}

function invokeFaultService({ storePath, journalPath, envelope }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVICE.pathname], {
      env: {
        ...process.env,
        DIG_ORCHESTRATION_STORE: storePath,
        DIG_REQUEST_JOURNAL: journalPath,
        DIG_TRANSPORT_SECRET: SECRET,
        DIG_CRASH_AFTER_COMMIT: '1'
      },
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
      const responses = stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      resolve({ code, stderr, responses });
    });
    child.stdin.end(`${JSON.stringify(envelope)}\n`);
  });
}

test('fault-only qrexec service answers authenticated stats without triggering the synthetic crash hook', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dig-qrexec-fault-readonly-'));
  const storePath = path.join(dir, 'queue.json');
  const journalPath = path.join(dir, 'journal.json');
  try {
    const stats = await invokeFaultService({ storePath, journalPath, envelope: signed('stats') });
    assert.equal(stats.code, 0, stats.stderr);
    assert.equal(stats.responses.length, 1);
    assert.equal(stats.responses[0].ok, true);
    assert.equal(typeof stats.responses[0].result, 'object');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('fault-only qrexec service still crashes after an authenticated mutating operation', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dig-qrexec-fault-mutation-'));
  const storePath = path.join(dir, 'queue.json');
  const journalPath = path.join(dir, 'journal.json');
  try {
    const submit = await invokeFaultService({
      storePath,
      journalPath,
      envelope: signed('submit', {
        text: 'Coder: synthetic fault-service mutation',
        options: { idempotencyKey: `fault-mutation-${randomUUID()}` }
      })
    });
    assert.equal(submit.code, 86);
    assert.equal(submit.responses.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
