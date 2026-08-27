import { collectDom0ReadonlyPolicyEvidence } from './qrexec-readonly-deployment-evidence-collector.mjs';

const MAX_CONFIG_BYTES = 8 * 1024;
const MAX_OUTPUT_BYTES = 80 * 1024;

async function readBoundedStdin(stream = process.stdin) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > MAX_CONFIG_BYTES) throw new Error('input exceeds byte limit');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) throw new Error('input is required');
  let value;
  try { value = JSON.parse(text); } catch { throw new Error('input must be valid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('input must be an object');
  return value;
}

export async function exportDom0ReadonlyPolicyEvidence({ input = process.stdin } = {}) {
  const config = await readBoundedStdin(input);
  const evidence = await collectDom0ReadonlyPolicyEvidence({ policyPath: config.policyPath });
  const output = `${JSON.stringify({ schemaVersion: 1, domain: 'dom0-policy', evidence })}\n`;
  if (Buffer.byteLength(output) > MAX_OUTPUT_BYTES) throw new Error('output exceeds byte limit');
  return output;
}

async function main() {
  try {
    process.stdout.write(await exportDom0ReadonlyPolicyEvidence());
  } catch {
    process.stderr.write('DIG_QUBES_DOM0_EVIDENCE_EXPORT_FAILED\n');
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
