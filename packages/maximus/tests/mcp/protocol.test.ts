/**
 * What the MCP server declares and how it bounds calls, on both protocol eras: lists without change
 * notifications, the application's title, a `subscriptions/listen` stream that closes at once, tool calls as
 * large as their operation admits and bodies no larger than the caller's own tools admit, every request of a
 * JSON-RPC batch rate limited like a request of its own, the OpenAPI document serialized once, and failures
 * reported only when they are the server's own, never with their text.
 */
import { ProtocolErrorCode } from '@modelcontextprotocol/server';
import { expect, it, vi } from 'vite-plus/test';
import { stringify } from 'yaml';
import type * as Yaml from 'yaml';

import { createHttpHandler, defineErrors, ok, t } from '../../src/index.ts';
import { defineApp, operation } from '../../src/internals.ts';
import { mcp } from '../../src/mcp/index.ts';

// Counts the YAML serializations of the OpenAPI document, which the real implementation still performs.
vi.mock('yaml', async (importOriginal) => {
  const yaml = await importOriginal<typeof Yaml>();
  return { ...yaml, stringify: vi.fn(yaml.stringify) };
});

/** The rate limit binding the application declares, as Workers provides it. */
interface Env {
  LIMIT: { limit: (input: { key: string }) => Promise<{ success: boolean }> };
}

/** The bytes one call imports; above the SDK's default request limit of 4 MiB. */
const LARGE = 5 * 1024 * 1024;
/** One record by its id: the input and the output of `read_record`. */
const record = t.Object({ recordId: t.String() }, { additionalProperties: false });
/** The `read_record` handler, which answers its input. */
const execute = vi.fn(async (_context: null, input: { recordId: string }) => ok(input));
/** A rate-limited service with a small tool and one that imports large documents. */
const manifest = defineApp<Env, null>()({
  name: 'protocol',
  namespace: 'protocol',
  title: 'Protocol Records',
  version: '1.0.0',
  origin: 'https://example.test',
  tokens: { issuer: 'https://issuer.example.test/', audience: 'https://example.test' },
  errors: defineErrors({}),
  context: async () => ok(null),
  rpc: { callers: [] },
  rateLimit: { binding: 'LIMIT' },
  mcp: { instructions: 'Records of the caller organization.' },
  operations: {
    readRecord: operation({
      http: { method: 'POST', path: '/v1/records/read' },
      effect: 'read',
      scope: 'protocol:records:read',
      title: 'Read a record',
      description: 'Read one record by its id.',
      input: record,
      output: record,
      mcp: { name: 'read_record', idempotent: true, openWorld: false },
      execute,
    }),
    importRecords: operation({
      http: { method: 'POST', path: '/v1/records/import' },
      effect: 'write',
      scope: 'protocol:records:write',
      title: 'Import records',
      description: 'Import records from one CSV document.',
      maxBodyBytes: LARGE + 1024 * 1024,
      input: t.Object({ csv: t.String() }, { additionalProperties: false }),
      output: t.Object({ bytes: t.Integer() }, { additionalProperties: false }),
      mcp: { name: 'import_records', idempotent: false, openWorld: false },
      execute: async (_context: null, input: { csv: string }) => ok({ bytes: input.csv.length }),
    }),
  },
});
/** A service token that may open the endpoint, read records and import them. */
const claims = {
  sub: 'client@clients',
  client_id: 'client',
  org_id: 'org_1234567890abcdef',
  scope: 'protocol:records:read protocol:records:write protocol:mcp:use',
};
/** The service over HTTP with the MCP transport mounted at `/mcp`. */
const handle = createHttpHandler(manifest, { transports: [mcp()], verify: async () => claims });

/** A rate limit binding that admits the first `admitted` checks and refuses every later one. */
function limiter(admitted = Number.POSITIVE_INFINITY) {
  let checks = 0;
  return vi.fn(async () => {
    checks += 1;
    return { success: checks <= admitted };
  });
}

