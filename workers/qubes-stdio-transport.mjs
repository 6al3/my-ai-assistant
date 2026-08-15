import { once } from 'node:events';

const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;

export function encodeFrame(value, { maxFrameBytes = DEFAULT_MAX_FRAME_BYTES } = {}) {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  if (payload.length > maxFrameBytes) throw new Error('transport frame exceeds maximum size');
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

export class FrameDecoder {
  constructor({ maxFrameBytes = DEFAULT_MAX_FRAME_BYTES } = {}) {
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1) throw new Error('maxFrameBytes must be a positive integer');
    this.maxFrameBytes = maxFrameBytes;
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    const frames = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (length > this.maxFrameBytes) throw new Error('transport frame exceeds maximum size');
      if (this.buffer.length < 4 + length) break;
      const body = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      let value;
      try { value = JSON.parse(body.toString('utf8')); }
      catch { throw new Error('invalid transport JSON frame'); }
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('transport frame must contain a JSON object');
      frames.push(value);
    }
    return frames;
  }

  finish() {
    if (this.buffer.length !== 0) throw new Error('truncated transport frame');
  }
}

async function writeAll(stream, bytes) {
  if (!stream.write(bytes)) await once(stream, 'drain');
}

function safeError(error) {
  const message = error instanceof Error ? error.message : String(error ?? 'unknown transport error');
  return { code: 'REQUEST_REJECTED', message };
}

export class QubesStdioCoordinatorTransport {
  constructor({ coordinator, maxFrameBytes = DEFAULT_MAX_FRAME_BYTES } = {}) {
    if (!coordinator?.handle) throw new Error('coordinator.handle is required');
    this.coordinator = coordinator;
    this.maxFrameBytes = maxFrameBytes;
  }

  async serve({ input = process.stdin, output = process.stdout } = {}) {
    const decoder = new FrameDecoder({ maxFrameBytes: this.maxFrameBytes });
    let requests = 0;
    for await (const chunk of input) {
      for (const envelope of decoder.push(chunk)) {
        requests += 1;
        let response;
        try {
          const result = await this.coordinator.handle(envelope);
          response = { ok: true, result: result ?? null };
        } catch (error) {
          response = { ok: false, error: safeError(error) };
        }
        await writeAll(output, encodeFrame(response, { maxFrameBytes: this.maxFrameBytes }));
      }
    }
    decoder.finish();
    return { requests };
  }
}

export const QUBES_STDIO_TRANSPORT_LIMITS = Object.freeze({
  maxFrameBytes: DEFAULT_MAX_FRAME_BYTES,
  networkListener: false,
  framing: 'uint32be-length-prefixed-json'
});
