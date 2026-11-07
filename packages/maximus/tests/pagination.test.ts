/**
 * The list contract: the named response metadata, PageInfo and each Page, the query defaults on the wire,
 * page limits with their own maximum and default, page names, and the pages `cutPage` cuts from a list held
 * whole: opaque cursors that are places between items, never offsets.
 */
import { describe, expect, it } from 'vite-plus/test';

import {
  Page,
  PageInfoSchema,
  PageQueryFields,
  createHttpHandler,
  createOpenApi,
  cursorKey,
  cutPage,
  defineErrors,
  maximus,
  ok,
  pageLimit,
  parseInput,
  t,
} from '../src/index.ts';
import type { PageOrder, PageQuery } from '../src/index.ts';
import { inputSchema } from '../src/schemas.ts';

// Every service shares the response metadata and the list contract, so the document names them once
// and each generated SDK has one type for each.

const claims = {
  sub: 'client@clients',
  client_id: 'client',
  org_id: 'org_1234567890abcdef',
  scope: 'fixture:records:read fixture:notes:read',
};
const record = t.Object({ recordId: t.String() }, { additionalProperties: false });
const note = t.Object({ noteId: t.String(), text: t.String() }, { additionalProperties: false });
const RecordPage = Page(record, { $id: 'RecordPage' });
const NotePage = Page(note, { $id: 'NotePage' });
const words = { title: 'Records', description: 'The organization records.' };

function application() {
  return maximus<Record<string, never>>({
    name: 'fixture',
    namespace: 'fixture',
    title: 'Fixture',
    version: '1',
    origin: 'https://fixture.example.test',
    tokens: { issuer: 'https://issuer.example.test/', audience: 'https://fixture.example.test' },
    errors: defineErrors({}),
    rpc: { callers: [] },
    telemetry: { enabled: false },
  })
    .operation(
      'listRecords',
      {
        ...words,
        scope: 'fixture:records:read',
        effect: 'read',
        input: inputSchema(
          t.Object({ ...PageQueryFields, status: t.Optional(t.String()) }, { additionalProperties: false })
        ),
        output: RecordPage,
        http: { method: 'GET', path: '/v1/records' },
        actorKinds: ['user', 'service'],
      },
      async (_context, input) =>
        ok({
          object: 'list' as const,
          data: [{ recordId: `${input.direction}:${input.limit}:${input.cursor ?? 'first'}` }],
          pageInfo: { hasNextPage: true, hasPreviousPage: false, nextCursor: 'next', previousCursor: null },
        })
    )
    .operation(
      'listNotes',
      {
        ...words,
        effect: 'read',
        scope: 'fixture:notes:read',
        input: inputSchema(t.Object(PageQueryFields, { additionalProperties: false })),
        output: NotePage,
        http: { method: 'GET', path: '/v1/notes' },
        actorKinds: ['user', 'service'],
      },
      async () =>
        ok({
          object: 'list' as const,
          data: [],
          pageInfo: { hasNextPage: false, hasPreviousPage: false, nextCursor: null, previousCursor: null },
        })
    )
    .operation(
      'getRecord',
      {
        ...words,
        scope: 'fixture:records:read',
        effect: 'read',
        input: record,
        output: record,
        http: { method: 'GET', path: '/v1/records/{recordId}' },
        actorKinds: ['user', 'service'],
      },
      async (_context, input) => ok(input)
    )
    .build();
}

type Json = Record<string, unknown>;
interface Document {
  paths: Record<string, Record<string, Json>>;
  components: { schemas: Record<string, Json> };
}

function operationsOf(document: Document): Json[] {
  return Object.values(document.paths).flatMap((methods) => Object.values(methods));
}

function operationNamed(document: Document, name: string): Json {
  const found = operationsOf(document).find((operation) => operation.operationId === name);
  if (!found) {
    throw new Error(`No operation ${name}`);
  }
  return found;
}

/** The success envelope an operation's answer refers to. */
function successSchema(document: Document, operation: Json): { properties: Record<string, Json> } {
  const responses = operation.responses as Record<
    string,
    { content: Record<string, { schema: { $ref: string } }> }
  >;
  const reference = responses['200']?.content['application/json']?.schema.$ref ?? '';
  return document.components.schemas[reference.slice('#/components/schemas/'.length)] as never;
}

/** How many times a property name is declared anywhere in the document. */
function declarations(document: Document, property: string): number {
  return JSON.stringify(document).split(`"${property}":`).length - 1;
}

