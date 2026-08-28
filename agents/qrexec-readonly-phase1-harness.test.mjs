import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createQrexecClientVmInvoker } from './qrexec-readonly-phase1-harness.mjs';

function fakeSpawn({ stdout = '', code = 0, error = null } = {}, capture = {}) {
  return (command, args, options) => {
    capture.command = command;
    capture.args = args;
    capture.options = options;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = (payload) => { capture.payload = Buffer.from(payload); };
    child.kill = (signal) => { capture.killed = signal; };
    queueMicrotask(() => {
      if (error) return child.emit('error', error);
      if (stdout) child.stdout.emit('data', Buffer.from(stdout));
      child.emit('close', code);
    });
    return child;
  };
}

test('invokes qrexec-client-vm without shell and returns one bounded JSON frame', async () => {
  const capture = {};
  const invoke = createQrexecClientVmInvoker({
    coordinatorQube: 'dig-coordinator',
    scenarios: { 'intended-service-allowed': { service: 'dig.ReadonlyProbe', payload: '{"probe":true}\n' } },
    spawnImpl: fakeSpawn({ stdout: '{"ok":true}\n', code: 0 }, capture)
  });
  const result = await invoke('intended-service-allowed');
  assert.equal(capture.command, '/usr/bin/qrexec-client-vm');
  assert.deepEqual(capture.args, ['dig-coordinator', 'dig.ReadonlyProbe']);
  assert.equal(capture.options.shell, false);
  assert.equal(capture.options.stdio[2], 'ignore');
  assert.equal(capture.payload.toString('utf8'), '{"probe":true}\n');
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.response, { ok: true });
  assert.equal(result.responseFrames, 1);
});

test('preserves policy denial as non-zero observation without stderr capture', async () => {
  const capture = {};
  const invoke = createQrexecClientVmInvoker({
    coordinatorQube: 'dig-coordinator',
    scenarios: { 'wrong-service-denied': { service: 'dig.NotAllowed', payload: '{}' } },
    spawnImpl: fakeSpawn({ code: 126 }, capture)
  });
  const result = await invoke('wrong-service-denied');
  assert.equal(result.exitCode, 126);
  assert.equal(result.response, null);
  assert.equal(capture.options.stdio[2], 'ignore');
});

test('kills the child and fails closed when response exceeds byte bound', async () => {
  const capture = {};
  const invoke = createQrexecClientVmInvoker({
    coordinatorQube: 'dig-coordinator',
    maxResponseBytes: 8,
    scenarios: { oversized: { service: 'dig.ReadonlyProbe', payload: '{}' } },
    spawnImpl: fakeSpawn({ stdout: '{"too":"large"}', code: 0 }, capture)
  });
  await assert.rejects(() => invoke('oversized'), /response exceeded 8 bytes/);
  assert.equal(capture.killed, 'SIGKILL');
});

test('rejects unconfigured scenarios and spawn failures without exposing child stderr', async () => {
  const invoke = createQrexecClientVmInvoker({ coordinatorQube: 'dig-coordinator', scenarios: {} });
  await assert.rejects(() => invoke('missing'), /scenario missing is not configured/);

  const failed = createQrexecClientVmInvoker({
    coordinatorQube: 'dig-coordinator',
    scenarios: { x: { service: 'dig.ReadonlyProbe', payload: '{}' } },
    spawnImpl: fakeSpawn({ error: Object.assign(new Error('secret path should not surface'), { code: 'ENOENT' }) })
  });
  await assert.rejects(() => failed('x'), /qrexec invocation failed: ENOENT/);
});
