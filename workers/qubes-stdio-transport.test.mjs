import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { encodeFrame, FrameDecoder, QubesStdioCoordinatorTransport } from './qubes-stdio-transport.mjs';

function decodeAll(bytes, maxFrameBytes) {
  const decoder = new FrameDecoder({ maxFrameBytes });
  const out = decoder.push(bytes);
  decoder.finish();
  return out;
}

test('length-prefixed decoder survives arbitrary chunk boundaries', () => {
  const encoded = Buffer.concat([encodeFrame({ a: 1 }), encodeFrame({ b: 'two' })]);
  const decoder = new FrameDecoder();
  const frames = [];
  for (const byte of encoded) frames.push(...decoder.push(Buffer.from([byte])));
  decoder.finish();
  assert.deepEqual(frames, [{ a: 1 }, { b: 'two' }]);
});

test('decoder rejects oversized and truncated frames', () => {
  assert.throws(() => encodeFrame({ data: 'x'.repeat(100) }, { maxFrameBytes: 16 }), /exceeds maximum/);
  const decoder = new FrameDecoder({ maxFrameBytes: 32 });
  decoder.push(Buffer.from([0, 0, 0, 5, 123]));
  assert.throws(() => decoder.finish(), /truncated/);
});

test('coordinator transport handles sequential requests without a network listener', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const outputChunks = [];
  output.on('data', chunk => outputChunks.push(Buffer.from(chunk)));
  const seen = [];
  const transport = new QubesStdioCoordinatorTransport({ coordinator: { async handle(envelope) { seen.push(envelope); return { accepted: envelope.id }; } } });
  const serving = transport.serve({ input, output });
  input.end(Buffer.concat([encodeFrame({ id: 1 }), encodeFrame({ id: 2 })]));
  const result = await serving;
  assert.equal(result.requests, 2);
  assert.deepEqual(seen, [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(decodeAll(Buffer.concat(outputChunks)), [
    { ok: true, result: { accepted: 1 } },
    { ok: true, result: { accepted: 2 } }
  ]);
});

test('request failure is isolated and does not kill the transport session', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks = [];
  output.on('data', chunk => chunks.push(Buffer.from(chunk)));
  let calls = 0;
  const transport = new QubesStdioCoordinatorTransport({ coordinator: { async handle(envelope) {
    calls += 1;
    if (envelope.fail) throw new Error('rejected by policy');
    return { ok: envelope.id };
  } } });
  const serving = transport.serve({ input, output });
  input.end(Buffer.concat([encodeFrame({ fail: true }), encodeFrame({ id: 7 })]));
  await serving;
  const responses = decodeAll(Buffer.concat(chunks));
  assert.equal(calls, 2);
  assert.deepEqual(responses[0], { ok: false, error: { code: 'REQUEST_REJECTED', message: 'rejected by policy' } });
  assert.deepEqual(responses[1], { ok: true, result: { ok: 7 } });
});

test('invalid JSON and non-object frames are rejected at boundary', () => {
  const invalid = Buffer.alloc(5); invalid.writeUInt32BE(1, 0); invalid[4] = 0x7b;
  const decoder = new FrameDecoder();
  assert.throws(() => decoder.push(invalid), /invalid transport JSON/);
  assert.throws(() => decodeAll(encodeFrame(['not-object'])), /must contain a JSON object/);
});
