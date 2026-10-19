/**
 * Type tests of input codecs and readers: a field a codec declares is sent as its source and received
 * decoded, `inputSchema()` decodes TypeBox transforms for the handler, and `checkSchema` and `readSchema`
 * answer the decoded data.
 */
import { defineErrors, maximus, ok, t } from '../src/index.ts';
import {
  checkSchema,
  defaultSchema,
  inputSchema,
  literalUnion,
  normalizeSchema,
  pipeSchema,
  readSchema,
  refineSchema,
  transformSchema,
} from '../src/schemas.ts';
import type { Checked, InputIssue, SchemaInput, Static, StaticDecode } from '../src/schemas.ts';

/** A date-time on the wire, a `Date` once decoded. */
const Instant = t
  .Transform(t.String({ format: 'date-time' }))
  .Decode((value) => new Date(value))
  .Encode((value) => value.toISOString());
/** A canonical schema whose fields each use a codec. */
const Search = t.Object(
  {
    tags: transformSchema(t.String(), (value) => value.split(',')),
    sizes: t.Array(transformSchema(t.String(), (value) => value.length)),
    query: normalizeSchema(t.String({ minLength: 1 }), (value) => value.trim()),
    page: pipeSchema(t.String({ pattern: '^[0-9]+$' }), t.Integer()),
    limit: transformSchema(defaultSchema(t.String(), '25'), Number),
    since: Instant,
  },
  { additionalProperties: false }
);
const SearchInput = inputSchema(refineSchema(Search, (value) => value.tags.length > 0));

/** What a caller sends. */
type Wire = Static<typeof SearchInput>;
const wire: Wire = { tags: 'a,b', sizes: ['xl'], query: ' notes ', page: '2', since: '2026-10-18T12:00:00Z' };
// @ts-expect-error A transformed field is sent as its source, never as the decoded value.
const decodedTags: Wire = { ...wire, tags: ['a', 'b'] };
// @ts-expect-error So is each item of a list of transformed values.
const decodedSizes: Wire = { ...wire, sizes: [2] };
// @ts-expect-error A piped field is sent as its source schema's type.
const decodedPage: Wire = { ...wire, page: 2 };
// @ts-expect-error A TypeBox transform is sent encoded.
const decodedSince: Wire = { ...wire, since: new Date() };
const withLimit: SchemaInput<typeof Search> = { ...wire, limit: '10' };

const Choices = literalUnion(['open', 'done']);
const optionalOwner = inputSchema(
  t.Object({ name: t.Optional(normalizeSchema(t.String(), (value) => value.trim())), state: Choices })
);
const optionalDecoded: StaticDecode<typeof optionalOwner> = { state: 'open' };
// @ts-expect-error Literal choices remain closed after decoding.
const invalidChoice: StaticDecode<typeof optionalOwner> = { state: 'other' };
const optionalName: string | undefined = optionalDecoded.name;
void [optionalDecoded, invalidChoice, optionalName];

const StoredOwner = t.Object({
  settings: t.Unsafe<{ enabled: boolean; labels: Record<string, string> }>(
    t.Object({ enabled: t.Boolean(), labels: t.Record(t.String(), t.String()) })
  ),
  name: t.Optional(normalizeSchema(t.String(), (value) => value.trim())),
});
const storedOwner = readSchema(StoredOwner, {});
const enabled: boolean = storedOwner.settings.enabled;
// @ts-expect-error An opaque owner's decoded type does not widen to any.
const invalidEnabled: string = storedOwner.settings.enabled;
void [enabled, invalidEnabled];

/** What the handler receives. */
type Decoded = StaticDecode<typeof SearchInput>;
declare const decoded: Decoded;
const tags: string[] = decoded.tags;
const sizes: number[] = decoded.sizes;
const page: number = decoded.page;
const limit: number = decoded.limit;
const since: Date = decoded.since;
// @ts-expect-error The handler receives the decoded Date, never the wire string.
const sinceText: string = decoded.since;

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
base.operation(
  'searchRecords',
  {
    scope: 'demo:records:read',
    title: 'Search records',
    description: 'Search the records.',
    effect: 'read',
    input: SearchInput,
    output: t.Object({ count: t.Integer() }, { additionalProperties: false }),
    http: { method: 'POST', path: '/v1/records/search' },
  },
  async (_context, input) => ok({ count: input.tags.length + input.page + input.since.getTime() })
);

const Stored = t.Object({ at: Instant, name: normalizeSchema(t.String(), (value) => value.trim()) });
const read = readSchema(Stored, {});
const at: Date = read.at;
// @ts-expect-error A reader answers the decoded value.
const atText: string = read.at;
const checked: Checked<typeof Stored> = checkSchema(Stored, {});
if (checked.success) {
  const name: string = checked.data.name;
  void name;
}
const issue: InputIssue = { path: '/tags', message: 'Expected string' };

void [decodedTags, decodedSizes, decodedPage, decodedSince, withLimit, tags, sizes, page, limit, since];
void [sinceText, at, atText, issue];
