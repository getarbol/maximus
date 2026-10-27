import { defineHandler, PageQueryFields } from '@arbol-ai/maximus';

import { NotePageSchema } from '../../../src/notes.ts';

/** GET /api/v1/notes, also the MCP tool list_notes: the organization's notes, newest first, a page at a time. */
export default defineHandler(
  async ({ input, notes, fail }) => (await notes.page(input)) ?? fail('INVALID_CURSOR'),
  {
    description: "List the organization's notes, newest first. Pass pageInfo.nextCursor as cursor for more.",
    input: PageQueryFields,
    output: NotePageSchema,
    failures: ['INVALID_CURSOR'],
    mcp: { name: 'list_notes' },
  }
);
