import { authConfigured, verifyPassword, createOwnerSession, isOwnerRequest, ownerCookie, clearOwnerCookie } from '../security/owner-auth.mjs';

function json(body, status = 200, headers = {}) {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
      ...headers
    }
  });
}

export default async function handler(request) {
  if (request.method === 'GET') {
    return json({ configured: authConfigured(), authenticated: isOwnerRequest(request) });
  }

  if (request.method === 'DELETE') {
    return json({ ok: true }, 200, { 'Set-Cookie': clearOwnerCookie() });
  }

  if (request.method !== 'POST') {
    return json({ error: 'Only GET, POST and DELETE are allowed.' }, 405);
  }

  if (!authConfigured()) {
    return json({ error: 'Owner authentication is locked until DIG_OWNER_PASSWORD and DIG_SESSION_SECRET are configured.' }, 503);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON.' }, 400);
  }

  const password = typeof body?.password === 'string' ? body.password : '';
  if (!verifyPassword(password)) {
    await new Promise(resolve => setTimeout(resolve, 450));
    return json({ error: 'Invalid owner password.' }, 401);
  }

  const token = createOwnerSession();
  return json({ ok: true, authenticated: true }, 200, { 'Set-Cookie': ownerCookie(token) });
}