/** Posts one JSON-RPC message, or a batch, as a 2025-era client does. */
function legacyRequest(body: unknown) {
  return new Request('https://example.test/mcp', {
    method: 'POST',
    headers: {
      authorization: 'Bearer a.b.c',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(body),
  });
}

/** Posts one request as a 2026-07-28 client does: the standard headers and the per-request `_meta`. */
function modernRequest(method: string, params: Record<string, unknown> = {}, revision = '2026-07-28') {
  return new Request('https://example.test/mcp', {
    method: 'POST',
    headers: {
      authorization: 'Bearer a.b.c',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': revision,
      'mcp-method': method,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': revision,
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  });
}

/** Every JSON-RPC message of a response, whether one JSON body or server-sent events. */
async function messages(response: Response) {
  const text = await response.text();
  const events = [...text.matchAll(/^data: (.+)$/gm)].map(([, data]) => JSON.parse(data ?? ''));
  return events.length ? events : [JSON.parse(text)];
}

/** One 2025-era call's JSON-RPC response. */
async function call(method: string, params: object = {}, env: Env = { LIMIT: { limit: limiter() } }) {
  const [message] = await messages(
    await handle(legacyRequest({ jsonrpc: '2.0', id: 1, method, params }), env)
  );
  return message;
}

it('declares lists without change notifications and the application title, in both eras', async () => {
  const initialized = await call('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'client', version: '1' },
  });
  const [discovered] = await messages(
    await handle(modernRequest('server/discover'), { LIMIT: { limit: limiter() } })
  );
  const unchanging = {
    tools: { listChanged: false },
    resources: { listChanged: false },
    prompts: { listChanged: false },
  };
  expect(initialized.result.capabilities).toStrictEqual(unchanging);
  expect(discovered.result.capabilities).toStrictEqual(unchanging);
  const identity = { name: 'protocol', title: 'Protocol Records', version: '1.0.0' };
  expect(initialized.result.serverInfo).toStrictEqual(identity);
  expect(discovered.result._meta['io.modelcontextprotocol/serverInfo']).toStrictEqual(identity);
  expect(initialized.result.instructions).toBe('Records of the caller organization.');
});

it('closes a subscriptions/listen stream at once, since no list ever announces a change', async () => {
  const response = await handle(
    modernRequest('subscriptions/listen', {
      notifications: { toolsListChanged: true, promptsListChanged: true, resourcesListChanged: true },
    }),
    { LIMIT: { limit: limiter() } }
  );
  // The stream ends on its own: reading it to the end would otherwise wait for good.
  const [acknowledged, closed] = await messages(response);
  expect(acknowledged).toMatchObject({
    method: 'notifications/subscriptions/acknowledged',
    params: { notifications: {} },
  });
  expect(closed).toMatchObject({ id: 1, result: { resultType: 'complete' } });
});

it('admits a tool call as large as its operation allows and holds each call to its own limit', async () => {
  const csv = 'x'.repeat(LARGE);
  expect(
    (await call('tools/call', { name: 'import_records', arguments: { csv } })).result.structuredContent
  ).toStrictEqual({ bytes: LARGE });
  execute.mockClear();
  const tooLarge = await call('tools/call', {
    name: 'read_record',
    arguments: { recordId: 'x'.repeat(40_000) },
  });
  expect(tooLarge.result.isError).toBe(true);
  expect(JSON.parse(tooLarge.result.content[0].text)).toMatchObject({ code: 'REQUEST_TOO_LARGE' });
  expect(execute).not.toHaveBeenCalled();
});

it("sizes the body a caller may send by the tools it may call, never by another's", async () => {
  // A reader cannot call import_records: its body is held to the application's limit, before any parsing.
  const reader = createHttpHandler(manifest, {
    transports: [mcp()],
    verify: async () => ({ ...claims, scope: 'protocol:records:read protocol:mcp:use' }),
  });
  const refused = await reader(
    legacyRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'import_records', arguments: { csv: 'x'.repeat(LARGE) } },
    }),
    { LIMIT: { limit: limiter() } }
  );
  expect(refused.status).toBe(413);
  expect(await refused.json()).toMatchObject({ error: { code: 'REQUEST_TOO_LARGE' } });
});

