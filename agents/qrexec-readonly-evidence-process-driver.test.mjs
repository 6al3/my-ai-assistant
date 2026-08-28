import test from 'node:test';
import assert from 'node:assert/strict';
import { runBoundedEvidenceExporter } from './qrexec-readonly-evidence-process-driver.mjs';

const node = process.execPath;

function nodeSpec(source) {
  return { command: node, args: ['--input-type=module', '-e', source] };
}

test('bounded exporter preserves raw stdout and does not require a shell', async () => {
  const output = await runBoundedEvidenceExporter({
    processSpec: nodeSpec(`
      let input = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => input += chunk);
      process.stdin.on('end', () => process.stdout.write(input));
    `),
    input: '{"evidenceChallenge":"abc"}\n'
  });
  assert.equal(output, '{"evidenceChallenge":"abc"}\n');
});

test('bounded exporter rejects relative commands before spawn', async () => {
  await assert.rejects(
    runBoundedEvidenceExporter({ processSpec: { command: 'node', args: [] }, input: '{}\n' }),
    /absolute path/
  );
});

test('bounded exporter kills oversized stdout', async () => {
  await assert.rejects(
    runBoundedEvidenceExporter({
      processSpec: nodeSpec(`process.stdout.write('x'.repeat(4096));`),
      input: '{}\n',
      maxOutputBytes: 128
    }),
    /output exceeds byte limit/
  );
});

test('bounded exporter fails closed on timeout', async () => {
  await assert.rejects(
    runBoundedEvidenceExporter({
      processSpec: nodeSpec(`setTimeout(() => process.stdout.write('{}\\n'), 1000);`),
      input: '{}\n',
      timeoutMs: 25
    }),
    /timed out/
  );
});

test('bounded exporter does not reflect remote stderr', async () => {
  const secret = 'LEASE_TOKEN_SHOULD_NOT_REFLECT';
  await assert.rejects(
    runBoundedEvidenceExporter({
      processSpec: nodeSpec(`process.stderr.write('${secret}'); process.exit(7);`),
      input: '{}\n'
    }),
    (error) => {
      assert.equal(error.message, 'evidence exporter failed');
      assert.equal(error.message.includes(secret), false);
      return true;
    }
  );
});

test('bounded exporter rejects empty successful output', async () => {
  await assert.rejects(
    runBoundedEvidenceExporter({
      processSpec: nodeSpec(`process.exit(0);`),
      input: '{}\n'
    }),
    /returned no output/
  );
});
