import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createQrexecClientVmExchange } from './qrexec-client-vm-exchange.mjs';

function helper(source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dig-qrexec-exchange-'));
  const file = path.join(root, 'helper.mjs');
  fs.writeFileSync(file, source, { mode: 0o700 });
  return file;
}

test('qrexec exchange sends bytes over stdin and returns stdout bytes', async () => {
  const script = helper(`
    const chunks=[];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const input=Buffer.concat(chunks);
    if (process.argv.at(-2) !== 'coordinator' || process.argv.at(-1) !== 'DIG.Coordinator') process.exit(9);
    process.stdout.write(input);
  `);
  const exchange = createQrexecClientVmExchange({
    target: 'coordinator', service: 'DIG.Coordinator', executable: process.execPath, executableArgs: [script]
  });
  const request = Buffer.from('framed-request');
  assert.deepEqual(await exchange(request), request);
});

test('qrexec exchange rejects unsafe target and service names before spawn', () => {
  assert.throws(() => createQrexecClientVmExchange({ target: 'bad\nqube', service: 'DIG.Coordinator' }), /invalid target qube/);
  assert.throws(() => createQrexecClientVmExchange({ target: 'coordinator', service: 'DIG.Coordinator;rm' }), /invalid qrexec service/);
});

test('qrexec exchange fails closed on non-zero exit and captures bounded stderr', async () => {
  const script = helper(`process.stderr.write('policy denied'); process.exit(7);`);
  const exchange = createQrexecClientVmExchange({
    target: 'coordinator', service: 'DIG.Coordinator', executable: process.execPath, executableArgs: [script]
  });
  await assert.rejects(() => exchange(Buffer.from('x')), /qrexec-client-vm failed \(7\): policy denied/);
});

test('qrexec exchange kills a stalled call on timeout', async () => {
  const script = helper(`setTimeout(() => {}, 60_000);`);
  const exchange = createQrexecClientVmExchange({
    target: 'coordinator', service: 'DIG.Coordinator', executable: process.execPath, executableArgs: [script], timeoutMs: 40
  });
  await assert.rejects(() => exchange(Buffer.from('x')), /timed out after 40ms/);
});

test('qrexec exchange rejects oversized responses', async () => {
  const script = helper(`for await (const _ of process.stdin) {} process.stdout.write(Buffer.alloc(128, 65));`);
  const exchange = createQrexecClientVmExchange({
    target: 'coordinator', service: 'DIG.Coordinator', executable: process.execPath, executableArgs: [script], maxResponseBytes: 32
  });
  await assert.rejects(() => exchange(Buffer.from('x')), /response exceeds 32 bytes/);
});

test('qrexec exchange reports spawn failure without hanging', async () => {
  const exchange = createQrexecClientVmExchange({
    target: 'coordinator', service: 'DIG.Coordinator', executable: '/definitely/not/a/qrexec-client-vm', timeoutMs: 250
  });
  await assert.rejects(() => exchange(Buffer.from('x')), /spawn failed/);
});
