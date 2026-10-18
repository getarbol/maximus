/** Runtime-free descriptor for a validated HTTP attachment, never a JSON or RPC value. */
import { Kind, Type } from '@sinclair/typebox';

/** A file an HTTP operation answers with: its bytes, media type, filename and exact length. */
export interface Attachment {
  /** The file's bytes, as a buffer or an unlocked stream. */
  body: ReadableStream<Uint8Array> | Uint8Array;
  /** The media type sent as `content-type`: `type/subtype`, at most 255 characters. */
  contentType: string;
  /** The name sent in `content-disposition`: 1 to 512 characters, without control characters or slashes. */
  filename: string;
  /** Exact body length, checked before headers and while streaming. */
  byteLength: number;
}
/** The output of an operation that answers with a file (`http.response: 'attachment'`). */
export const AttachmentOutputSchema = Type.Unsafe<Attachment>({
  [Kind]: 'HttpAttachment',
  type: 'string',
  format: 'binary',
  description: 'Authenticated attachment bytes with validated media type, filename and exact length.',
});
