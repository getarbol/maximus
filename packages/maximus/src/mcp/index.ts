/**
 * `@arbol-ai/maximus/mcp`: the MCP transport. One stateless server per request, built with the official SDK,
 * lists the caller's tools and runs them through the shared execution path, and serves the OpenAPI document
 * and the guides as resources, the guides as prompts and the skills through the Skills extension.
 */
import { createMcpHandler, McpServer, ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import type { Tool } from '@modelcontextprotocol/server';

import { operationMatchesScopes, reportUnexpected, standardErrors } from '../index.ts';
import type { HttpTransport, OperationShape } from '../index.ts';
import { MAX_BODY_BYTES_CEILING, mcpOpenWorld } from '../manifest.ts';
import { canonical, standaloneSchema } from '../schema-bundle.ts';
import { readSkill, registerSkills, SKILLS_EXTENSION, skillTool } from './skills.ts';

/** Operation tools on one `tools/list` page; the skill tool, when served, comes before them on the first. */
const PAGE_SIZE = 50;
/** The JSON-RPC error of a request beyond the caller's rate limit: an implementation-defined server error. */
const RATE_LIMITED = -32_000;

/** An operation that declares an MCP tool. */
type ToolOperation = OperationShape & { mcp: NonNullable<OperationShape['mcp']> };

/** A JSON Schema node, as a tool listing reads it. */
type JsonSchema = Record<string, unknown>;

/** Each operation's tool definition, built on first listing: an application's operations never change. */
const definitions = new WeakMap<OperationShape, Tool>();

/**
 * The tool an operation lists as. Both schemas are self-contained, as MCP clients compile them: no `$id`,
 * which one schema may not repeat. The hints follow the operation's effect and tool declaration; they are not
 * authorization.
 */
function toolDefinition(op: ToolOperation): Tool {
  let tool = definitions.get(op);
  if (!tool) {
    tool = {
      name: op.mcp.name,
      title: op.title,
      description: op.description,
      inputSchema: toolInputSchema(op.input),
      outputSchema: { ...(standaloneSchema(op.output) as object), type: 'object' },
      annotations: {
        readOnlyHint: op.effect === 'read',
        destructiveHint: op.effect === 'delete',
        idempotentHint: op.mcp.idempotent,
        openWorldHint: mcpOpenWorld(op.mcp),
      },
    };
    definitions.set(op, tool);
  }
  return tool;
}

/**
 * An operation's input as a tool's `inputSchema`: an object at the root, as MCP requires and hosts enforce.
 * A union input (`{ channel: 'email', … } | { channel: 'sms', … }`) lists as one object with every member's
 * fields, required when every member requires them, and a field the members declare differently as their
 * choices. Hosts that refuse a root `anyOf`, the Anthropic API among them, would fail every tool of the
 * request; each call is still checked against the exact union.
 */
function toolInputSchema(input: unknown): Tool['inputSchema'] {
  const schema = standaloneSchema(input) as JsonSchema;
  const { anyOf, ...root } = schema;
  const bundled = (root.$defs ?? {}) as Record<string, JsonSchema>;
  const members = Array.isArray(anyOf)
    ? anyOf.map((member: JsonSchema) => localDefinition(member, bundled))
    : [];
  if (!members.length || members.some((member) => member.type !== 'object')) {
    return { ...(schema as object), type: 'object' };
  }
  const fields = (member: JsonSchema) => (member.properties ?? {}) as Record<string, JsonSchema>;
  const names = [...new Set(members.flatMap((member) => Object.keys(fields(member))))];
  const required = names.filter((name) =>
    members.every((member) => Array.isArray(member.required) && member.required.includes(name))
  );
  const listed: JsonSchema = {
    type: 'object',
    ...root,
    properties: Object.fromEntries(
      names.map((name) => [
        name,
        fieldChoices(
          members.flatMap((member) => (name in fields(member) ? [fields(member)[name] ?? {}] : []))
        ),
      ])
    ),
    ...(required.length ? { required } : {}),
    ...(members.every((member) => member.additionalProperties === false)
      ? { additionalProperties: false }
      : {}),
  };
  // Spread as `object`: the SDK types a tool schema as JSON values, which this listing already is.
  return { ...(listed as object), type: 'object' };
}

/** A union member, or the definition under `$defs` its `$ref` names. */
function localDefinition(member: JsonSchema, bundled: Record<string, JsonSchema>): JsonSchema {
  const reference = typeof member.$ref === 'string' ? member.$ref : '';
  return reference.startsWith('#/$defs/') ? (bundled[reference.slice('#/$defs/'.length)] ?? member) : member;
}

/**
 * One field of a listed union: the one schema every member that declares it gives it, the members' literals
 * as an `enum` (a discriminator), or else each distinct schema as a choice.
 */
function fieldChoices(schemas: readonly JsonSchema[]): JsonSchema {
  const distinct = [...new Map(schemas.map((schema) => [canonical(schema), schema])).values()];
  const [first] = distinct;
  if (distinct.length === 1 && first) {
    return first;
  }
  const literal = (schema: JsonSchema) =>
    'const' in schema && Object.keys(schema).every((key) => key === 'const' || key === 'type');
  if (first && distinct.every(literal) && distinct.every((schema) => schema.type === first.type)) {
    return {
      ...(first.type === undefined ? {} : { type: first.type }),
      enum: distinct.map((schema) => schema.const),
    };
  }
  return { anyOf: distinct };
}

/**
 * The MCP transport, for `createWorker(app, { transports: [mcp()] })`: serves the operations that declare
 * `mcp` as tools over Streamable HTTP at `/mcp` (or `path`), with the OpenAPI document and guides as
 * resources, guides as prompts and skills through the Skills extension. A caller needs `<namespace>:mcp:use`
 * and sees only the tools its scopes admit.
 */
export function mcp(options: { path?: string } = {}): HttpTransport {
  return {
    protocol: 'mcp',
    path: options.path ?? '/mcp',
    scope: (namespace) => `${namespace}:mcp:use`,
    // One call carries one operation's input: admit the largest body any of the caller's tools accepts,
    // then hold each call to its own operation's limit, as HTTP does.
    maxBodyBytes: (operations, fallback) =>
      Math.max(fallback, ...operations.flatMap(([, op]) => (op.mcp ? [op.maxBodyBytes ?? fallback] : []))),
    async handle({
      request,
      requestId,
      authenticated,
      application,
      operations,
      contractText,
      url,
      invoke,
      admitRequest,
      bodyBytes,
      bodyLimit,
    }) {
      /** The cursor of the page after the one that ends with an operation, valid for this version only. */
      const pageCursor = (name: string) => `${application.version}:${name}`;
      /**
       * Counts one more request of this HTTP request against the caller's rate limit, as a request of its own
       * (a JSON-RPC batch carries several), and refuses it once the limit does.
       */
      const count = async () => {
        if (!(await admitRequest())) {
          const failure = standardErrors.rateLimited.create();
          throw new ProtocolError(RATE_LIMITED, failure.message, failure);
        }
      };
      /**
       * Runs one of the server's own handlers as a counted request, unless `invoke` counts it: a protocol
       * error answers as thrown, and any other failure is reported by its safe description and answers a
       * generic internal error, never its message.
       */
      const answer = async <R>(work: () => R | Promise<R>, counted = true): Promise<R> => {
        try {
          if (counted) {
            await count();
          }
          return await work();
        } catch (error) {
          if (error instanceof ProtocolError) {
            throw error;
          }
          reportUnexpected(error, 'mcp', requestId);
          throw new ProtocolError(ProtocolErrorCode.InternalError, 'Internal error');
        }
      };
      const response = await createMcpHandler(
        () => {
          const skills = application.mcp?.skills ?? [];
          const skillToolName = skills.length ? application.mcp?.skillTool : undefined;
          const server = new McpServer(
            { name: application.name, title: application.title, version: application.version },
            {
              instructions: application.mcp?.instructions,
              // The lists change only with a deployment, and a stateless server sends no notifications:
              // listChanged stays false, which the SDK would otherwise declare true, so a
              // `subscriptions/listen` stream closes at once instead of waiting for changes that never come.
              capabilities: {
                tools: { listChanged: false },
                resources: { listChanged: false },
                prompts: { listChanged: false },
                ...(skills.length ? { extensions: { [SKILLS_EXTENSION]: {} } } : {}),
              },
            }
          );
          const visible = operations.filter(
            (entry): entry is [string, ToolOperation] =>
              Boolean(entry[1].mcp) &&
              operationMatchesScopes(entry[1], authenticated.scopes) &&
              (!entry[1].actorKinds || entry[1].actorKinds.includes(authenticated.actorKind))
          );
          // The SDK validates JSON-RPC; Maximus owns the business input/output schemas once. `invoke`
          // counts an operation's call against the rate limit, and the skill tool's is counted here.
          server.server.setRequestHandler('tools/call', (call) =>
            answer(async () => {
              if (skillToolName && call.params.name === skillToolName) {
                await count();
                return readSkill(skills, call.params.arguments ?? {});
              }
              const selected = visible.find(([, op]) => op.mcp.name === call.params.name);
              if (!selected) {
                throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Tool not found');
              }
              const [name, op] = selected;
              if (bodyBytes > bodyLimit(op)) {
                return {
                  isError: true,
                  content: [
                    { type: 'text' as const, text: JSON.stringify(standardErrors.tooLarge.create()) },
                  ],
                };
              }
              const result = await invoke(name, op, call.params.arguments ?? {});
              return result.ok
                ? {
                    content: [{ type: 'text' as const, text: JSON.stringify(result.value) }],
                    structuredContent: result.value as Record<string, unknown>,
                  }
                : {
                    isError: true,
                    content: [{ type: 'text' as const, text: JSON.stringify(result.error) }],
                  };
            }, false)
          );
          // Catalog discovery shares the same permission-filtered operation set as execution.
          server.server.setRequestHandler('tools/list', (listing) =>
            answer(() => {
              const cursor = listing.params?.cursor;
              const previous =
                cursor === undefined ? -1 : visible.findIndex(([name]) => pageCursor(name) === cursor);
              if (cursor !== undefined && previous < 0) {
                // Not a cursor this version issued for this caller's tools: the client lists from the start.
                throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Invalid cursor');
              }
              const page = visible.slice(previous + 1, previous + 1 + PAGE_SIZE);
              const last = page.at(-1);
              return {
                tools: [
                  // Skills lead the first page: tool-only clients meet the workflows before the operations.
                  ...(skillToolName && cursor === undefined ? [skillTool(skillToolName, skills)] : []),
                  ...page.map(([, op]) => toolDefinition(op)),
                ],
                ...(last && previous + 1 + PAGE_SIZE < visible.length
                  ? { nextCursor: pageCursor(last[0]) }
                  : {}),
              };
            })
          );
          for (const extension of ['json', 'yaml'] as const) {
            // The URL that serves the document, below the base path, so a client can also fetch it.
            const uri = url(`/openapi.${extension}`);
            const mimeType = extension === 'json' ? 'application/json' : 'application/yaml';
            server.registerResource(
              `openapi-${extension}`,
              uri,
              {
                title: `${application.title} OpenAPI (${extension.toUpperCase()})`,
                description:
                  "The service's OpenAPI document. Reading it grants no authority to run its operations.",
                mimeType,
              },
              () => answer(() => ({ contents: [{ uri, mimeType, text: contractText(extension) }] }))
            );
          }
          for (const guide of application.mcp?.guides ?? []) {
            const uri = `${application.origin}/guides/${guide.name}`;
            server.registerResource(guide.name, uri, { title: guide.title, mimeType: 'text/markdown' }, () =>
              answer(() => ({ contents: [{ uri, mimeType: 'text/markdown', text: guide.text }] }))
            );
            server.registerPrompt(
              guide.name,
              { title: guide.title, description: 'Read the integration usage guide.' },
              () =>
                answer(() => ({
                  messages: [{ role: 'user' as const, content: { type: 'text' as const, text: guide.text } }],
                }))
            );
          }
          if (skills.length) {
            registerSkills(server, skills, answer);
          }
          return server;
        },
        {
          // Admission already bounded the body by the largest tool's limit, and each call is held to its
          // own operation's: the SDK's default of 4 MiB would refuse a call its operation admits.
          maxRequestBodySize: MAX_BODY_BYTES_CEILING,
        }
      ).fetch(request);
      // The SDK answers a client's mistake, such as a missing header or an unsupported revision, with a 4xx:
      // only a 5xx is the server's own failure.
      if (response.status >= 500) {
        reportUnexpected(new Error('MCP transport failure'), 'mcp', requestId);
      }
      return response;
    },
  };
}
