import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { processStartIdentity, withFileMutationLock } from './file-mutation-lock.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function missing(target) {
  try {
    await stat(target);
    return false;
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw error;
  }
}

test('mutation lock serializes competing callers and reports acquisition wait', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dig-mutation-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lock = path.join(root, 'state.lock');
  const events = [];
  const waits = [];

  await Promise.all([
    withFileMutationLock(lock, async () => {
      events.push('a:start');
      await new Promise(resolve => setTimeout(resolve, 40));
      events.push('a:end');
    }, { onAcquired: timing => waits.push(timing.waitMs) }),
    withFileMutationLock(lock, async () => {
      events.push('b:start');
      events.push('b:end');
    }, { onAcquired: timing => waits.push(timing.waitMs) })
  ]);

  const aStart = events.indexOf('a:start');
  const aEnd = events.indexOf('a:end');
  const bStart = events.indexOf('b:start');
  const bEnd = events.indexOf('b:end');
  assert.ok((aEnd < bStart) || (bEnd < aStart), `critical sections overlapped: ${events.join(', ')}`);
  assert.equal(waits.length, 2);
  assert.ok(waits.every(value => Number.isFinite(value) && value >= 0));
  assert.ok(Math.max(...waits) >= 20, `expected a contended acquisition wait, got ${waits.join(', ')}`);
});

test('mutation lock validates acquisition telemetry callback', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dig-mutation-lock-callback-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(() => withFileMutationLock(path.join(root, 'state.lock'), async () => {}, { onAcquired: true }), /onAcquired/);
});

test('mutation lock validates process liveness callback', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dig-mutation-lock-liveness-callback-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(() => withFileMutationLock(path.join(root, 'state.lock'), async () => {}, { isProcessAlive: true }), /isProcessAlive/);
});

test('mutation lock is released when acquisition telemetry throws', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dig-mutation-lock-telemetry-error-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lock = path.join(root, 'state.lock');
  let operationRan = false;

  await assert.rejects(() => withFileMutationLock(lock, async () => {
    operationRan = true;
  }, {
    onAcquired: async () => {
      throw new Error('telemetry failed');
    }
  }), /telemetry failed/);
  assert.equal(operationRan, false, 'protected operation must not run after telemetry failure');

  const result = await withFileMutationLock(lock, async () => 'reacquired', { retryMs: 1, timeoutMs: 100 });
  assert.equal(result, 'reacquired');
});

test('mutation lock is released when the protected operation throws', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dig-mutation-lock-error-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lock = path.join(root, 'state.lock');
  await assert.rejects(() => withFileMutationLock(lock, async () => { throw new Error('boom'); }), /boom/);
  const result = await withFileMutationLock(lock, async () => 'reacquired');
  assert.equal(result, 'reacquired');
});

test('process start identity is available for the current process', async () => {
  const identity = await processStartIdentity(process.pid);
  assert.equal(typeof identity, 'string');
  assert.ok(identity.length > 0);
});

test('mutation lock reclaims a reused PID only when process identity differs', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dig-mutation-lock-reused-pid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lock = path.join(root, 'state.lock');
  await mkdir(lock, { mode: 0o700 });
  await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: 4242, token: 'old-owner', processIdentity: 'old-process-instance', createdAt: 1 }));
  const result = await withFileMutationLock(lock, async () => 'reclaimed', {
    getProcessIdentity: async pid => pid === process.pid ? 'current-process-instance' : 'reused-pid-new-instance',
    isProcessAlive: () => true,
    retryMs: 1,
    timeoutMs: 100
  });
  assert.equal(result, 'reclaimed');
});

test('mutation lock never steals a lock from a live matching process instance', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dig-mutation-lock-live-owner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lock = path.join(root, 'state.lock');
  await mkdir(lock, { mode: 0o700 });
  await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: 4242, token: 'live-owner', processIdentity: 'live-process-instance', createdAt: 1 }));
  await assert.rejects(() => withFileMutationLock(lock, async () => 'must-not-run', {
    getProcessIdentity: async pid => pid === process.pid ? 'current-process-instance' : 'live-process-instance',
    isProcessAlive: () => true,
    retryMs: 1,
    timeoutMs: 10
  }), /timed out acquiring mutation lock/);
  const owner = JSON.parse(await readFile(path.join(lock, 'owner.json'), 'utf8'));
  assert.equal(owner.token, 'live-owner');
});

