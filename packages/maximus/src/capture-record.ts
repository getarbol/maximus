/**
 * The capture record: what one operation call, or one refusal, becomes for the sink that keeps it. The fields
 * an analytics event has keep its names, so live counters and a store of records agree.
 */
import { Type } from 'typebox';
import type { Static, TSchema } from 'typebox';

import { OrganizationIdSchema, UuidSchema } from './schemas.ts';

/** A field a record leaves null when the call never reached what fills it. */
const nullable = <S extends TSchema>(schema: S, description: string) =>
  Type.Union([schema, Type.Null()], { description });

/**
 * One complete record of a call: who called which operation over which transport, when and for how long, what
 * it answered, and, under `payloads: 'all'`, its input and output without what their schemas mark
 * `secret: true`. A refusal before the operation ran has `stage: 'admission'` and null wherever admission had
 * not learned the value: a token is never read before it is verified.
 */
export const CaptureRecordSchema = Type.Object(
  {
    // This record and no other: a UUIDv7, so ids sort by time, which a sink that retries keeps. A request id
    // cannot do this: an MCP batch shares one, and RPC forwards it.
    id: UuidSchema,
    service: Type.String({ description: "The application's name." }),
    operation: nullable(Type.String(), 'The operation, or null when the refusal names none.'),
    organizationId: nullable(
      OrganizationIdSchema,
      "The verified caller's organization, never one a request names; null before verification."
    ),
    actorId: nullable(Type.String(), 'The verified caller; null before verification.'),
    actorKind: nullable(
      Type.Union([Type.Literal('user'), Type.Literal('service')]),
      "The verified caller's kind; null before verification."
    ),
    // The request's id: `x-request-id` on HTTP and MCP, the caller's own forwarded over RPC.
    requestId: UuidSchema,
    traceId: nullable(
      Type.String({ pattern: '^[0-9a-f]{32}$' }),
      'The active trace id `telemetry.traceId` returns; never generated, never read from a header.'
    ),
    surface: Type.Union([Type.Literal('http'), Type.Literal('mcp'), Type.Literal('rpc')], {
      description: 'The transport that admitted the call.',
    }),
    occurredAt: Type.Integer({ minimum: 0, description: 'When the call finished, in Unix milliseconds.' }),
    durationMicros: Type.Integer({
      minimum: 0,
      description: 'How long execution took, or admission for a refusal, in whole microseconds.',
    }),
    outcome: Type.Union([Type.Literal('success'), Type.Literal('failure')], {
      description: '`success` when the caller received the output, `failure` when it received a failure.',
    }),
    errorCode: nullable(Type.String(), 'The code of the failure the caller received; null on success.'),
    stage: Type.Union([Type.Literal('execution'), Type.Literal('admission')], {
      description: '`admission` for a refusal before the shared execution path, `execution` from there on.',
    }),
    version: Type.String({ description: "The application's version." }),
    effect: nullable(
      Type.Union([Type.Literal('read'), Type.Literal('write'), Type.Literal('delete')]),
      "The operation's declared effect."
    ),
    scopes: Type.Array(Type.String(), { description: 'The scopes the operation declares.' }),
    visibility: nullable(
      Type.Union([Type.Literal('public'), Type.Literal('internal')]),
      "The operation's visibility."
    ),
    httpMethod: nullable(Type.String(), "The route's method, on HTTP."),
    httpPath: nullable(Type.String(), "The route's path template, never the requested path, on HTTP."),
    mcpTool: nullable(Type.String(), "The operation's tool name, on MCP."),
    rpcCaller: nullable(
      Type.String(),
      'Over RPC, the `caller` of the Service Binding, as admission checked it or, when it refused the binding, as it claimed.'
    ),
    clientId: nullable(Type.String(), 'The OAuth client the verified token was issued to.'),
    clientClass: nullable(
      Type.Union([Type.Literal('human'), Type.Literal('machine'), Type.Literal('dcr')]),
      "That client's class."
    ),
    grantedScopes: nullable(Type.Array(Type.String()), 'The scopes the verified token grants.'),
    userAgent: nullable(
      Type.String({ maxLength: 200 }),
      "On HTTP and MCP, the request's `user-agent`, cut to 200 characters. What the caller claims."
    ),
    tokenSha256: nullable(
      Type.String({ pattern: '^[0-9a-f]{64}$' }),
      'The hex SHA-256 of the verified token: it joins the calls of one session, and the token never travels.'
    ),
    dimensions: Type.Record(Type.String(), Type.String(), {
      description: 'What the `dimensions` callback named for this call.',
    }),
    startedAt: Type.Integer({
      minimum: 0,
      description: 'When the transport began admitting the call, in Unix milliseconds.',
    }),
    admissionMicros: Type.Integer({
      minimum: 0,
      description: 'How long admission took, in whole microseconds.',
    }),
    input: Type.Unknown({
      description:
        'Under `payloads: all`, the decoded input without its secrets; null for a refused input or `payloads: none`. An input whose schema has both codecs and secrets is the value its schema checked, before the codecs ran.',
    }),
    output: Type.Unknown({
      description:
        'Under `payloads: all`, the checked output without its secrets, as the caller received it; for an attachment, its `contentType`, `filename` and `byteLength`, never its bytes. Null otherwise.',
    }),
    failureData: Type.Unknown({
      description:
        "Under `payloads: all`, the failure's data without its secrets: `issues` for `INVALID_INPUT`, never the refused values. Null otherwise.",
    }),
    payloadRef: nullable(
      Type.Object(
        {
          $ref: Type.String({ description: 'The key the payload was written to.' }),
          bytes: Type.Integer({ minimum: 0, description: 'The size of the payload written, in bytes.' }),
          sha256: Type.String({ pattern: '^[0-9a-f]{64}$', description: "The payload's hex SHA-256." }),
        },
        { additionalProperties: false }
      ),
      'Where a sink wrote `input`, `output` and `failureData` when they were too large to send, as JSON; they are then null.'
    ),
  },
  { additionalProperties: false }
);
/** One capture record. */
export type CaptureRecord = Static<typeof CaptureRecordSchema>;
