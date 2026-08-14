import {
  createMission,
  listMissions,
  getMission,
  claimNextMission,
  heartbeatMission,
  completeMission,
  failMission,
  cancelMission,
  recoverExpiredLeases
} from '../agents/mission-queue.mjs';

function send(res, status, body) { return res.status(status).json(body); }

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      recoverExpiredLeases();
      const id = typeof req.query?.id === 'string' ? req.query.id : '';
      if (id) {
        const mission = getMission(id);
        return mission ? send(res, 200, { ok: true, mission }) : send(res, 404, { ok: false, error: 'mission_not_found' });
      }
      return send(res, 200, { ok: true, missions: listMissions() });
    }

    if (req.method === 'POST') {
      const action = String(req.body?.action || 'create');
      if (action === 'create') {
        const mission = createMission({
          goal: req.body?.goal,
          priority: req.body?.priority,
          metadata: req.body?.metadata || {},
          maxAttempts: req.body?.maxAttempts
        });
        return send(res, 201, { ok: true, mission });
      }
      if (action === 'claim') {
        const mission = claimNextMission(req.body?.workerId || 'local-worker', req.body?.leaseMs);
        return send(res, 200, { ok: true, mission });
      }
      if (action === 'heartbeat') {
        return send(res, 200, {
          ok: true,
          mission: heartbeatMission(req.body?.id, req.body?.workerId, req.body?.leaseToken, req.body?.leaseMs)
        });
      }
      if (action === 'complete') {
        return send(res, 200, {
          ok: true,
          mission: completeMission(req.body?.id, req.body?.result || {}, req.body?.workerId, req.body?.leaseToken)
        });
      }
      if (action === 'fail') {
        return send(res, 200, {
          ok: true,
          mission: failMission(req.body?.id, req.body?.error || 'unknown_error', req.body?.workerId, req.body?.leaseToken)
        });
      }
      if (action === 'recover') {
        return send(res, 200, { ok: true, recovered: recoverExpiredLeases() });
      }
      if (action === 'cancel') return send(res, 200, { ok: true, mission: cancelMission(req.body?.id) });
      return send(res, 400, { ok: false, error: 'unknown_action' });
    }

    res.setHeader('Allow', 'GET, POST');
    return send(res, 405, { ok: false, error: 'method_not_allowed' });
  } catch (error) {
    const badRequest = new Set([
      'goal_required', 'mission_not_running', 'worker_mismatch', 'lease_token_mismatch', 'lease_expired'
    ]);
    const code = badRequest.has(error?.message) ? 400 : error?.message === 'mission_not_found' ? 404 : 500;
    return send(res, code, { ok: false, error: error?.message || 'server_error' });
  }
}
