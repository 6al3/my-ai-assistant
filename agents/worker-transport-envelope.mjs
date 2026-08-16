import { createHmac, timingSafeEqual } from 'node:crypto';

function stablePayload({ version, requestId, issuedAt, op, body }) {
  return JSON.stringify([version, requestId, issuedAt, op, body ?? null]);
}

function normalizeSecret(secret) {
  if (Buffer.isBuffer(secret)) return secret;
  if (typeof secret === 'string' && secret.length >= 32) return Buffer.from(secret, 'utf8');
  throw new Error('transport secret must be at least 32 bytes');
}

export function signWorkerEnvelope({ requestId, issuedAt = Date.now(), op, body = null, secret, version = 1 } = {}) {
  if (!requestId?.trim()) throw new Error('requestId is required');
  if (!op?.trim()) throw new Error('op is required');
  if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0) throw new Error('issuedAt must be a positive integer');
  const key = normalizeSecret(secret);
  const envelope = { version, requestId: requestId.trim(), issuedAt, op: op.trim(), body };
  const mac = createHmac('sha256', key).update(stablePayload(envelope)).digest('hex');
  return { ...envelope, mac };
}

export class WorkerEnvelopeVerifier {
  constructor({ secret, maxSkewMs = 30_000, now = () => Date.now(), maxSeen = 10_000 } = {}) {
    this.secret = normalizeSecret(secret);
    if (!Number.isSafeInteger(maxSkewMs) || maxSkewMs < 0) throw new Error('maxSkewMs must be a non-negative integer');
    if (!Number.isSafeInteger(maxSeen) || maxSeen < 1) throw new Error('maxSeen must be a positive integer');
    this.maxSkewMs = maxSkewMs;
    this.maxSeen = maxSeen;
    this.now = now;
    this.seen = new Map();
  }

  verify(envelope) {
    if (!envelope || envelope.version !== 1) throw new Error('unsupported worker envelope version');
    if (!envelope.requestId?.trim() || !envelope.op?.trim()) throw new Error('invalid worker envelope');
    if (!Number.isSafeInteger(envelope.issuedAt)) throw new Error('invalid worker envelope timestamp');
    if (typeof envelope.mac !== 'string' || !/^[0-9a-f]{64}$/i.test(envelope.mac)) throw new Error('invalid worker envelope mac');

    const now = this.now();
    if (Math.abs(now - envelope.issuedAt) > this.maxSkewMs) throw new Error('worker envelope expired');
    this.#prune(now);
    if (this.seen.has(envelope.requestId)) throw new Error('worker envelope replay detected');

    const expected = createHmac('sha256', this.secret).update(stablePayload(envelope)).digest();
    const supplied = Buffer.from(envelope.mac, 'hex');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error('worker envelope authentication failed');

    this.seen.set(envelope.requestId, envelope.issuedAt);
    this.#trim();
    return { requestId: envelope.requestId, op: envelope.op, body: envelope.body ?? null, issuedAt: envelope.issuedAt };
  }

  #prune(now) {
    for (const [requestId, issuedAt] of this.seen) {
      if (Math.abs(now - issuedAt) > this.maxSkewMs) this.seen.delete(requestId);
    }
  }

  #trim() {
    while (this.seen.size > this.maxSeen) {
      const oldest = this.seen.keys().next().value;
      this.seen.delete(oldest);
    }
  }
}
