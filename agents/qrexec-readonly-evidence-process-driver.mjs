import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { runReadonlyEvidenceChallengeQualification } from './qrexec-readonly-evidence-challenge-driver.mjs';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_OUTPUT_BYTES = 96 * 1024;

function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required`);
  return value.trim();
}

function requiredProcessSpec(spec, name) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error(`${name} is required`);
  const command = requiredString(spec.command, `${name}.command`);
  if (!isAbsolute(command)) throw new Error(`${name}.command must be an absolute path`);
  const args = spec.args ?? [];
  if (!Array.isArray(args) || args.some((value) => typeof value !== 'string')) {
    throw new Error(`${name}.args must be an array of strings`);
  }
  return Object.freeze({ command, args: Object.freeze([...args]) });
}

function requiredPositiveInteger(value, name, fallback) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) throw new Error(`${name} must be a positive integer`);
  return resolved;
}

/**
 * Executes one trust-domain evidence exporter as a bounded, shell-free child process.
 * stdout is preserved verbatim for the wire-only evidence importer; stderr is never
 * reflected into errors or qualification artifacts.
 */
export async function runBoundedEvidenceExporter({
  processSpec,
  input,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  spawnFn = spawn
} = {}) {
  const spec = requiredProcessSpec(processSpec, 'processSpec');
  if (typeof input !== 'string' || input.length === 0) throw new Error('input must be a non-empty string');
  const timeout = requiredPositiveInteger(timeoutMs, 'timeoutMs', DEFAULT_TIMEOUT_MS);
  const outputLimit = requiredPositiveInteger(maxOutputBytes, 'maxOutputBytes', DEFAULT_MAX_OUTPUT_BYTES);
  if (typeof spawnFn !== 'function') throw new Error('spawnFn is required');

  return new Promise((resolve, reject) => {
    let settled = false;
    let total = 0;
    const chunks = [];
    let child;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };

    try {
      child = spawnFn(spec.command, spec.args, {
        shell: false,
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true
      });
    } catch {
      reject(new Error('evidence exporter failed'));
      return;
    }

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      finish(new Error('evidence exporter timed out'));
    }, timeout);

    child.on('error', () => finish(new Error('evidence exporter failed')));
    child.stdout.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > outputLimit) {
        try { child.kill('SIGKILL'); } catch {}
        finish(new Error('evidence exporter output exceeds byte limit'));
        return;
      }
      chunks.push(chunk);
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      if (code !== 0 || signal) {
        finish(new Error('evidence exporter failed'));
        return;
      }
      const output = Buffer.concat(chunks).toString('utf8');
      if (!output.trim()) {
        finish(new Error('evidence exporter returned no output'));
        return;
      }
      finish(null, output);
    });

    try {
      child.stdin.end(input);
    } catch {
      try { child.kill('SIGKILL'); } catch {}
      finish(new Error('evidence exporter failed'));
    }
  });
}

/**
 * Production run-owner for split-domain Phase-1 evidence. The same unpredictable
 * challenge is sent independently to dom0 and Coordinator exporters. Their raw bounded
 * wire JSON is consumed exactly once by the existing authoritative importer.
 */
export async function runReadonlyEvidenceProcessQualification({
  dom0Process,
  coordinatorProcess,
  dom0Config,
  coordinatorConfig,
  expected,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  spawnFn = spawn,
  randomBytesFn
} = {}) {
  const dom0Spec = requiredProcessSpec(dom0Process, 'dom0Process');
  const coordinatorSpec = requiredProcessSpec(coordinatorProcess, 'coordinatorProcess');
  if (!dom0Config || typeof dom0Config !== 'object' || Array.isArray(dom0Config)) throw new Error('dom0Config is required');
  if (!coordinatorConfig || typeof coordinatorConfig !== 'object' || Array.isArray(coordinatorConfig)) throw new Error('coordinatorConfig is required');

  return runReadonlyEvidenceChallengeQualification({
    expected,
    randomBytesFn,
    collectDom0Export: ({ evidenceChallenge }) => runBoundedEvidenceExporter({
      processSpec: dom0Spec,
      input: `${JSON.stringify({ ...dom0Config, evidenceChallenge })}\n`,
      timeoutMs,
      maxOutputBytes,
      spawnFn
    }),
    collectCoordinatorExport: ({ evidenceChallenge }) => runBoundedEvidenceExporter({
      processSpec: coordinatorSpec,
      input: `${JSON.stringify({ ...coordinatorConfig, evidenceChallenge })}\n`,
      timeoutMs,
      maxOutputBytes,
      spawnFn
    })
  });
}
