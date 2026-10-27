/**
 * What `.build()` refuses, rule by rule: the namespace, origin, limits and telemetry of the application, each
 * operation's name, scopes, actors, schemas, byte bodies, attachments, headers, limits and routes, schema
 * references, MCP tool names, RPC callers, guides, skills and the skill tool. Each refusal is a TypeError with the rule's message,
 * and an application that breaks several rules always meets the same one first.
 */
import { expect, it } from 'vite-plus/test';

import { AttachmentOutputSchema, defineErrors, maximus, ok, t } from '../../src/index.ts';
import type { ApplicationConfiguration, McpSkill } from '../../src/index.ts';

type Env = Record<string, never>;
const strict = { additionalProperties: false } as const;
const MIB = 1024 * 1024;
const record = t.Object({ recordId: t.String() }, strict);
const configuration: ApplicationConfiguration<Env> = {
  name: 'records',
  namespace: 'records',
  title: 'Records',
  version: '1',
  origin: 'https://records.example.test',
  tokens: { issuer: 'https://issuer.example.test/', audience: 'https://records.example.test' },
  errors: defineErrors({}),
  rpc: { callers: ['billing'] },
  telemetry: { enabled: false },
};
/** A valid operation; each case changes what it needs. */
const readRecord = {
  title: 'Read a record',
  description: 'Read one record of the organization.',
  effect: 'read',
  scope: 'records:records:read',
  input: record,
  output: record,
  http: { method: 'POST', path: '/v1/records/read' },
  actorKinds: ['user'],
} as const;
/** A valid byte upload: a path parameter, a header-sourced field and a query field. */
const uploadFile = {
  title: 'Upload a file',
  description: 'Store one file in a folder.',
  effect: 'write',
  scope: 'records:files:write',
  input: t.Object({ folderId: t.String(), filename: t.String(), note: t.Optional(t.String()) }, strict),
  output: t.Object({ fileId: t.String() }, strict),
  http: {
    method: 'POST',
    path: '/v1/folders/{folderId}/files',
    body: 'bytes',
    headers: { filename: 'X-Filename' },
  },
  actorKinds: ['user'],
} as const;
/** A valid attachment download. */
const downloadFile = {
  title: 'Download a file',
  description: 'Answer one file.',
  effect: 'read',
  scope: 'records:files:read',
  input: t.Object({ fileId: t.String() }, strict),
  output: AttachmentOutputSchema,
  http: { method: 'GET', path: '/v1/files/{fileId}', response: 'attachment' },
  actorKinds: ['user'],
} as const;
/** Every handler answers an empty success: no case runs it. */
const answer = (async () => ok({})) as never;

/** Builds the application with `definition` as its one operation, named `name`. */
function build(
  definition: object,
  name = 'readRecord',
  config: Partial<ApplicationConfiguration<Env>> = {}
): () => unknown {
  return () =>
    maximus<Env>({ ...configuration, ...config })
      .operation(name, definition as never, answer)
      .build();
}

it('refuses a namespace or an application name that is not a lowercase kebab-case word of 2 to 64 characters', () => {
  const malformed = ['Records', 'r', '1records', 'records_x', 'records:x', `r${'x'.repeat(64)}`];
  for (const namespace of malformed) {
    expect(build(readRecord, 'readRecord', { namespace }), namespace).toThrow(
      new TypeError('A scope namespace is required.')
    );
  }
  expect(build(readRecord, 'readRecord', { namespace: `r${'x'.repeat(63)}` })).toThrow(
    // A 64-character namespace is admitted: what breaks is the operation's scope of another namespace.
    'every scope is'
  );
  // The name identifies the service in its observations and analytics events, which carry no other shape.
  for (const name of malformed) {
    expect(build(readRecord, 'readRecord', { name }), name).toThrow(
      new TypeError('An application name is a lowercase kebab-case word of 2 to 64 characters.')
    );
  }
  expect(build(readRecord, 'readRecord', { name: `r${'x'.repeat(63)}` })).not.toThrow();
});

it('refuses an application body limit outside 1 byte to 16 MiB, and an origin that is not HTTPS', () => {
  for (const maxBodyBytes of [0, -1, 1.5, Number.NaN, 16 * MIB + 1]) {
    expect(build(readRecord, 'readRecord', { maxBodyBytes }), String(maxBodyBytes)).toThrow(
      new TypeError('The application body limit is a positive integer up to 16 MiB.')
    );
  }
  expect(build(readRecord, 'readRecord', { maxBodyBytes: 16 * MIB })).not.toThrow();
  expect(build(readRecord, 'readRecord', { origin: 'http://records.example.test' })).toThrow(
    new TypeError('Application origin must use HTTPS.')
  );
});

