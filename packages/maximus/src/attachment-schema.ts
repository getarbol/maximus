/**
 * The file an HTTP operation answers with and its output schema, with nothing that needs a runtime. An
 * attachment is never a JSON or RPC value.
 */
import { Kind, Type } from '@sinclair/typebox';

/** A file an HTTP operation answers with: its bytes, media type, filename and exact length. */
export interface Attachment {
  /** The file's bytes, as a buffer or an unlocked stream. */
  body: ReadableStream<Uint8Array> | Uint8Array;
  /** The media type sent as `content-type`: `type/subtype`, at most 255 characters. */
  contentType: string;
  /**
   * The name sent in `content-disposition`: 1 to 512 characters, without control characters, slashes or
   * backslashes.
   */
  filename: string;
  /**
   * The body's exact length in bytes, sent as `content-length`: checked against a buffer before anything is
   * sent, and held to while a stream is sent. At most the operation's `maxOutputBytes`.
   */
  byteLength: number;
}
/** The output of an operation that answers with a file (`http.response: 'attachment'`). */
export const AttachmentOutputSchema = Type.Unsafe<Attachment>({
  [Kind]: 'HttpAttachment',
  type: 'string',
  format: 'binary',
  description: 'Authenticated attachment bytes with validated media type, filename and exact length.',
});