test('mutation lock fails closed when a live owner identity cannot be verified', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dig-mutation-lock-live-unverifiable-owner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lock = path.join(root, 'state.lock');
  await mkdir(lock, { mode: 0o700 });
  await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: 4242, token: 'live-owner', processIdentity: 'known-owner-instance', createdAt: 1 }));

  await assert.rejects(() => withFileMutationLock(lock, async () => 'must-not-run', {
    getProcessIdentity: async pid => pid === process.pid ? 'current-process-instance' : null,
    isProcessAlive: pid => pid === 4242,
    retryMs: 1,
    timeoutMs: 10
  }), /timed out acquiring mutation lock/);

  const owner = JSON.parse(await readFile(path.join(lock, 'owner.json'), 'utf8'));
  assert.equal(owner.token, 'live-owner');
});

test('mutation lock reclaims an owner only when identity is unavailable and PID is dead', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dig-mutation-lock-dead-unverifiable-owner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lock = path.join(root, 'state.lock');
  await mkdir(lock, { mode: 0o700 });
  await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: 4242, token: 'dead-owner', processIdentity: 'dead-owner-instance', createdAt: 1 }));

  const result = await withFileMutationLock(lock, async () => 'reclaimed', {
    getProcessIdentity: async pid => pid === process.pid ? 'current-process-instance' : null,
    isProcessAlive: () => false,
    retryMs: 1,
    timeoutMs: 100
  });
  assert.equal(result, 'reclaimed');
});

test('mutation lock fails closed on malformed owner metadata', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dig-mutation-lock-malformed-owner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lock = path.join(root, 'state.lock');
  await mkdir(lock, { mode: 0o700 });
  await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: 4242, token: 'legacy-owner' }));
  await assert.rejects(() => withFileMutationLock(lock, async () => 'must-not-run', {
    getProcessIdentity: async pid => pid === process.pid ? 'current-process-instance' : 'some-live-process',
    isProcessAlive: () => true,
    retryMs: 1,
    timeoutMs: 10
  }), /invalid mutation lock owner metadata/);
});

test('mutation lock fails closed on corrupt owner JSON even after orphan grace', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dig-mutation-lock-corrupt-owner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lock = path.join(root, 'state.lock');
  await mkdir(lock, { mode: 0o700 });
  await writeFile(path.join(lock, 'owner.json'), '{not-json');

  await assert.rejects(() => withFileMutationLock(lock, async () => 'must-not-run', {
    now: () => 1_000_000,
    orphanGraceMs: 1,
    getProcessIdentity: async pid => pid === process.pid ? 'current-process-instance' : 'unexpected',
    isProcessAlive: () => true,
    retryMs: 1,
    timeoutMs: 10
  }), /invalid mutation lock owner metadata/);
});

test('contenders tolerate the ownerless publication window and only observe complete owner metadata', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dig-mutation-lock-owner-publication-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lock = path.join(root, 'state.lock');
  const ownerPath = path.join(lock, 'owner.json');
  const events = [];

  let releasePublication;
  const publicationGate = new Promise(resolve => { releasePublication = resolve; });
  let directoryCreated;
  const directoryReady = new Promise(resolve => { directoryCreated = resolve; });

  const first = withFileMutationLock(lock, async () => {
    events.push('first');
    await sleep(15);
  }, {
    retryMs: 1,
    timeoutMs: 500,
    orphanGraceMs: 1_000,
    onDirectoryCreated: async () => {
      directoryCreated();
      await publicationGate;
    }
  });

  await directoryReady;
  assert.equal(await missing(ownerPath), true, 'owner metadata must remain absent before atomic publication');

  const contender = withFileMutationLock(lock, async () => {
    events.push('contender');
    const owner = JSON.parse(await readFile(ownerPath, 'utf8'));
    assert.equal(typeof owner.token, 'string');
    assert.equal(typeof owner.processIdentity, 'string');
  }, {
    retryMs: 1,
    timeoutMs: 500,
    orphanGraceMs: 1_000
  });

  await sleep(10);
  releasePublication();
  await Promise.all([first, contender]);
  assert.deepEqual(events, ['first', 'contender']);
});

test('owner publication setup failure removes the ownerless lock attempt immediately', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dig-mutation-lock-owner-publication-error-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lock = path.join(root, 'state.lock');

  await assert.rejects(() => withFileMutationLock(lock, async () => 'must-not-run', {
    onDirectoryCreated: async () => {
      throw new Error('owner publication setup failed');
    }
  }), /owner publication setup failed/);

  assert.equal(await missing(lock), true, 'failed publication must not leave an ownerless lock directory');
  assert.equal(await withFileMutationLock(lock, async () => 'reacquired'), 'reacquired');
});