it('refuses telemetry that code untyped by TypeScript gives a malformed switch, observer or trace id accessor', () => {
  const refusal = new TypeError(
    'Telemetry takes enabled as true, false or a function of env, observers as a list of objects whose execution, admission and error are functions, and traceId as a function.'
  );
  for (const telemetry of [
    null,
    { enabled: 'false' },
    { enabled: 0 },
    { observers: 42 },
    { observers: [null] },
    { observers: [{ execution: 'record' }] },
    { traceId: 'trace' },
  ]) {
    expect(build(readRecord, 'readRecord', { telemetry } as never), JSON.stringify(telemetry)).toThrow(
      refusal
    );
  }
  const observer = { execution: async () => undefined, error: () => undefined };
  expect(
    build(readRecord, 'readRecord', {
      telemetry: { enabled: () => true, observers: [observer, {}], traceId: () => null },
    })
  ).not.toThrow();
});

it('refuses a scope match other than any or all, and actor kinds that name no eligible actor once', () => {
  expect(build({ ...readRecord, scopeMatch: 'some' })).toThrow(
    new TypeError('Operation "readRecord": scopeMatch must be any or all.')
  );
  for (const actorKinds of [[], ['user', 'user'], ['admin']]) {
    expect(build({ ...readRecord, actorKinds }), JSON.stringify(actorKinds)).toThrow(
      new TypeError('Operation "readRecord": actorKinds must explicitly name eligible users or services.')
    );
  }
  expect(build({ ...readRecord, scopeMatch: 'all', actorKinds: ['service', 'user'] })).not.toThrow();
  // Under dual authentication, the actors decide which scheme admits a caller, so every operation names them.
  const dual = {
    tokens: { ...configuration.tokens, scheme: { type: 'oauth+bearer', description: 'A key.' } },
  };
  const { actorKinds: _, ...anyone } = readRecord;
  expect(build(anyone)).not.toThrow();
  expect(build(anyone, 'readRecord', dual as never)).toThrow(
    new TypeError('Operation "readRecord": dual authentication requires explicit actor eligibility.')
  );
  expect(build(readRecord, 'readRecord', dual as never)).not.toThrow();
});

it('refuses a schema reference that names no single definition, before the OpenAPI document is requested', () => {
  const Money = t.Object({ amount: t.Integer() }, { $id: 'Money', ...strict });
  const Cents = t.Object({ cents: t.Integer() }, { $id: 'Money', ...strict });
  const priced = (output: object) => ({ ...readRecord, input: t.Object({ price: Money }, strict), output });
  expect(build(priced(t.Object({ total: t.Ref('Money') }, strict)))).not.toThrow();
  expect(build(priced(t.Object({ total: t.Ref('Money'), refund: Cents }, strict)))).toThrow(
    new TypeError('Schema reference "Money" does not name exactly one definition.')
  );
});

it('refuses an operation name that is not camelCase or that a Worker entrypoint or a promise already uses', () => {
  const reserved = ['fetch', 'connect', 'constructor', 'then', 'scheduled', 'queue', 'alarm', 'prototype'];
  const long = `read${'X'.repeat(97)}`;
  for (const name of ['ReadRecord', 'read-record', 'read_record', '1read', long, ...reserved]) {
    expect(build(readRecord, name), name).toThrow(
      new TypeError(
        `Operation "${name}": use a camelCase name of up to 100 characters that is not a reserved Worker method. Use safe operation names, namespaced scopes and strict object schemas.`
      )
    );
  }
  expect(build(readRecord, `read${'X'.repeat(96)}`)).not.toThrow();
});

it("refuses a scope outside the application's namespace, malformed or listed twice", () => {
  const scopes = [
    'other:records:read',
    'recordsx:records:read',
    'records:read',
    'records:Records:read',
    ['records:records:read', 'records:records:read'],
    [],
  ];
  for (const scope of scopes) {
    expect(build({ ...readRecord, scope }), JSON.stringify(scope)).toThrow(
      new TypeError(
        'Operation "readRecord": every scope is "records:<resource>:<action>", listed once. Use safe operation names, namespaced scopes and strict object schemas.'
      )
    );
  }
  expect(
    build({ ...readRecord, scope: ['records:records:read', 'records:records:audit:read'] })
  ).not.toThrow();
});

