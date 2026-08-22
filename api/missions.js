import { authConfigured, isOwnerRequest } from '../security/owner-auth.mjs';
import { loadMissionControlPlaneSnapshot } from './missions-core.mjs';

export default async function handler(req, res) {
  if (!authConfigured()) {
    return res.status(503).json({ ok: false, error: 'owner_auth_not_configured' });
  }
  if (!isOwnerRequest(req)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  const storePath = process.env.DIG_MISSION_STORE_PATH;
  if (!storePath?.trim()) {
    return res.status(503).json({ ok: false, error: 'mission_telemetry_not_configured' });
  }

  try {
    const snapshot = await loadMissionControlPlaneSnapshot(storePath);
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    return res.status(200).json(snapshot);
  } catch (error) {
    console.error('mission telemetry snapshot failed', error);
    return res.status(503).json({ ok: false, error: 'mission_telemetry_unavailable' });
  }
}
