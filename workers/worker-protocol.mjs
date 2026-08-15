import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
}

export class WorkerAuthenticator {
  constructor({ secrets, maxClockSkewMs = 30_000, nonceTtlMs = 120_000, now = () => Date.now() } = {}) {
    if (!secrets || (typeof secrets !== 'object' && typeof secrets !== 'function')) throw new Error('secrets map or resolver is required');
    if (!Number.isFinite(maxClockSkewMs) || maxClockSkewMs < 0) throw new Error('maxClockSkewMs must be >= 0');
    if (!Number.isFinite(nonceTtlMs) || nonceTtlMs <= 0) throw new Error('nonceTtlMs must be > 0');
    this.secrets = secrets;
    this.maxClockSkewMs = maxClockSkewMs;
    this.nonceTtlMs = nonceTtlMs;
    this.now = now;
    this.seen = new Map();
  }

  sign({ workerId, action, payload = {}, timestamp = this.now(), nonce = randomUUID() }) {
    const secret = this.#secret(workerId);
    const message = { workerId: String(workerId), action: String(action), timestamp, nonce: String(nonce), payload };
    return { ...message, signature: this.#mac(secret, message) };
  }

  verify(envelope) {
    if (!envelope || typeof envelope !== 'object') throw new Error('invalid worker envelope');
    const { workerId, action, timestamp, nonce, payload = {}, signature } = envelope;
    if (!workerId || !action || !nonce || !signature || !Number.isFinite(timestamp)) throw new Error('incomplete worker envelope');
    const now = this.now();
    this.#purge(now);
    if (Math.abs(now - timestamp) > this.maxClockSkewMs) throw new Error('worker envelope timestamp outside allowed skew');
    const replayKey = `${workerId}:${nonce}`;
    if (this.seen.has(replayKey)) throw new Error('worker envelope replay detected');
    const secret = this.#secret(workerId);
    const expected = this.#mac(secret, { workerId: String(workerId), action: String(action), timestamp, nonce: String(nonce), payload });
    const actual = Buffer.from(String(signature), 'hex');
    const wanted = Buffer.from(expected, 'hex');
    if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) throw new Error('invalid worker signature');
    this.seen.set(replayKey, now + this.nonceTtlMs);
    return { workerId: String(workerId), action: String(action), timestamp, nonce: String(nonce), payload: structuredClone(payload) };
  }

  #secret(workerId) {
    const secret = typeof this.secrets === 'function' ? this.secrets(String(workerId)) : this.secrets[String(workerId)];
    if (typeof secret !== 'string' || secret.length < 32) throw new Error(`worker secret unavailable or too short: ${workerId}`);
    return secret;
  }

  #mac(secret, message) {
    return createHmac('sha256', secret).update(stable(message)).digest('hex');
  }

  #purge(now) {
    for (const [key, expiresAt] of this.seen) if (expiresAt <= now) this.seen.delete(key);
  }
}

export class AuthenticatedCoordinator {
  constructor({ queue, authenticator }) {
    if (!queue || !authenticator) throw new Error('queue and authenticator are required');
    this.queue = queue;
    this.authenticator = authenticator;
  }

  async handle(envelope) {
    const request = this.authenticator.verify(envelope);
    const { workerId, action, payload } = request;
    switch (action) {
      case 'claim':
        return this.queue.claim({ id: workerId, capabilities: payload.capabilities ?? [] });
      case 'heartbeat':
        return this.queue.heartbeat(payload.missionId, workerId, payload.leaseToken);
      case 'complete':
        return this.queue.complete(payload.missionId, workerId, payload.leaseToken, payload.result ?? null);
      case 'fail':
        return this.queue.fail(payload.missionId, workerId, payload.leaseToken, payload.error);
      default:
        throw new Error(`unsupported worker action: ${action}`);
    }
  }
}
