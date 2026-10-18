/**
 * Type tests of the typed client: it sends each operation's encoded (wire) input, codec fields as their
 * source, while a standalone `operation()` handler receives the decoded input; and its option types need
 * no DOM library.
 */
import { createClient } from '../../src/client/client.ts';
import type { ClientManifest, ResponseMode } from '../../src/client/client.ts';
import { t, ok, defineErrors } from '../../src/index.ts';
import { defineApp, operation } from '../../src/internals.ts';
import { inputSchema, transformSchema } from '../../src/schemas.ts';

/** A date-time on the wire, a `Date` in the handler. */
const Instant = t
  .Transform(t.String({ format: 'date-time' }))
  .Decode((value) => new Date(value))
  .Encode((value) => value.toISOString());
const Done = t.Object({ done: t.Boolean() }, { additionalProperties: false });

const app = defineApp<Record<string, never>, null>()({
  name: 'test',
  namespace: 'test',
  mcp: {},
  title: 'Test',
  version: '1',
  origin: 'https://test.com',
  tokens: { issuer: 'https://issuer.example.test/', audience: 'test' },
  errors: defineErrors({}),
  context: async () => ok(null),
  rpc: { callers: [] },
  operations: {
    read: operation({
      http: { method: 'POST', path: '/v1/read' },
      rpc: true,
      effect: 'read',
      scope: 'test:records:read',
      title: 'Read',
      description: 'Read',
      mcp: { name: 'read', idempotent: true },
      input: t.Object({ documentNumber: t.String() }, { additionalProperties: false }),
      output: t.Object({ found: t.Boolean() }, { additionalProperties: false }),
      execute: async (_context: null, _input: { documentNumber: string }) => ok({ found: true }),
    }),
    schedule: operation({
      http: { method: 'POST', path: '/v1/schedule' },
      effect: 'write',
      scope: 'test:records:write',
      title: 'Schedule',
      description: 'Schedule',
      input: t.Object({ at: Instant }, { additionalProperties: false }),
      output: Done,
      execute: async (_context: null, input) => {
        const when: Date = input.at;
        // @ts-expect-error The handler receives the decoded Date, never the wire string.
        const text: string = input.at;
        return ok({ done: Boolean(when) && Boolean(text) });
      },
    }),
    tag: operation({
      http: { method: 'POST', path: '/v1/tag' },
      effect: 'write',
      scope: 'test:records:write',
      title: 'Tag',
      description: 'Tag',
      input: inputSchema(
        t.Object(
          { tags: transformSchema(t.String(), (value) => value.split(',')) },
          { additionalProperties: false }
        )
      ),
      output: Done,
      execute: async (_context: null, input) => ok({ done: input.tags.length > 0 }),
    }),
  },
});
const client = createClient<typeof app>('https://test.com', 'token');
// @ts-expect-error Number identifiers are forbidden.
client.read({ documentNumber: 123 });
client.read({ documentNumber: '123' });

client.schedule({ at: '2026-10-18T12:00:00Z' });
// @ts-expect-error The client sends the encoded date-time string, not a Date.
client.schedule({ at: new Date() });
client.tag({ tags: 'urgent,billing' });
// @ts-expect-error A transformed field travels as its source: the string the server checks.
client.tag({ tags: ['urgent', 'billing'] });

const manifest: ClientManifest = app;
const mode: ResponseMode = 'data';
// @ts-expect-error A method answers the envelope or the data, nothing else.
const raw: ResponseMode = 'raw';
createClient<typeof app>('https://test.com', 'token', { credentials: 'include', cache: 'no-cache' });
// @ts-expect-error Credentials take one of the Fetch modes.
createClient<typeof app>('https://test.com', 'token', { credentials: 'always' });
void [manifest, mode, raw];