async function documents(): Promise<[string, Document][]> {
  const app = application();
  const served = await createHttpHandler(app)(new Request('https://fixture.example.test/openapi.json'), {});
  return [
    ['built', createOpenApi(app) as unknown as Document],
    ['served', (await served.json()) as Document],
  ];
}

const pageInfoComponent = {
  type: 'object',
  properties: {
    hasNextPage: { type: 'boolean', description: 'Whether a later page exists in the current ordering.' },
    hasPreviousPage: {
      type: 'boolean',
      description: 'Whether an earlier page exists in the current ordering.',
    },
    nextCursor: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      description: 'Opaque cursor for the next page, or null when there is none.',
    },
    previousCursor: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      description: 'Opaque cursor for the previous page, or null when there is none.',
    },
  },
  required: ['hasNextPage', 'hasPreviousPage', 'nextCursor', 'previousCursor'],
  additionalProperties: false,
};

function pageComponent(item: Json) {
  return {
    type: 'object',
    properties: {
      data: {
        type: 'array',
        items: item,
        description: 'Items admitted by this resource contract within the verified organization.',
      },
      object: { type: 'string', const: 'list', description: 'Discriminator for a resource list response.' },
      pageInfo: {
        $ref: '#/components/schemas/PageInfo',
        description: 'Opaque navigation cursors for this page’s stable keyset order.',
      },
    },
    required: ['data', 'object', 'pageInfo'],
    additionalProperties: false,
  };
}

it('names the response metadata once and every success and failure envelope refers to it', async () => {
  for (const [source, document] of await documents()) {
    expect(document.components.schemas.ResponseMetadata, source).toStrictEqual({
      type: 'object',
      description: 'What every answer carries besides its data or error.',
      properties: {
        requestId: {
          type: 'string',
          description: 'Request correlation identifier, also sent as X-Request-Id.',
        },
      },
      required: ['requestId'],
      additionalProperties: false,
    });
    expect(declarations(document, 'requestId'), source).toBe(1);
    const metadata = { $ref: '#/components/schemas/ResponseMetadata' };
    for (const operation of operationsOf(document)) {
      expect(successSchema(document, operation).properties.metadata, source).toStrictEqual(metadata);
    }
    const envelopes = Object.entries(document.components.schemas).filter(([name]) =>
      /(Response|Error)$/.test(name)
    );
    expect(envelopes.length, source).toBeGreaterThan(2);
    for (const [name, envelope] of envelopes) {
      expect((envelope as { properties: Json }).properties.metadata, `${source} ${name}`).toStrictEqual(
        metadata
      );
    }
    expect(JSON.stringify(document), source).not.toContain('"$id"');
  }
});

it('names PageInfo once and each list page by its own name', async () => {
  for (const [source, document] of await documents()) {
    const names = Object.keys(document.components.schemas);
    expect(names, source).toEqual(
      expect.arrayContaining(['NotePage', 'NotePageResponse', 'PageInfo', 'RecordPage', 'RecordPageResponse'])
    );
    // Each list answers its own page's envelope, named after the page.
    expect(names.filter((name) => name.endsWith('PageResponse')).toSorted(), source).toEqual([
      'NotePageResponse',
      'RecordPageResponse',
    ]);
    expect(document.components.schemas.PageInfo, source).toStrictEqual(pageInfoComponent);
    expect(declarations(document, 'hasNextPage'), source).toBe(1);
    expect(document.components.schemas.RecordPage, source).toStrictEqual(
      pageComponent(JSON.parse(JSON.stringify(record)))
    );
    expect(document.components.schemas.NotePage, source).toStrictEqual(
      pageComponent(JSON.parse(JSON.stringify(note)))
    );
    expect(
      successSchema(document, operationNamed(document, 'listRecords')).properties.data,
      source
    ).toStrictEqual({
      $ref: '#/components/schemas/RecordPage',
    });
    expect(
      successSchema(document, operationNamed(document, 'listNotes')).properties.data,
      source
    ).toStrictEqual({
      $ref: '#/components/schemas/NotePage',
    });
    // The query fields stay inline parameters, each with its constraints and default, and its description
    // also on the parameter, where generators read it.
    expect(operationNamed(document, 'listRecords').parameters, source).toStrictEqual([
      {
        name: 'cursor',
        in: 'query',
        required: false,
        description: 'Opaque cursor returned by pageInfo; omit it to request the first page.',
        schema: {
          type: 'string',
          description: 'Opaque cursor returned by pageInfo; omit it to request the first page.',
        },
      },
      {
        name: 'direction',
        in: 'query',
        required: false,
        description: 'Direction to traverse the stable keyset ordering from the supplied cursor.',
        schema: {
          anyOf: [
            { type: 'string', const: 'forward' },
            { type: 'string', const: 'backward' },
          ],
          description: 'Direction to traverse the stable keyset ordering from the supplied cursor.',
          default: 'forward',
        },
      },
      {
        name: 'limit',
        in: 'query',
        required: false,
        description:
          'Maximum items returned in one page. Defaults to 25; larger reads require another cursor.',
        schema: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description:
            'Maximum items returned in one page. Defaults to 25; larger reads require another cursor.',
          default: 25,
        },
      },
      {
        name: 'status',
        in: 'query',
        required: false,
        description: 'The status.',
        schema: { type: 'string' },
      },
    ]);
  }
});

