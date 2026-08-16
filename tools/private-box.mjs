import { spawn } from 'node:child_process';

const aiBaseUrl = String(process.env.AI_BASE_URL || 'http://127.0.0.1:11434/v1').replace(/\/+$/, '');
const filePort = Number(process.env.BOX_FILE_PORT || 8788);

if (!process.env.OWNER_TOKEN) {
  console.error('DIG Private Box: OWNER_TOKEN is required before startup.');
  console.error('Set it in the shell environment, then run: npm run private-box');
  process.exit(1);
}

async function checkAi() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(`${aiBaseUrl}/models`, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

console.log('DIG Private Box');
console.log(`Files: http://127.0.0.1:${filePort}`);
console.log(`AI:    ${aiBaseUrl}`);
console.log('Starting localhost-only file service...');

const files = spawn(process.execPath, ['box/file-api.mjs'], {
  stdio: 'inherit',
  env: process.env
});

files.on('exit', (code, signal) => {
  if (signal) console.error(`File service stopped by ${signal}`);
  else if (code !== 0) console.error(`File service exited with code ${code}`);
  process.exit(code ?? 1);
});

const aiReady = await checkAi();
console.log(`AI status: ${aiReady ? 'READY' : 'NOT READY'}`);
if (!aiReady) {
  console.log('The launcher did not open any AI port. Start/configure the existing self-hosted model separately, then rerun this command.');
}

function shutdown() {
  if (!files.killed) files.kill('SIGTERM');
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
