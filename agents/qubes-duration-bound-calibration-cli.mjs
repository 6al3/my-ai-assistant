import { pathToFileURL } from 'node:url';
import { buildQubesCalibrationRuntime, calibrationCliConfigFromEnv } from './qubes-resource-calibration-harness.mjs';
import { runDurationBoundQubesCalibration } from './qubes-duration-bound-calibration.mjs';

export function durationBoundCliConfigFromEnv(env = process.env) {
  const config = calibrationCliConfigFromEnv(env);
  const requestedIntervalMs = env.DIG_CALIBRATION_INTERVAL_MS === undefined || env.DIG_CALIBRATION_INTERVAL_MS === ''
    ? null
    : Number(env.DIG_CALIBRATION_INTERVAL_MS);
  return { ...config, requestedIntervalMs };
}

export async function runDurationBoundCalibrationCli(config, {
  buildRuntime = buildQubesCalibrationRuntime,
  runCalibration = runDurationBoundQubesCalibration,
  sleep,
  now
} = {}) {
  if (!config || typeof config !== 'object') throw new Error('calibration CLI config is required');
  const runtime = buildRuntime(config);
  const result = await runCalibration({
    gitSha: config.gitSha,
    runtime,
    runId: config.runId,
    sampleCount: config.sampleCount,
    requestedIntervalMs: config.requestedIntervalMs,
    sleep,
    now
  });
  return { ...result, runtime };
}

async function main() {
  const config = durationBoundCliConfigFromEnv();
  const { events } = await runDurationBoundCalibrationCli(config);
  for (const event of events) process.stdout.write(`${JSON.stringify(event)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`DIG duration-bound resource calibration failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