it('rate limits every call of a JSON-RPC batch like a request of its own', async () => {
  // One call is the request itself: admission checks the limit once.
  const single = limiter();
  const one = await call(
    'tools/call',
    { name: 'read_record', arguments: { recordId: 'r0' } },
    { LIMIT: { limit: single } }
  );
  expect(one.result.structuredContent).toStrictEqual({ recordId: 'r0' });
  expect(single).toHaveBeenCalledOnce();
  // Admission and the second call pass; the third call is refused before it runs.
  const limit = limiter(2);
  const batch = ['r1', 'r2', 'r3'].map((recordId, index) => ({
    jsonrpc: '2.0',
    id: index + 1,
    method: 'tools/call',
    params: { name: 'read_record', arguments: { recordId } },
  }));
  execute.mockClear();
  const results = (await messages(await handle(legacyRequest(batch), { LIMIT: { limit } }))).map(
    (answer) => answer.result
  );
  expect(limit).toHaveBeenCalledTimes(3);
  expect(execute).toHaveBeenCalledTimes(2);
  expect(results.filter((result) => !result.isError)).toHaveLength(2);
  const refused = results.filter((result) => result.isError);
  expect(refused).toHaveLength(1);
  expect(JSON.parse(refused[0].content[0].text)).toMatchObject({ code: 'RATE_LIMITED', retryable: true });
});

it('rate limits every request of a JSON-RPC batch, and serializes the OpenAPI document once', async () => {
  const fresh = createHttpHandler(manifest, { transports: [mcp()], verify: async () => claims });
  vi.mocked(stringify).mockClear();
  // Admission and the second read pass; the third read is refused, however cheap it would be.
  const limit = limiter(2);
  const reads = [1, 2, 3].map((id) => ({
    jsonrpc: '2.0',
    id,
    method: 'resources/read',
    params: { uri: 'https://example.test/openapi.yaml' },
  }));
  const answers = await messages(await fresh(legacyRequest(reads), { LIMIT: { limit } }));
  expect(limit).toHaveBeenCalledTimes(3);
  const read = answers.filter((answer) => answer.result).map((answer) => answer.result.contents[0].text);
  expect(read).toHaveLength(2);
  expect(answers.filter((answer) => answer.error).map((answer) => answer.error)).toMatchObject([
    { code: -32_000, data: { code: 'RATE_LIMITED', retryable: true } },
  ]);
  // HTTP serves the same text: one serialization answers every read.
  const served = await (
    await fresh(new Request('https://example.test/openapi.yaml'), { LIMIT: { limit } })
  ).text();
  expect(read).toStrictEqual([served, served]);
  expect(stringify).toHaveBeenCalledOnce();
});

it("reports only the server's own failures, and never sends their text to the client", async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    // A revision the server does not speak is the client's mistake: refused, and not the server's failure.
    const refused = await handle(modernRequest('tools/list', {}, '2099-01-01'), {
      LIMIT: { limit: limiter() },
    });
    expect(refused.status).toBe(400);
    expect(log).not.toHaveBeenCalled();
    // A rate limit binding that fails at the batch's second call, with a detail the client must not see.
    let checks = 0;
    const failing = vi.fn(async () => {
      checks += 1;
      if (checks > 1) {
        throw new Error('limiter offline at 10.0.0.7');
      }
      return { success: true };
    });
    const batch = ['r1', 'r2'].map((recordId, index) => ({
      jsonrpc: '2.0',
      id: index + 1,
      method: 'tools/call',
      params: { name: 'read_record', arguments: { recordId } },
    }));
    const answers = await messages(await handle(legacyRequest(batch), { LIMIT: { limit: failing } }));
    expect(answers.find((answer) => answer.id === 1)?.result.structuredContent).toStrictEqual({
      recordId: 'r1',
    });
    expect(answers.find((answer) => answer.id === 2)?.error).toMatchObject({
      code: ProtocolErrorCode.InternalError,
      message: 'Internal error',
    });
    expect(JSON.stringify(answers)).not.toContain('10.0.0.7');
    const reports = log.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(reports).toMatchObject([{ event: 'maximus.unexpected', surface: 'mcp' }]);
    expect(JSON.stringify(reports)).not.toContain('10.0.0.7');
  } finally {
    log.mockRestore();
  }
});
