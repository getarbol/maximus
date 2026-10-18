/**
 * Byte streams held to the length their headers declare.
 */

/**
 * Passes a byte stream through only while it keeps its declared length: a chunk that is not bytes,
 * a byte beyond `length` or an end before it errors the stream, so a body never carries more or
 * fewer bytes than its headers say.
 */
export function exactLength(stream: ReadableStream<Uint8Array>, length: number): ReadableStream<Uint8Array> {
  let received = 0;
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (!(chunk instanceof Uint8Array)) {
          throw new TypeError('A byte stream carried a chunk that is not bytes.');
        }
        received += chunk.byteLength;
        if (received > length) {
          throw new TypeError('A byte stream exceeds its declared length.');
        }
        controller.enqueue(chunk);
      },
      flush() {
        if (received !== length) {
          throw new TypeError('A byte stream ended before its declared length.');
        }
      },
    })
  );
}