it('serves the canonical list on the wire with its query defaults', async () => {
  const handle = createHttpHandler(application(), { verify: async () => claims });
  const read = (query: string) =>
    handle(
      new Request(`https://fixture.example.test/v1/records${query}`, {
        headers: { authorization: 'Bearer a.b.c' },
      }),
      {}
    );
  const first = await read('');
  expect(first.status).toBe(200);
  expect(await first.json()).toStrictEqual({
    success: true,
    data: {
      object: 'list',
      data: [{ recordId: 'forward:25:first' }],
      pageInfo: { hasNextPage: true, hasPreviousPage: false, nextCursor: 'next', previousCursor: null },
    },
    error: null,
    metadata: { requestId: first.headers.get('x-request-id') },
  });
  const back = await read('?cursor=abc&direction=backward&limit=10');
  expect(((await back.json()) as { data: { data: unknown } }).data.data).toStrictEqual([
    { recordId: 'backward:10:abc' },
  ]);
  for (const query of ['?limit=0', '?limit=101', '?limit=2.5', '?direction=sideways']) {
    expect((await read(query)).status, query).toBe(400);
  }
});

it('validates exactly the canonical page and page info', () => {
  const pageInfo = { hasNextPage: false, hasPreviousPage: true, nextCursor: null, previousCursor: 'p' };
  const page = { object: 'list', data: [{ recordId: 'r' }], pageInfo };
  expect(parseInput(RecordPage, page).ok).toBe(true);
  expect(parseInput(PageInfoSchema, pageInfo).ok).toBe(true);
  for (const invalid of [
    { ...page, object: 'page' },
    { ...page, total: 1 },
    { ...page, data: [{ noteId: 'n', text: '' }] },
    { object: 'list', data: [] },
    { ...page, pageInfo: { ...pageInfo, nextCursor: undefined } },
    { ...page, pageInfo: { ...pageInfo, startCursor: null } },
  ]) {
    expect(parseInput(RecordPage, invalid).ok).toBe(false);
  }
  const query: PageQuery = { direction: 'forward', limit: 25 };
  expect(parseInput(t.Object(PageQueryFields), query).ok).toBe(true);
});

it('builds a page limit with its own maximum and default', () => {
  expect(JSON.parse(JSON.stringify(pageLimit()))).toStrictEqual(
    JSON.parse(JSON.stringify(PageQueryFields.limit))
  );
  expect(JSON.parse(JSON.stringify(pageLimit({ maximum: 20 })))).toStrictEqual({
    type: 'integer',
    minimum: 1,
    maximum: 20,
    default: 20,
    description: 'Maximum items returned in one page. Defaults to 20; larger reads require another cursor.',
  });
  expect(pageLimit({ maximum: 500, default: 50 })).toMatchObject({ maximum: 500, default: 50 });
  for (const options of [{ maximum: 0 }, { maximum: 10, default: 11 }, { default: 0 }, { maximum: 2.5 }]) {
    expect(() => pageLimit(options), JSON.stringify(options)).toThrow(TypeError);
  }
});

it('refuses a page name that cannot be a public schema type', () => {
  for (const $id of ['', 'recordPage', 'Record-Page', 'Record Page', '#/components/schemas/RecordPage']) {
    expect(() => Page(record, { $id }), $id).toThrow(TypeError);
  }
});

