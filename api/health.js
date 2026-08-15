import { authConfigured, isOwnerRequest } from '../security/owner-auth.mjs';

export default async function handler(request) {
  if (request.method !== 'GET') {
    return Response.json({ error: 'Only GET requests are allowed.' }, { status: 405 });
  }
  if (!authConfigured()) {
    return Response.json({ error: 'Owner authentication is not configured.' }, { status: 503 });
  }
  if (!isOwnerRequest(request)) {
    return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const model = process.env.AI_MODEL || 'local-model';
  return Response.json(
    {
      ok: true,
      service: 'my-ai-assistant',
      provider: 'self-hosted',
      authRequired: true,
      model,
      webAccess: true,
      timestamp: new Date().toISOString()
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
