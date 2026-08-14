import { registerWorker, heartbeatWorker, listWorkers, reapStaleWorkers } from '../workers/worker-registry.mjs';
import { rankWorkers } from '../workers/scheduler.mjs';

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const required = typeof req.query?.capabilities === 'string'
      ? req.query.capabilities.split(',').map(x => x.trim()).filter(Boolean)
      : [];
    const workers = required.length ? rankWorkers(required).map(x => ({ ...x.worker, score: x.score })) : listWorkers();
    return res.status(200).json({ ok: true, count: workers.length, workers });
  }

  if (req.method === 'POST') {
    const action = String(req.body?.action || 'register');
    if (action === 'register') {
      const worker = registerWorker(req.body?.worker || {});
      return res.status(201).json({ ok: true, worker });
    }
    if (action === 'heartbeat') {
      const id = req.body?.id;
      if (!id) return res.status(400).json({ ok: false, error: 'id_required' });
      const worker = heartbeatWorker(id, req.body?.patch || {});
      if (!worker) return res.status(404).json({ ok: false, error: 'worker_not_found' });
      return res.status(200).json({ ok: true, worker });
    }
    if (action === 'reap') {
      const stale = reapStaleWorkers();
      return res.status(200).json({ ok: true, stale });
    }
    return res.status(400).json({ ok: false, error: 'unknown_action' });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ ok: false, error: 'method_not_allowed' });
}
