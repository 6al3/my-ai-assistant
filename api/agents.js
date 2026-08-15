import { getAgents, buildExecutionPlan } from '../agents/orchestrator.mjs';
import { authConfigured, isOwnerRequest } from '../security/owner-auth.mjs';

export default async function handler(req, res) {
  if (!authConfigured()) {
    return res.status(503).json({ ok: false, error: 'owner_auth_not_configured' });
  }
  if (!isOwnerRequest(req)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      count: getAgents().length,
      agents: getAgents().map(a => ({ ...a, status: 'ready' })),
      timestamp: new Date().toISOString()
    });
  }
  if (req.method === 'POST') {
    const task = typeof req.body?.task === 'string' ? req.body.task.trim() : '';
    if (!task) return res.status(400).json({ ok: false, error: 'task_required' });
    return res.status(200).json({ ok: true, plan: buildExecutionPlan(task) });
  }
  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ ok: false, error: 'method_not_allowed' });
}