it('refuses an input or output that is not a strict object or a union of strict objects, and a GET union', () => {
  const loose = t.Object({ recordId: t.String() });
  const union = t.Union([record, t.Object({ name: t.String() }, strict)]);
  const refusals = [
    { input: loose },
    { output: loose },
    { input: t.String() },
    { input: t.Union([]) },
    { input: t.Union([record, loose]) },
    { input: union, http: { method: 'GET', path: '/v1/records/read' } },
  ];
  for (const change of refusals) {
    expect(build({ ...readRecord, ...change }), JSON.stringify(change)).toThrow(
      new TypeError(
        'Operation "readRecord": input and output are strict objects or unions of strict objects; a GET input is one strict object (its query). Use safe operation names, namespaced scopes and strict object schemas.'
      )
    );
  }
  // A body or a result may be one of several strict objects.
  expect(build({ ...readRecord, input: union, output: union })).not.toThrow();
});

it('refuses a record whose keys follow a pattern unless it refuses every other key, at any depth', () => {
  const labels = (options: object = {}) =>
    t.Object({ labels: t.Record(t.String({ pattern: '^[a-z]+$' }), t.String(), options) }, strict);
  const refused = new TypeError(
    'Operation "readRecord": a record whose keys follow a pattern takes additionalProperties: false, t.Record(key, value, { additionalProperties: false }), or a key outside the pattern passes unchecked.'
  );
  expect(build({ ...readRecord, input: labels() })).toThrow(refused);
  expect(build({ ...readRecord, output: t.Object({ pages: t.Array(labels()) }, strict) })).toThrow(refused);
  expect(build({ ...readRecord, input: labels(strict) })).not.toThrow();
  // Every key matches a record of plain string keys, so each value is checked.
  expect(
    build({ ...readRecord, input: t.Object({ labels: t.Record(t.String(), t.String()) }, strict) })
  ).not.toThrow();
});

it('refuses a byte body or an attachment outside its HTTP-only, matching and non-GET contract', () => {
  expect(build(uploadFile, 'uploadFile')).not.toThrow();
  expect(build(downloadFile, 'downloadFile')).not.toThrow();
  for (const http of [
    { ...uploadFile.http, body: 'json' },
    { ...downloadFile.http, response: 'file' },
  ]) {
    expect(build({ ...uploadFile, http }, 'uploadFile')).toThrow(
      new TypeError('Operation "uploadFile": unsupported HTTP binary contract.')
    );
  }
  const httpOnly = new TypeError('Operation "uploadFile": byte bodies and attachments are HTTP-only.');
  expect(build({ ...uploadFile, mcp: { name: 'upload_file', idempotent: false } }, 'uploadFile')).toThrow(
    httpOnly
  );
  expect(build({ ...uploadFile, rpc: true }, 'uploadFile')).toThrow(httpOnly);
  const { http: _route, ...unrouted } = downloadFile;
  expect(build(unrouted, 'uploadFile')).toThrow(httpOnly);
  const matching = new TypeError(
    'Operation "downloadFile": declare matching attachment output and non-GET byte bodies.'
  );
  // An attachment response without the attachment output, the output without the response, and a GET body.
  expect(build({ ...downloadFile, output: record }, 'downloadFile')).toThrow(matching);
  expect(
    build({ ...downloadFile, http: { method: 'GET', path: '/v1/files/{fileId}' } }, 'downloadFile')
  ).toThrow(matching);
  expect(
    build(
      {
        ...downloadFile,
        output: record,
        http: { method: 'GET', path: '/v1/files/{fileId}', body: 'bytes' },
      },
      'downloadFile'
    )
  ).toThrow(matching);
});

it('refuses header-sourced fields unless a byte operation names unique, non-authority metadata fields', () => {
  const refusal = (operation: string) =>
    new TypeError(
      `Operation "${operation}": byte operation headers must name unique, non-authority metadata fields.`
    );
  const refused = refusal('uploadFile');
  const withHeaders = (headers: Record<string, string>, change: object = {}) =>
    build({ ...uploadFile, ...change, http: { ...uploadFile.http, headers } }, 'uploadFile');
  // Only a byte operation reads input from headers.
  expect(build({ ...readRecord, http: { ...readRecord.http, headers: { recordId: 'X-Record' } } })).toThrow(
    refusal('readRecord')
  );
  // A field the input lacks, a path field, and two fields from one header.
  expect(withHeaders({ missing: 'X-Missing' })).toThrow(refused);
  expect(withHeaders({ folderId: 'X-Folder' })).toThrow(refused);
  expect(withHeaders({ filename: 'X-Name', note: 'x-name' })).toThrow(refused);
  // Headers that carry authority or framing, and malformed names.
  for (const header of [
    'Authorization',
    'cookie',
    'Host',
    'Content-Length',
    'content-encoding',
    'X Name',
    'X_Name',
  ]) {
    expect(withHeaders({ filename: header }), header).toThrow(refused);
  }
  // A union input has no one set of fields to read.
  const union = t.Union([uploadFile.input, t.Object({ folderId: t.String(), filename: t.String() }, strict)]);
  expect(withHeaders({ filename: 'X-Filename' }, { input: union })).toThrow(refused);
  expect(withHeaders({ filename: 'X-Filename', note: 'X-Note' })).not.toThrow();
});

