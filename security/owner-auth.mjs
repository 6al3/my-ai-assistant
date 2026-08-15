import { createHmac, timingSafeEqual } from 'node:crypto';

export const OWNER_COOKIE = 'dig_owner';
const SESSION_TTL_SECONDS = 12 * 60 * 60;

function getHeader(request, name) {
  if (request?.headers?.get) return request.headers.get(name) || '';
  const headers = request?.headers || {};
  return headers[name.toLowerCase()] || headers[name] || '';
}

function b64url(value) {
  return Buffer.from(value).toString('base64url');
}

function sign(value, secret) {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

function safeEqualString(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

export function authConfigured() {
  return Boolean(process.env.DIG_OWNER_PASSWORD && process.env.DIG_SESSION_SECRET);
}

export function verifyPassword(password) {
  if (!authConfigured()) return false;
  return safeEqualString(password || '', process.env.DIG_OWNER_PASSWORD);
}

export function createOwnerSession() {
  if (!authConfigured()) throw new Error('Owner authentication is not configured.');
  const payload = b64url(JSON.stringify({
    v: 1,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS
  }));
  const signature = sign(payload, process.env.DIG_SESSION_SECRET);
  return `${payload}.${signature}`;
}

export function verifyOwnerSession(token) {
  if (!authConfigured() || !token) return false;
  const [payload, signature, extra] = String(token).split('.');
  if (!payload || !signature || extra) return false;
  const expected = sign(payload, process.env.DIG_SESSION_SECRET);
  if (!safeEqualString(signature, expected)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data?.v === 1 && Number.isFinite(data?.exp) && data.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

export function isOwnerRequest(request) {
  const cookieHeader = getHeader(request, 'cookie');
  const cookies = Object.fromEntries(cookieHeader.split(';').map(part => {
    const index = part.indexOf('=');
    if (index < 0) return ['', ''];
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }).filter(([key]) => key));
  return verifyOwnerSession(cookies[OWNER_COOKIE]);
}

export function ownerCookie(token) {
  return `${OWNER_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}`;
}

export function clearOwnerCookie() {
  return `${OWNER_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}
