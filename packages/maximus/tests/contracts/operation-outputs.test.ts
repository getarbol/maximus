/**
 * The output boundary of the one execution path: an attachment answered unchanged only when its bytes,
 * exact length, media type and filename hold within the operation's limit, and a JSON output only within its
 * limit in UTF-8 bytes. Anything else becomes INTERNAL_ERROR, reported by its safe description and never
 * with the output itself.
 */
import { expect, it, vi } from 'vite-plus/test';

import { executeOperation } from '../../src/execution.ts';
import { AttachmentOutputSchema, defineErrors, maximus, ok, standardErrors, t } from '../../src/index.ts';
import type { Attachment } from '../../src/index.ts';

const strict = { additionalProperties: false } as const;
const principal = {
  actorId: 'person',
  actorKind: 'user' as const,
  organizationId: 'org_1234567890abcdef',
  requestId: '0190c6d4-8f3e-4a6b-9c1d-2e3f4a5b6c7d',
};
const bytes = (length: number) => new Uint8Array(length).fill(65);
/** The files the download answers, by id: one valid, the others each wrong in one way. */
const files: Record<string, unknown> = {
  valid: { body: bytes(5), contentType: 'text/plain', filename: 'notes.txt', byteLength: 5 },
  stream: {
    body: new ReadableStream({ start: (controller) => controller.close() }),
    contentType: 'application/pdf',
    filename: 'report.pdf',
    byteLength: 0,
  },
  shortBody: { body: bytes(5), contentType: 'text/plain', filename: 'notes.txt', byteLength: 6 },
  traversal: { body: bytes(5), contentType: 'text/plain', filename: '../SECRET_SENTINEL.txt', byteLength: 5 },
  mediaType: {
    body: bytes(5),
    contentType: 'text/plain; charset=utf-8',
    filename: 'notes.txt',
    byteLength: 5,
  },
  oversized: { body: bytes(32), contentType: 'text/plain', filename: 'notes.txt', byteLength: 32 },
  extraField: {
    body: bytes(5),
    contentType: 'text/plain',
    filename: 'notes.txt',
    byteLength: 5,
    path: '/srv',
  },
};
const app = maximus<Record<string, never>>({
  name: 'files',
  namespace: 'files',
  title: 'Files',
  version: '1',
  origin: 'https://files.example.test',
  tokens: { issuer: 'https://issuer.example.test/', audience: 'https://files.example.test' },
  errors: defineErrors({}),
  rpc: { callers: [] },
})
  .operation(
    'downloadFile',
    {
      title: 'Download a file',
      description: 'Answer one file.',
      effect: 'read',
      scope: 'files:files:read',
      input: t.Object({ fileId: t.String() }, strict),
      output: AttachmentOutputSchema,
      http: { method: 'GET', path: '/v1/files/{fileId}', response: 'attachment' },
      maxOutputBytes: 16,
    },
    async (_context, { fileId }) => ok(files[fileId] as Attachment)
  )
  .operation(
    'readNote',
    {
      title: 'Read a note',
      description: 'Answer the note text.',
      effect: 'read',
      scope: 'files:notes:read',
      input: t.Object({ text: t.String() }, strict),
      output: t.Object({ text: t.String() }, strict),
      http: { method: 'POST', path: '/v1/notes/read' },
      maxOutputBytes: 64,
    },
    async (_context, input) => ok(input)
  )
  .build();

/** Runs an operation as the principal, with every console.error report it makes. */
async function run(name: 'downloadFile' | 'readNote', input: object) {
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const result = await executeOperation(app, app.operations[name], {}, principal, input);
    return { result, reports: log.mock.calls.map(([line]) => String(line)) };
  } finally {
    log.mockRestore();
  }
}

it('answers a valid attachment unchanged, buffered or streamed, within its limit', async () => {
  for (const fileId of ['valid', 'stream']) {
    const { result, reports } = await run('downloadFile', { fileId });
    expect(result, fileId).toEqual({ ok: true, value: files[fileId] });
    expect(result.ok && result.value, fileId).toBe(files[fileId]);
    expect(reports, fileId).toEqual([]);
  }
});

it('refuses an attachment whose length, filename, media type, size or fields do not hold, reporting no detail', async () => {
  for (const fileId of ['shortBody', 'traversal', 'mediaType', 'oversized', 'extraField']) {
    const { result, reports } = await run('downloadFile', { fileId });
    expect(result, fileId).toEqual({ ok: false, error: standardErrors.internal.create() });
    expect(
      reports.map((line) => JSON.parse(line)),
      fileId
    ).toMatchObject([
      {
        event: 'maximus.unexpected',
        surface: 'operation',
        requestId: principal.requestId,
        name: 'TypeError',
      },
    ]);
    expect(reports.join(''), fileId).not.toMatch(/SENTINEL|srv|charset/);
  }
});

it('holds a JSON output to its limit in UTF-8 bytes, not characters', async () => {
  // 28 two-byte characters: 39 characters of JSON, 67 bytes, beyond the limit of 64.
  expect((await run('readNote', { text: 'e'.repeat(28) })).result).toEqual({
    ok: true,
    value: { text: 'e'.repeat(28) },
  });
  const { result, reports } = await run('readNote', { text: 'é'.repeat(28) });
  expect(result).toEqual({ ok: false, error: standardErrors.internal.create() });
  expect(reports).toHaveLength(1);
  expect(reports.join('')).not.toContain('é');
});