it('keeps a reused page name with another shape as a second component', () => {
  // The reason each list needs its own name: the document cannot merge two different shapes.
  const app = maximus<Record<string, never>>({
    name: 'fixture',
    namespace: 'fixture',
    title: 'Fixture',
    version: '1',
    origin: 'https://fixture.example.test',
    tokens: { issuer: 'https://issuer.example.test/', audience: 'https://fixture.example.test' },
    errors: defineErrors({}),
    rpc: { callers: [] },
    telemetry: { enabled: false },
  })
    .operation(
      'listRecords',
      {
        ...words,
        scope: 'fixture:records:read',
        effect: 'read',
        input: t.Object(PageQueryFields, { additionalProperties: false }),
        output: Page(record, { $id: 'ItemPage' }),
        http: { method: 'GET', path: '/v1/records' },
      },
      async () => ok({ object: 'list' as const, data: [], pageInfo: onlyPage() })
    )
    .operation(
      'listNotes',
      {
        ...words,
        scope: 'fixture:notes:read',
        effect: 'read',
        input: t.Object(PageQueryFields, { additionalProperties: false }),
        output: Page(note, { $id: 'ItemPage' }),
        http: { method: 'GET', path: '/v1/notes' },
      },
      async () => ok({ object: 'list' as const, data: [], pageInfo: onlyPage() })
    )
    .build();
  const document = createOpenApi(app) as unknown as Document;
  expect(Object.keys(document.components.schemas)).toEqual(
    expect.arrayContaining(['ItemPage', 'ItemPage_2'])
  );
  // The second shape's answer cannot share the first's envelope, so it is named after its operation.
  expect(successSchema(document, operationNamed(document, 'listRecords')).properties.data).toStrictEqual({
    $ref: '#/components/schemas/ItemPage',
  });
  expect(successSchema(document, operationNamed(document, 'listNotes')).properties.data).toStrictEqual({
    $ref: '#/components/schemas/ItemPage_2',
  });
  expect(document.components.schemas).toHaveProperty('ListNotesResultResponse');
});

function onlyPage() {
  return { hasNextPage: false, hasPreviousPage: false, nextCursor: null, previousCursor: null };
}

