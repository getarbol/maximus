/**
 * Type tests of the list contract: `Page`, `PageInfo` and `PageQuery`, the page name a list output needs,
 * the defaults a list handler receives already applied, and the page `cutPage` answers.
 */
import { Page, PageQueryFields, cutPage, defineErrors, maximus, ok, t } from '../src/index.ts';
import type { PageInfo, PageInfoSchema, PageOrder, PageQuery, Static } from '../src/index.ts';
import { inputSchema } from '../src/schemas.ts';

const record = t.Object({ recordId: t.String() }, { additionalProperties: false });
const RecordPage = Page(record, { $id: 'RecordPage' });
// @ts-expect-error A list output names its own component.
Page(record);
// @ts-expect-error A list output names its own component.
Page(record, {});

const info: PageInfo = { hasNextPage: false, hasPreviousPage: false, nextCursor: null, previousCursor: null };
const page: Page<Static<typeof record>> = { object: 'list', data: [{ recordId: 'r' }], pageInfo: info };
// The schema's static type is the generic page of its item.
const typed: Static<typeof RecordPage> = page;
const shared: Static<typeof PageInfoSchema> = info;
// @ts-expect-error A page always carries its navigation.
const unnavigable: Page<Static<typeof record>> = { object: 'list', data: [] };
// @ts-expect-error The discriminator is the literal "list".
const misnamed: Static<typeof RecordPage> = { ...page, object: 'page' };
// @ts-expect-error A cursor is a string or null, never absent.
const absent: PageInfo = { hasNextPage: false, hasPreviousPage: false, nextCursor: null };

// A handler receives the query with its defaults applied.
const query: PageQuery = { direction: 'backward', limit: 10 };
// @ts-expect-error A list is walked forward or backward.
const sideways: PageQuery = { direction: 'sideways', limit: 10 };
// @ts-expect-error The defaults are applied before the handler runs.
const undefaulted: PageQuery = { cursor: 'c' };

const base = maximus<Record<string, never>>({
  name: 'demo',
  namespace: 'demo',
  title: 'Demo',
  version: '1',
  origin: 'https://demo.test',
  tokens: { issuer: 'https://issuer.example.test/', audience: 'demo' },
  errors: defineErrors({}),
  rpc: { callers: [] },
});
const definition = {
  scope: 'demo:records:read',
  title: 'List records',
  description: 'List the records.',
  effect: 'read' as const,
  input: inputSchema(t.Object(PageQueryFields, { additionalProperties: false })),
  output: RecordPage,
};
base.operation('listRecords', definition, async (_context, input) => {
  const limit: number = input.limit;
  const cursor: string | undefined = input.cursor;
  return ok({ object: 'list' as const, data: [{ recordId: `${limit}:${cursor}` }], pageInfo: info });
});
// @ts-expect-error A list handler answers with the page's navigation.
base.operation('withoutInfo', definition, async () => ok({ object: 'list' as const, data: [] }));

// A page cut from a list holds its items, or is undefined for a cursor the list did not make.
const byId: PageOrder<Static<typeof record>> = { key: ({ recordId }) => [recordId] };
const cut: Page<Static<typeof record>> | undefined = cutPage([{ recordId: 'r' }], byId, query);
// @ts-expect-error A refused cursor answers no page.
const certain: Page<Static<typeof record>> = cutPage([{ recordId: 'r' }], byId, query);
// @ts-expect-error A key is a list of the values an item sorts by.
const unlisted: PageOrder<Static<typeof record>> = { key: ({ recordId }) => recordId };
// @ts-expect-error A list is ordered ascending or descending.
const shuffled: PageOrder<Static<typeof record>> = { key: ({ recordId }) => [recordId], order: 'random' };

void [
  typed,
  shared,
  unnavigable,
  misnamed,
  absent,
  query,
  sideways,
  undefaulted,
  cut,
  certain,
  unlisted,
  shuffled,
];