it('refuses operation limits outside 1 byte to 16 MiB, a body limit on GET and an unlisted success status', () => {
  for (const maxOutputBytes of [0, 1.5, 16 * MIB + 1]) {
    expect(build({ ...readRecord, maxOutputBytes }), String(maxOutputBytes)).toThrow(
      new TypeError('Operation "readRecord": invalid output byte limit.')
    );
  }
  const bodyLimit = new TypeError(
    'Operation "readRecord": an operation body limit is a positive integer up to 16 MiB, on a non-GET route.'
  );
  for (const maxBodyBytes of [0, 16 * MIB + 1]) {
    expect(build({ ...readRecord, maxBodyBytes }), String(maxBodyBytes)).toThrow(bodyLimit);
  }
  expect(
    build({ ...readRecord, maxBodyBytes: 1024, http: { method: 'GET', path: '/v1/records/read' } })
  ).toThrow(bodyLimit);
  expect(build({ ...readRecord, maxBodyBytes: 16 * MIB, maxOutputBytes: 16 * MIB })).not.toThrow();
  expect(build({ ...readRecord, http: { ...readRecord.http, successStatus: 204 } })).toThrow(
    new TypeError('Operation "readRecord": invalid success status; use 200, 201 or 202.')
  );
  expect(build({ ...readRecord, http: { ...readRecord.http, successStatus: 202 } })).not.toThrow();
});

it('refuses a path parameter the input does not hold as a required string, a reused route and a GET mutation', () => {
  const path = '/v1/records/{recordId}';
  for (const input of [
    t.Object({ id: t.String() }, strict),
    t.Object({ recordId: t.Optional(t.String()) }, strict),
    t.Object({ recordId: t.Integer() }, strict),
  ]) {
    expect(build({ ...readRecord, input, http: { method: 'POST', path } })).toThrow(
      new TypeError('Path parameter "recordId" must be a required string input field.')
    );
  }
  const route = new TypeError(
    'Operation "copyRecord": use unique versioned routes; mutations cannot use GET.'
  );
  expect(() =>
    maximus<Env>(configuration)
      .operation('readRecord', readRecord as never, answer)
      .operation('copyRecord', { ...readRecord, effect: 'write' } as never, answer)
      .build()
  ).toThrow(route);
  expect(
    build({ ...readRecord, effect: 'write', http: { method: 'GET', path: '/v1/records' } }, 'copyRecord')
  ).toThrow(route);
});

it('refuses an MCP tool without a safe name or with a name another operation took, and RPC callers the application does not allow', () => {
  const tools = (operation: string) =>
    new TypeError(`Operation "${operation}": MCP tools require unique safe names.`);
  for (const name of ['Records_read', 'records-read', '1records', `r${'x'.repeat(64)}`, '']) {
    expect(build({ ...readRecord, mcp: { name, idempotent: true } }), name).toThrow(tools('readRecord'));
  }
  expect(build({ ...readRecord, mcp: { name: `r${'X'.repeat(63)}`, idempotent: true } })).not.toThrow();
  expect(() =>
    maximus<Env>(configuration)
      .operation(
        'readRecord',
        { ...readRecord, mcp: { name: 'records_read', idempotent: true } } as never,
        answer
      )
      .operation(
        'readArchived',
        {
          ...readRecord,
          http: { method: 'POST', path: '/v1/records/archived' },
          mcp: { name: 'records_read', idempotent: true },
        } as never,
        answer
      )
      .build()
  ).toThrow(tools('readArchived'));
  expect(build({ ...readRecord, rpc: { callers: ['billing', 'payroll'] } })).toThrow(
    new TypeError('Operation "readRecord": RPC callers must be allowed by the application.')
  );
  expect(build({ ...readRecord, rpc: { callers: ['billing'] } })).not.toThrow();
  expect(build({ ...readRecord, rpc: true })).not.toThrow();
});

