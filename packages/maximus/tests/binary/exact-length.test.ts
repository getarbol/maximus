/**
 * Byte streams held to their declared length: exactly that many bytes pass through, and a longer,
 * shorter or non-byte stream errors instead of reaching its reader whole.
 */
import { expect, it, vi } from 'vite-plus/test';

import { exactLength } from '../../src/internal/exact-length.ts';

/** A closed stream of the given chunks, whatever their kind. */
function chunks(...parts: unknown[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(part as Uint8Array);
      }
      controller.close();
    },
  });
}
/** Every byte a stream yields, in order. */
async function collect(stream: ReadableStream<Uint8Array>): Promise<number[]> {
  return [...new Uint8Array(await new Response(stream).arrayBuffer())];
}

it('passes a stream of exactly its declared length, chunk by chunk', async () => {
  await expect(collect(exactLength(chunks(new Uint8Array([1, 2]), new Uint8Array([3])), 3))).resolves.toEqual(
    [1, 2, 3]
  );
});

it('passes an empty stream declared empty', async () => {
  await expect(collect(exactLength(chunks(), 0))).resolves.toEqual([]);
});

it('errors a stream that carries a byte beyond its length, and cancels the rest of its source', async () => {
  const cancel = vi.fn();
  // The source stays open: the extra byte arrives before it would end.
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2]));
      controller.enqueue(new Uint8Array([3]));
    },
    cancel,
  });
  const refusal = new TypeError('A byte stream exceeds its declared length.');
  await expect(collect(exactLength(source, 2))).rejects.toThrow(refusal);
  expect(cancel).toHaveBeenCalledWith(refusal);
});

it('errors a stream that ends before its declared length', async () => {
  await expect(collect(exactLength(chunks(new Uint8Array([1, 2])), 3))).rejects.toThrow(
    new TypeError('A byte stream ended before its declared length.')
  );
});

it.each([
  ['text', 'hello'],
  ['an ArrayBuffer', new ArrayBuffer(1)],
  ['a list of numbers', [1, 2]],
])('errors a stream that carries %s instead of bytes', async (_name, chunk) => {
  await expect(collect(exactLength(chunks(chunk), 2))).rejects.toThrow(
    new TypeError('A byte stream carried a chunk that is not bytes.')
  );
});
