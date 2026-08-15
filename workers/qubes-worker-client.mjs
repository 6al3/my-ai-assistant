import { randomUUID } from 'node:crypto';
import { FrameDecoder, encodeFrame } from './qubes-stdio-transport.mjs';

function decodeSingle(bytes, maxFrameBytes) {
  const decoder = new FrameDecoder({ maxFrameBytes });
  const frames = decoder.push(bytes);
  decoder.finish();
  if (frames.length !== 1) throw new Error(`expected exactly one response frame, received ${frames.length}`);
  return frames[0];
}

export class QubesWorkerClient {
  constructor({ signer, exchange, maxFrameBytes = 1024 * 1024, requestIdFactory = () => randomUUID() } = {}) {
    if (!signer?.sign) throw new Error('signer.sign is required');
    if (typeof exchange !== 'function') throw new Error('exchange(frameBytes) is required');
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1) throw new Error('maxFrameBytes must be a positive integer');
    if (typeof requestIdFactory !== 'function') throw new Error('requestIdFactory must be a function');
    this.signer = signer;
    this.exchange = exchange;
    this.maxFrameBytes = maxFrameBytes;
    this.requestIdFactory = requestIdFactory;
  }

  async request(action, payload = {}) {
    if (!action) throw new Error('action is required');
    const envelope = await this.signer.sign({ action, payload });
    const requestFrame = encodeFrame(envelope, { maxFrameBytes: this.maxFrameBytes });
    const responseBytes = await this.exchange(requestFrame);
    if (!Buffer.isBuffer(responseBytes) && !(responseBytes instanceof Uint8Array)) throw new Error('exchange must return response bytes');
    const response = decodeSingle(Buffer.from(responseBytes), this.maxFrameBytes);
    if (response.ok !== true) {
      const code = response?.error?.code ?? 'REMOTE_REJECTED';
      const message = response?.error?.message ?? 'coordinator rejected request';
      const error = new Error(message);
      error.code = code;
      throw error;
    }
    return response.result ?? null;
  }

  async mutation(action, payload = {}, { requestId = this.requestIdFactory() } = {}) {
    if (!requestId || typeof requestId !== 'string') throw new Error('requestId must be a non-empty string');
    try {
      const result = await this.request(action, { ...payload, requestId });
      return { requestId, result };
    } catch (error) {
      error.requestId = requestId;
      throw error;
    }
  }

  requestStatus(requestId) { return this.request('request-status', { requestId }); }
  claim(options) { return this.mutation('claim', {}, options); }
  heartbeat(mission, options) { return this.mutation('heartbeat', { missionId: mission.id, leaseToken: mission.leaseToken }, options); }
  complete(mission, result = null, options) { return this.mutation('complete', { missionId: mission.id, leaseToken: mission.leaseToken, result }, options); }
  fail(mission, error, options) { return this.mutation('fail', { missionId: mission.id, leaseToken: mission.leaseToken, error: String(error ?? 'unknown failure') }, options); }
}
