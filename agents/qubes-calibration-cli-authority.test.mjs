import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);

test('legacy resource calibration harness cannot emit operational evidence', async () => {
  await assert.rejects(
    () => execFileAsync(process.execPath, ['agents/qubes-resource-calibration-harness.mjs'], {
      cwd: process.cwd(),
      env: {},
      timeout: 5000,
      encoding: 'utf8'
    }),
    error => {
      assert.notEqual(error.code, 0);
      assert.match(error.stderr ?? '', /legacy calibration CLI disabled/);
      assert.equal((error.stdout ?? '').trim(), '');
      return true;
    }
  );
});

test('duration-bound CLI is the named operational authority', async () => {
  const result = await execFileAsync(process.execPath, ['--check', 'agents/qubes-duration-bound-calibration-cli.mjs'], {
    cwd: process.cwd(),
    timeout: 5000,
    encoding: 'utf8'
  });
  assert.equal(result.stderr, '');
});