it('refuses guides without unique safe names, and a resource name another guide, skill or document takes', () => {
  const guide = { name: 'usage', title: 'Usage', text: 'Read before writing.' };
  for (const guides of [
    [guide, guide],
    [{ ...guide, name: 'Usage' }],
    [{ ...guide, name: 'usage guide' }],
    [{ ...guide, name: '' }],
  ]) {
    expect(build(readRecord, 'readRecord', { mcp: { guides } }), JSON.stringify(guides)).toThrow(
      new TypeError('Guides require unique safe names.')
    );
  }
  expect(
    build(readRecord, 'readRecord', { mcp: { guides: [guide, { ...guide, name: 'usage-2' }] } })
  ).not.toThrow();
  // Guides and skills name MCP resources beside the OpenAPI document's, each name once.
  const skill = { name: 'usage', description: 'Use the records.', text: 'Read before writing.' };
  for (const mcp of [
    { guides: [guide], skills: [skill] },
    { guides: [{ ...guide, name: 'openapi-json' }] },
  ]) {
    const name = mcp.skills ? 'usage' : 'openapi-json';
    expect(build(readRecord, 'readRecord', { mcp }), name).toThrow(
      new TypeError(
        `MCP resource name ${name} is taken: guides and skills need names of their own, and openapi-json and openapi-yaml name the OpenAPI document.`
      )
    );
  }
});

it('refuses skills without unique Agent Skills names, a one-line description of at most 1024 characters and instructions', () => {
  const skill: McpSkill = {
    name: 'weekly-review',
    description: 'Review the open records.',
    text: 'Close what is done.',
  };
  const invalid: McpSkill[][] = [
    [skill, skill],
    [{ ...skill, name: 'Weekly-Review' }],
    [{ ...skill, name: 'weekly--review' }],
    [{ ...skill, name: '-weekly' }],
    [{ ...skill, name: 'x'.repeat(65) }],
    [{ ...skill, description: '   ' }],
    [{ ...skill, description: 'x'.repeat(1025) }],
    [{ ...skill, description: 'One line,\nthen another.' }],
    [{ ...skill, description: 'One line,\rthen another.' }],
    [{ ...skill, text: ' \n ' }],
  ];
  for (const skills of invalid) {
    expect(build(readRecord, 'readRecord', { mcp: { skills } }), JSON.stringify(skills)).toThrow(
      new TypeError('Skills require unique Agent Skills names, a one-line description and instructions.')
    );
  }
  const longest = { ...skill, name: 'x'.repeat(64), description: 'x'.repeat(1024) };
  expect(build(readRecord, 'readRecord', { mcp: { skills: [skill, longest] } })).not.toThrow();
});

it('refuses a skill tool without skills, without a safe name or with the name of an operation tool', () => {
  const skills = [
    { name: 'weekly-review', description: 'Review the open records.', text: 'Close what is done.' },
  ];
  const refused = new TypeError('A skill tool requires skills and a safe name no operation uses.');
  const tool = { ...readRecord, mcp: { name: 'records_read', idempotent: true } };
  expect(build(tool, 'readRecord', { mcp: { skillTool: 'read_skill' } })).toThrow(refused);
  expect(build(tool, 'readRecord', { mcp: { skills: [], skillTool: 'read_skill' } })).toThrow(refused);
  expect(build(tool, 'readRecord', { mcp: { skills, skillTool: 'Read-Skill' } })).toThrow(refused);
  expect(build(tool, 'readRecord', { mcp: { skills, skillTool: 'records_read' } })).toThrow(refused);
  expect(build(tool, 'readRecord', { mcp: { skills, skillTool: 'read_skill' } })).not.toThrow();
});

it('meets the same refusal first whichever other rules an application also breaks', () => {
  // The namespace is checked before the origin, and the scope match before the scopes.
  expect(
    build(readRecord, 'readRecord', { namespace: 'Records', origin: 'http://records.example.test' })
  ).toThrow('A scope namespace is required.');
  expect(build({ ...readRecord, scopeMatch: 'some', scope: 'other:records:read' }, 'then')).toThrow(
    'Operation "then": scopeMatch must be any or all.'
  );
  // Every operation is checked before the guides, and the guides before the application limits.
  expect(
    build({ ...readRecord, scope: 'other:records:read' }, 'readRecord', {
      mcp: { guides: [{ name: 'Usage', title: 'Usage', text: 'Read.' }] },
      maxBodyBytes: 0,
    })
  ).toThrow('every scope is');
  expect(
    build(readRecord, 'readRecord', {
      mcp: { guides: [{ name: 'Usage', title: 'Usage', text: 'Read.' }] },
      maxBodyBytes: 0,
    })
  ).toThrow('Guides require unique safe names.');
});
