import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runRealQrexecAcceptance } from './qrexec-real-acceptance.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dig-real-qrexec-'));
  const secretFile = path.join(root, 'coder-1.key');
  const counterFile = path.join(root, 'counter.json');
  const requestFile = path.join(root, 'requests.json');
  fs.writeFileSync(secretFile, `${'R'.repeat(48)}\n`, { mode: 0o600 });
  const helper = path.join(root, 'fake-qrexec.mjs');
  fs.writeFileSync(helper, `
    const chunks=[];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const body=Buffer.from(JSON.stringify({ok:true,result:null}));
    const header=Buffer.alloc(4); header.writeUInt32BE(body.length,0);
    process.stdout.write(Buffer.concat([header,body]));
  `, { mode: 0o700 });
  const wrapper = path.join(root, 'qrexec-client-vm');
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${helper}" "$@"\n`, { mode: 0o700 });
  return { root, secretFile, counterFile, requestFile, wrapper };
}

test('real qrexec acceptance probe is read-only and exercises persistent signing state', async () => {
  const f = fixture();
  const result = await runRealQrexecAcceptance({
    workerId: 'coder-1',
    workerSecretFile: f.secretFile,
    counterFile: f.counterFile,
    requestFile: f.requestFile,
    target: 'coordinator',
    service: 'DIG.Coordinator',
    executable: f.wrapper,
    timeoutMs: 2_000
  });
  assert.equal(result.readiness, 'transport-auth-ready');
  assert.equal(result.mutationPerformed, false);
  assert.equal(result.pendingBefore, 0);
  assert.equal(result.unresolved, 0);
  assert.ok(Number.isFinite(result.probeRoundTripMs));
  const counter = JSON.parse(fs.readFileSync(f.counterFile, 'utf8'));
  assert.equal(counter.nextCounter, 2, 'one authenticated read-only request must reserve exactly one counter');
});

test('real qrexec acceptance refuses broad secret permissions on POSIX', async t => {
  if (process.platform === 'win32') return t.skip('POSIX permission test');
  const f = fixture();
  fs.chmodSync(f.secretFile, 0o644);
  await assert.rejects(() => runRealQrexecAcceptance({
    workerId: 'coder-1', workerSecretFile: f.secretFile, counterFile: f.counterFile, requestFile: f.requestFile,
    target: 'coordinator', service: 'DIG.Coordinator', executable: f.wrapper
  }), /permissions are too broad/);
});
