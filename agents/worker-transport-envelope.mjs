import { createHmac, timingSafeEqual } from 'node:crypto';

function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('worker envelope body must contain only finite JSON numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw new TypeError('worker envelope body must contain only JSON-compatible values');
}

function stablePayload({ version, requestId, issuedAt, op, body }) {
  return canonicalJson({ version, requestId, issuedAt, op, body: body ?? null });
}

function normalizeSecret(secret) {
  if (Buffer.isBuffer(secret) && secret.byteLength >= 32) return secret;
  if (typeof secret === 'string' && Buffer.byteLength(secret, 'utf8') >= 32) return Buffer.from(secret, 'utf8');
  throw new Error('transport secret must be at least 32 bytes');
}

function assertEnvelopeIdentity({ requestId, issuedAt, op, version }) {
  if (version !== 1) throw new Error('unsupported worker envelope version');
  if (typeof requestId !== 'string' || requestId.trim() === '') throw new Error('requestId is required');
  if (typeof op !== 'string' || op.trim() === '') throw new Error('op is required');
  if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0) throw new Error('issuedAt must be a positive integer');
  return { requestId: requestId.trim(), op: op.trim() };
}

export function signWorkerEnvelope({ requestId, issuedAt = Date.now(), op, body = null, secret, version = 1 } = {}) {
  const identity = assertEnvelopeIdentity({ requestId, issuedAt, op, version });
  const key = normalizeSecret(secret);
  // Canonicalize once at the trust boundary so Swift/Node/Qubes clients can
  // independently produce the same MAC for semantically identical JSON.
  canonicalJson(body);
  const envelope = { version, requestId: identity.requestId, issuedAt, op: identity.op, body };
  const mac = createHmac('sha256', key).update(stablePayload(envelope)).digest('hex');
  return { ...envelope, mac };
}

export class WorkerEnvelopeVerifier {
  constructor({ secret, maxSkewMs = 30_000, now = () => Date.now(), maxSeen = 10_000 } = {}) {
    this.secret = normalizeSecret(secret);
    if (!Number.isSafeInteger(maxSkewMs) || maxSkewMs < 0) throw new Error('maxSkewMs must be a non-negative integer');
    if (!Number.isSafeInteger(maxSeen) || maxSeen < 1) throw new Error('maxSeen must be a positive integer');
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    this.maxSkewMs = maxSkewMs;
    this.maxSeen = maxSeen;
    this.now = now;
    this.seen = new Map();
  }

  verify(envelope) {
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new Error('invalid worker envelope');
    const identity = assertEnvelopeIdentity(envelope);
    if (typeof envelope.mac !== 'string' || !/^[0-9a-f]{64}$/i.test(envelope.mac)) throw new Error('invalid worker envelope mac');
    canonicalJson(envelope.body ?? null);

    const now = this.now();
    if (!Number.isSafeInteger(now)) throw new Error('verifier clock must return an integer millisecond timestamp');
    if (Math.abs(now - envelope.issuedAt) > this.maxSkewMs) throw new Error('worker envelope expired');
    this.#prune(now);
    if (this.seen.has(identity.requestId)) throw new Error('worker envelope replay detected');

    const expected = createHmac('sha256', this.secret).update(stablePayload({ ...envelope, ...identity })).digest();
    const supplied = Buffer.from(envelope.mac, 'hex');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error('worker envelope authentication failed');

    // This bounded cache is defense-in-depth only. Durable replay/idempotency
    // across qrexec process boundaries remains the request journal's job.
    this.seen.set(identity.requestId, envelope.issuedAt);
    this.#trim();
    return { requestId: identity.requestId, op: identity.op, body: structuredClone(envelope.body ?? null), issuedAt: envelope.issuedAt };
  }

  #prune(now) {
    for (const [requestId, issuedAt] of this.seen) {
      if (Math.abs(now - issuedAt) > this.maxSkewMs) this.seen.delete(requestId);
    }
  }

  #trim() {
    while (this.seen.size > this.maxSeen) this.seen.delete(this.seen.keys().next().value);
  }
}
