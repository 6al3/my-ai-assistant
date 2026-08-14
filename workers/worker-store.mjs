import fs from 'node:fs';
import path from 'node:path';

const STORE_PATH = process.env.DIG_WORKER_STORE || path.join(process.cwd(), '.dig', 'workers.json');

function ensureDir() {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
}

export function loadWorkerSnapshot() {
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && Array.isArray(parsed.workers) ? parsed.workers : [];
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

export function saveWorkerSnapshot(workers) {
  ensureDir();
  const tmp = `${STORE_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), workers }, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, STORE_PATH);
}

export function workerStorePath() { return STORE_PATH; }
