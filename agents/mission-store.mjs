import fs from 'node:fs';
import path from 'node:path';

const STORE_PATH = process.env.DIG_MISSION_STORE || path.join(process.cwd(), '.dig', 'missions.json');

function ensureDir() {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
}

export function loadMissionSnapshot() {
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.missions)) return [];
    return parsed.missions;
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

export function saveMissionSnapshot(missions) {
  ensureDir();
  const tmp = `${STORE_PATH}.${process.pid}.tmp`;
  const payload = JSON.stringify({
    version: 1,
    savedAt: new Date().toISOString(),
    missions
  }, null, 2);
  fs.writeFileSync(tmp, payload, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, STORE_PATH);
}

export function missionStorePath() {
  return STORE_PATH;
}