describe('a page cut from a list held whole', () => {
  /** An item a list holds: its id and when it was created. */
  interface Row {
    id: string;
    at: string;
  }
  const BY_ID: PageOrder<Row> = { key: ({ id }) => [id] };
  const NEWEST_FIRST: PageOrder<Row> = { key: ({ at, id }) => [at, id], order: 'desc' };
  const rows = (...ids: string[]): Row[] => ids.map((id) => ({ id, at: '2026-11-07T00:00:00Z' }));
  const ids = (page: { data: Row[] } | undefined) => page?.data.map(({ id }) => id);
  const FIVE = rows('a', 'b', 'c', 'd', 'e');
  /** A page of `items` by id, two at a time unless the query says otherwise. */
  const cut = (items: Row[], query: Partial<PageQuery> = {}, ordering = BY_ID) =>
    cutPage(items, ordering, { direction: 'forward', limit: 2, ...query });

  it('walks a list forward and backward through every item once, each page in the list order', () => {
    const list = rows('g', 'c', 'a', 'f', 'b', 'e', 'd');
    for (const limit of [1, 2, 3, 7, 8]) {
      const forward: string[] = [];
      let cursor: string | undefined;
      for (let pages = 0; pages < 10; pages += 1) {
        const page = cut(list, { cursor, limit });
        forward.push(...(ids(page) ?? []));
        if (!page?.pageInfo.hasNextPage) {
          break;
        }
        cursor = page.pageInfo.nextCursor ?? undefined;
      }
      expect(forward, `forward ${limit}`).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
      const backward: string[] = [];
      cursor = undefined;
      for (let pages = 0; pages < 10; pages += 1) {
        const page = cut(list, { cursor, direction: 'backward', limit });
        backward.unshift(...(ids(page) ?? []));
        if (!page?.pageInfo.hasPreviousPage) {
          break;
        }
        cursor = page.pageInfo.previousCursor ?? undefined;
      }
      expect(backward, `backward ${limit}`).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
    }
  });

  it('names a cursor exactly when its page exists, and an empty list has one empty page', () => {
    const none = { hasNextPage: false, hasPreviousPage: false, nextCursor: null, previousCursor: null };
    expect(cut([])).toStrictEqual({ object: 'list', data: [], pageInfo: none });
    expect(cut(FIVE, { limit: 5 })?.pageInfo).toStrictEqual(none);
    const first = cut(FIVE);
    expect(first?.pageInfo).toMatchObject({
      hasNextPage: true,
      hasPreviousPage: false,
      previousCursor: null,
    });
    const last = cut(FIVE, { direction: 'backward' });
    expect(ids(last)).toEqual(['d', 'e']);
    expect(last?.pageInfo).toMatchObject({ hasNextPage: false, hasPreviousPage: true, nextCursor: null });
  });

  it("returns to the page it came from: a page's cursor read the other way answers that page again", () => {
    const first = cut(FIVE);
    const second = cut(FIVE, { cursor: first?.pageInfo.nextCursor ?? '' });
    expect(ids(second)).toEqual(['c', 'd']);
    expect(cut(FIVE, { direction: 'backward', cursor: second?.pageInfo.previousCursor ?? '' })).toEqual(
      first
    );
    expect(cut(FIVE, { direction: 'backward', cursor: first?.pageInfo.nextCursor ?? '' })).toEqual(first);
  });

  it('keeps a cursor valid while items come and go, the one it names included', () => {
    const cursor = cut(FIVE)?.pageInfo.nextCursor ?? '';
    // `b`, the page's last item, is gone, and `bb` arrived right after it.
    expect(ids(cut(rows('a', 'bb', 'c', 'd'), { cursor }))).toEqual(['bb', 'c']);
    expect(ids(cut(rows('a', 'c', 'd'), { cursor, direction: 'backward' }))).toEqual(['a']);
  });

  it('answers an empty page past an end the list has since moved, still walkable back', () => {
    const cursor = cut(FIVE, { limit: 4 })?.pageInfo.nextCursor ?? '';
    const shorter = rows('a', 'b', 'c', 'd');
    const empty = cut(shorter, { cursor });
    expect(empty?.data).toEqual([]);
    expect(empty?.pageInfo).toStrictEqual({
      hasNextPage: false,
      hasPreviousPage: true,
      nextCursor: null,
      previousCursor: cursor,
    });
    expect(ids(cut(shorter, { cursor, direction: 'backward' }))).toEqual(['c', 'd']);
  });

  it('orders by every part of the key, ascending or descending, with ties broken by the later parts', () => {
    const list = [
      { id: 'b', at: '2026-11-01' },
      { id: 'a', at: '2026-11-02' },
      { id: 'c', at: '2026-11-01' },
    ];
    expect(ids(cut(list, { limit: 3 }, NEWEST_FIRST))).toEqual(['a', 'c', 'b']);
    const first = cut(list, { limit: 2 }, { ...NEWEST_FIRST, order: 'asc' });
    expect(ids(first)).toEqual(['b', 'c']);
    expect(
      ids(
        cut(list, { limit: 2, cursor: first?.pageInfo.nextCursor ?? '' }, { ...NEWEST_FIRST, order: 'asc' })
      )
    ).toEqual(['a']);
    const newest = cut(list, { limit: 1 }, NEWEST_FIRST);
    expect(ids(cut(list, { cursor: newest?.pageInfo.nextCursor ?? '' }, NEWEST_FIRST))).toEqual(['c', 'b']);
  });

  it('carries any text in an opaque cursor, and names its key to the service that made it', () => {
    const odd = rows('año', 'z', '日本 😀 ?&=/+', 'ñandú');
    const first = cut(odd);
    expect(ids(first)).toEqual(['año', 'z']);
    const cursor = first?.pageInfo.nextCursor ?? '';
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(cursor).not.toContain('z');
    expect(cursorKey(cursor)).toEqual(['z']);
    expect(ids(cut(odd, { cursor }))).toEqual(['ñandú', '日本 😀 ?&=/+']);
  });

  it('refuses a cursor it did not make, never reading it as a fresh start', () => {
    const encoded = (value: unknown) =>
      btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replace(/[=]+$/, '');
    for (const cursor of [
      '',
      'not a cursor',
      '====',
      btoa('plain text'),
      encoded({ after: 'a' }),
      encoded(['after']),
      encoded(['around', 'a']),
      encoded(['after', 7]),
      encoded(['after', 'a', 'b']),
      encoded(['after', 'a'.repeat(4000)]),
      btoa(String.fromCodePoint(0xff, 0xfe, 0xfd)),
    ]) {
      expect(cut(FIVE, { cursor }), cursor).toBeUndefined();
      expect(cursorKey(cursor) === undefined || cursorKey(cursor)?.length !== 1, cursor).toBe(true);
    }
    // A key of the right length is read whatever its value: a place before every item.
    expect(ids(cut(FIVE, { cursor: encoded(['after', '0']) }))).toEqual(['a', 'b']);
    // An empty list has no key to compare a cursor with: its one page is empty.
    expect(cut([], { cursor: encoded(['after', 'a', 'b']) })?.data).toEqual([]);
  });
});
