import { defineHandler, PageQueryFields } from '@arbol-ai/maximus';

import { NotePageSchema } from '#src/notes.ts';

/** GET /api/v1/notes, also the MCP tool list_notes: the organization's notes, a page at a time. */
export default defineHandler(
  async ({ input, notes, fail }) => {
    const page = await notes.list(input);
    if (!page) {
      return fail('INVALID_CURSOR');
    }
    return page;
  },
  {
    description:
      "List the organization's notes, newest first, a page at a time. To read the next page, pass this page's pageInfo.nextCursor as cursor.",
    input: PageQueryFields,
    output: NotePageSchema,
    failures: ['INVALID_CURSOR'],
    mcp: { name: 'list_notes' },
  }
);
