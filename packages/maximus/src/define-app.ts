/**
 * What `.build()` refuses. Every rule an application must keep is checked once, at construction, so a
 * service that breaks one never starts: each refusal is a TypeError whose message names the rule, and most
 * of the rules about one operation also name that operation.
 */
import type { TSchema } from '@sinclair/typebox';

import { isAttachmentSchema } from './binary.ts';
import type { ErrorCatalog } from './errors.ts';
import { createHttpRouteResolver, isInputHeaderName, operationPathParameters } from './http-paths.ts';
import { hasUncompiledCodecs } from './input-schemas.ts';
import { pathParameterSchemas } from './internal/http-routes.ts';
import { MAX_BODY_BYTES_CEILING, STANDARD_CODES, operationScopes } from './manifest.ts';
import type { AppManifest, McpConfiguration, McpGuide, McpSkill, OperationShape } from './manifest.ts';
import { createOpenApi } from './openapi.ts';
import { hasSchemaReferences } from './schema-bundle.ts';
import { isNamespacedScope } from './scopes.ts';
import type { TelemetryConfig } from './telemetry.ts';
import { checkTokenAuthority, tokenAudiences } from './tokens.ts';
import type { TokenPolicy } from './tokens.ts';

/** Names a Worker entrypoint already uses, or that would break a class or a promise. */
const RESERVED_NAMES = new Set([
  'fetch',
  'connect',
  'constructor',
  'then',
  'scheduled',
  'queue',
  'alarm',
  '__proto__',
  'prototype',
]);
/** An MCP tool name: a lowercase letter, then up to 63 letters, digits and underscores. */
const TOOL_NAME = /^[a-z][A-Za-z0-9_]{0,63}$/;
/** Every field an operation has: any other, such as a misspelled one, would do nothing. */
const OPERATION_FIELDS: ReadonlySet<string> = new Set(
  Object.keys({
    actorKinds: true,
    http: true,
    visibility: true,
    mcp: true,
    rpc: true,
    scope: true,
    scopeMatch: true,
    conditionalScopes: true,
    failures: true,
    title: true,
    description: true,
    group: true,
    effect: true,
    input: true,
    output: true,
    maxBodyBytes: true,
    maxOutputBytes: true,
    execute: true,
    pipeline: true,
  } satisfies Record<keyof OperationShape, true>)
);

/**
 * Checks an application against every rule `.build()` enforces, then hands it back unchanged; a refusal is a
 * TypeError. Curried, so `Env` and `C` can be given explicitly while the operations' types are inferred from
 * the argument.
 */
export function defineApp<Env, C>() {
  return <const Ops extends Record<string, OperationShape>>(manifest: AppManifest<Env, C, Ops>) => {
    checkApplication(manifest);
    return manifest;
  };
}

/**
 * Every rule, in a fixed order, so an application that breaks several always meets the same refusal first.
 */
function checkApplication<Env, C, Ops extends Record<string, OperationShape>>(
  manifest: AppManifest<Env, C, Ops>
): void {
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(manifest.namespace)) {
    throw new TypeError('A scope namespace is required.');
  }
  // The name identifies the service in every observation, analytics event and MCP server listing.
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(manifest.name)) {
    throw new TypeError('An application name is a lowercase kebab-case word of 2 to 64 characters.');
  }
  checkDeclaredFailures(manifest.operations, manifest.errors);
  const claimed = { routes: new Set<string>(), tools: new Set<string>() };
  for (const [name, op] of Object.entries(manifest.operations)) {
    checkOperation(name, op, manifest, claimed);
  }
  // Compiling the router refuses ambiguous or overlapping path templates.
  createHttpRouteResolver(Object.values(manifest.operations));
  checkSchemaReferences(manifest);
  checkGuides(manifest.mcp?.guides ?? []);
  checkSkills(manifest.mcp?.skills ?? []);
  checkMcpResourceNames(manifest.mcp);
  checkSkillTool(manifest.mcp, claimed.tools);
  if (!validBodyLimit(manifest.maxBodyBytes)) {
    throw new TypeError('The application body limit is a positive integer up to 16 MiB.');
  }
  if (!validBodyLimit(manifest.maxOutputBytes)) {
    throw new TypeError('The application output limit is a positive integer up to 16 MiB.');
  }
  if (new URL(manifest.origin).protocol !== 'https:') {
    throw new TypeError('Application origin must use HTTPS.');
  }
  checkTelemetry(manifest.telemetry);
  checkTokenAuthority(manifest.tokens, manifest.namespace);
  tokenAudiences(manifest.tokens);
  if (
    Object.keys(manifest.tokens.resources ?? {}).length > 0 &&
    manifest.tokens.resourceMetadataUrl === undefined
  ) {
    // The default discovery document is not served once distinct resources are configured, so a
    // 401 challenge would otherwise point clients at a 404.
    throw new TypeError(
      'tokens.resources requires tokens.resourceMetadataUrl: name the metadata a 401 challenge points at.'
    );
  }
}

/** The callbacks an observer may have, each a function when present. */
const OBSERVER_CALLBACKS = ['execution', 'admission', 'error'] as const;

/** Whether a value is an observer: an object whose callbacks, when present, are functions. */
function isObserver(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    OBSERVER_CALLBACKS.every((name) => {
      const callback: unknown = Reflect.get(value, name);
      return callback === undefined || typeof callback === 'function';
    })
  );
}

/**
 * The telemetry option, as code untyped by TypeScript may give it: a switch that is a boolean or a function,
 * observers that are objects whose callbacks are functions, and a trace id accessor that is a function. A
 * malformed observer would fail every call it observes, and a switch such as `'false'` would leave telemetry
 * on.
 */
function checkTelemetry<Env>(telemetry: TelemetryConfig<Env> | undefined): void {
  if (telemetry === undefined) {
    return;
  }
  if (
    typeof telemetry !== 'object' ||
    telemetry === null ||
    (telemetry.enabled !== undefined &&
      typeof telemetry.enabled !== 'boolean' &&
      typeof telemetry.enabled !== 'function') ||
    (telemetry.observers !== undefined &&
      (!Array.isArray(telemetry.observers) || !telemetry.observers.every(isObserver))) ||
    (telemetry.traceId !== undefined && typeof telemetry.traceId !== 'function')
  ) {
    throw new TypeError(
      'Telemetry takes enabled as true, false or a function of env, observers as a list of objects whose execution, admission and error are functions, and traceId as a function.'
    );
  }
}

/** An operation's `failures` name domain codes of the catalog, each once. */
function checkDeclaredFailures(
  operations: Readonly<Record<string, OperationShape>>,
  errors: ErrorCatalog
): void {
  const domainCodes = new Set(
    Object.values(errors.definitions)
      .map(({ code }) => code)
      .filter((code) => !STANDARD_CODES.has(code))
  );
  for (const [name, op] of Object.entries(operations)) {
    if (
      op.failures &&
      (new Set(op.failures).size !== op.failures.length || op.failures.some((code) => !domainCodes.has(code)))
    ) {
      throw new TypeError(
        `Operation "${name}": failures lists each domain failure code of the error catalog once; standard failures are always allowed.`
      );
    }
  }
}

/** Every rule one operation keeps, in the order a definition is usually written. */
function checkOperation(
  name: string,
  op: OperationShape,
  application: {
    namespace: string;
    rpc: { callers: readonly string[] };
    tokens: Pick<TokenPolicy, 'scheme'>;
  },
  claimed: { routes: Set<string>; tools: Set<string> }
): void {
  checkOperationContract(name, op, application.namespace);
  // Under dual authentication, an operation's actors decide which of the two schemes admits a caller.
  if (application.tokens.scheme?.type === 'oauth+bearer' && !op.actorKinds) {
    throw new TypeError(`Operation "${name}": dual authentication requires explicit actor eligibility.`);
  }
  checkHttpExposure(name, op, claimed.routes);
  if (
    op.conditionalScopes &&
    (!op.conditionalScopes.length ||
      new Set(op.conditionalScopes).size !== op.conditionalScopes.length ||
      op.conditionalScopes.some(
        (scope) => operationScopes(op).includes(scope) || !isNamespacedScope(scope, application.namespace)
      ))
  ) {
    throw new TypeError(
      `Operation "${name}": conditional scopes require unique namespaced declarations distinct from the admission scope.`
    );
  }
  if (op.mcp) {
    if (!TOOL_NAME.test(op.mcp.name) || claimed.tools.has(op.mcp.name)) {
      throw new TypeError(`Operation "${name}": MCP tools require unique safe names.`);
    }
    claimed.tools.add(op.mcp.name);
  }
  if (
    op.rpc &&
    op.rpc !== true &&
    op.rpc.callers.some((caller) => !application.rpc.callers.includes(caller))
  ) {
    throw new TypeError(`Operation "${name}": RPC callers must be allowed by the application.`);
  }
}

/** The operation's fields, name, scopes, eligible actors and schemas. */
function checkOperationContract(name: string, op: OperationShape, namespace: string): void {
  const unknown = Object.keys(op).find((field) => !OPERATION_FIELDS.has(field));
  if (unknown !== undefined) {
    throw new TypeError(`Operation "${name}": "${unknown}" is not an operation field.`);
  }
  if (op.scopeMatch !== undefined && op.scopeMatch !== 'any' && op.scopeMatch !== 'all') {
    throw new TypeError(`Operation "${name}": scopeMatch must be any or all.`);
  }
  if (hasUncompiledCodecs(op.input)) {
    throw new TypeError(
      `Operation "${name}": its input uses codecs (normalize, transform, inspect, refine, pipe or stripObject) that run only inside inputSchema(); wrap the input in inputSchema().`
    );
  }
  if (
    op.actorKinds &&
    (!op.actorKinds.length ||
      new Set(op.actorKinds).size !== op.actorKinds.length ||
      op.actorKinds.some((kind) => kind !== 'user' && kind !== 'service'))
  ) {
    throw new TypeError(`Operation "${name}": actorKinds must explicitly name eligible users or services.`);
  }
  if (!/^[a-z][a-zA-Z0-9]{0,99}$/.test(name) || RESERVED_NAMES.has(name)) {
    throw new TypeError(
      `Operation "${name}": use a camelCase name of up to 100 characters that is not a reserved Worker method. Use safe operation names, namespaced scopes and strict object schemas.`
    );
  }
  const scopes = operationScopes(op);
  if (
    !scopes.length ||
    new Set(scopes).size !== scopes.length ||
    scopes.some((scope) => !isNamespacedScope(scope, namespace))
  ) {
    throw new TypeError(
      `Operation "${name}": every scope is "${namespace}:<resource>:<action>", listed once. Use safe operation names, namespaced scopes and strict object schemas.`
    );
  }
  if (
    !(
      strictObject(op.input, op.http?.method !== 'GET') &&
      (isAttachmentSchema(op.output) || strictObject(op.output, true))
    )
  ) {
    throw new TypeError(
      `Operation "${name}": input and output are strict objects or unions of strict objects; a GET input is one strict object (its query). Use safe operation names, namespaced scopes and strict object schemas.`
    );
  }
  if (looseRecord(op.input) || looseRecord(op.output)) {
    throw new TypeError(
      `Operation "${name}": a record whose keys follow a pattern takes additionalProperties: false, t.Record(key, value, { additionalProperties: false }), or a key outside the pattern passes unchecked.`
    );
  }
}

/** Byte bodies, attachments, limits, header-sourced fields and the route itself. */
function checkHttpExposure(name: string, op: OperationShape, routes: Set<string>): void {
  if (
    (op.http?.body !== undefined && op.http.body !== 'bytes') ||
    (op.http?.response !== undefined && op.http.response !== 'attachment')
  ) {
    throw new TypeError(`Operation "${name}": unsupported HTTP binary contract.`);
  }
  const binary = op.http?.body === 'bytes';
  const attachment = isAttachmentSchema(op.output);
  if ((binary || attachment) && (!op.http || op.mcp || op.rpc)) {
    throw new TypeError(`Operation "${name}": byte bodies and attachments are HTTP-only.`);
  }
  if ((op.http?.response === 'attachment') !== attachment || (binary && op.http?.method === 'GET')) {
    throw new TypeError(`Operation "${name}": declare matching attachment output and non-GET byte bodies.`);
  }
  if (!validBodyLimit(op.maxOutputBytes)) {
    throw new TypeError(`Operation "${name}": invalid output byte limit.`);
  }
  if (op.http?.successStatus !== undefined && ![200, 201, 202].includes(op.http.successStatus)) {
    throw new TypeError(`Operation "${name}": invalid success status; use 200, 201 or 202.`);
  }
  if (op.http?.headers) {
    const pathFields = new Set(operationPathParameters(op.http.path));
    const headers = Object.entries(op.http.headers);
    if (
      !binary ||
      op.input.type !== 'object' ||
      new Set(headers.map(([, wire]) => wire.toLowerCase())).size !== headers.length ||
      headers.some(
        ([field, wire]) =>
          !Object.hasOwn(op.input.properties, field) || pathFields.has(field) || !isInputHeaderName(wire)
      )
    ) {
      throw new TypeError(
        `Operation "${name}": byte operation headers must name unique, non-authority metadata fields.`
      );
    }
  }
  if (!validBodyLimit(op.maxBodyBytes) || (op.maxBodyBytes !== undefined && op.http?.method === 'GET')) {
    throw new TypeError(
      `Operation "${name}": an operation body limit is a positive integer up to 16 MiB, on a non-GET route.`
    );
  }
  if (op.http) {
    for (const parameter of operationPathParameters(op.http.path)) {
      pathParameterSchemas(op.input, parameter);
    }
    const route = `${op.http.method} ${op.http.path}`;
    if (routes.has(route) || (op.effect !== 'read' && op.http.method === 'GET')) {
      throw new TypeError(`Operation "${name}": use unique versioned routes; mutations cannot use GET.`);
    }
    routes.add(route);
  }
}

/**
 * A schema reference (TypeBox `Ref` or `Recursive`) resolves when the OpenAPI document bundles the schemas,
 * to the one definition its name has. An application whose schemas refer to a name is bundled at
 * construction, so a reference that names no single definition is refused before the service starts rather
 * than when the document is first requested; schemas without references have nothing to resolve.
 */
function checkSchemaReferences<Env, C, Ops extends Record<string, OperationShape>>(
  manifest: AppManifest<Env, C, Ops>
): void {
  const schemas = [
    ...Object.values(manifest.operations).flatMap((op) => [op.input, op.output]),
    ...Object.values(manifest.errors.definitions).map((definition) => definition.dataSchema),
  ];
  if (schemas.some(hasSchemaReferences)) {
    createOpenApi(manifest);
  }
}

/** Guides are named resources and prompts: each name safe and unique. */
function checkGuides(guides: readonly McpGuide[]): void {
  if (
    new Set(guides.map((guide) => guide.name)).size !== guides.length ||
    guides.some((guide) => !/^[a-z][a-z0-9-]{0,63}$/.test(guide.name))
  ) {
    throw new TypeError('Guides require unique safe names.');
  }
}

/** The names of the MCP resources the server always lists: the OpenAPI document as JSON and as YAML. */
const OPENAPI_RESOURCES = ['openapi-json', 'openapi-yaml'];

/**
 * Guides and skills name MCP resources beside the OpenAPI document's, so each name stands for one resource: a
 * guide and a skill never share one, and neither takes `openapi-json` or `openapi-yaml`. `maximus prepare`
 * applies this to `mcp/guides/` and `mcp/skills/` too.
 */
export function checkMcpResourceNames(mcp: Pick<McpConfiguration, 'guides' | 'skills'> | undefined): void {
  const taken = new Set(OPENAPI_RESOURCES);
  for (const { name } of [...(mcp?.guides ?? []), ...(mcp?.skills ?? [])]) {
    if (taken.has(name)) {
      throw new TypeError(
        `MCP resource name ${name} is taken: guides and skills need names of their own, and openapi-json and openapi-yaml name the OpenAPI document.`
      );
    }
    taken.add(name);
  }
}

/** The MCP skills: unique Agent Skills names, one-line descriptions and instructions. */
function checkSkills(skills: readonly McpSkill[]): void {
  if (
    new Set(skills.map((skill) => skill.name)).size !== skills.length ||
    skills.some(
      (skill) =>
        skill.name.length > 64 ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name) ||
        !skill.description.trim() ||
        skill.description.length > 1024 ||
        /[\r\n]/.test(skill.description) ||
        !skill.text.trim()
    )
  ) {
    throw new TypeError('Skills require unique Agent Skills names, a one-line description and instructions.');
  }
}

/** The skill tool serves the MCP skills under a name no operation's tool takes. */
function checkSkillTool(mcp: McpConfiguration | undefined, tools: ReadonlySet<string>): void {
  const skillTool = mcp?.skillTool;
  if (
    skillTool !== undefined &&
    (!(mcp?.skills ?? []).length || !TOOL_NAME.test(skillTool) || tools.has(skillTool))
  ) {
    throw new TypeError('A skill tool requires skills and a safe name no operation uses.');
  }
}

/** Whether a body or output limit is absent, or a positive integer up to 16 MiB. */
function validBodyLimit(value: number | undefined): boolean {
  return value === undefined || (Number.isInteger(value) && value > 0 && value <= MAX_BODY_BYTES_CEILING);
}

/** The key pattern of `t.Record(t.String(), value)`, which every key matches, so every value is checked. */
const ANY_KEY = '^(.*)$';

/**
 * Whether a schema holds, at any depth, a record whose keys follow a pattern but that admits other keys:
 * without `additionalProperties: false`, a key outside the pattern passes with any value at all.
 */
function looseRecord(schema: unknown): boolean {
  if (Array.isArray(schema)) {
    return schema.some(looseRecord);
  }
  if (!schema || typeof schema !== 'object') {
    return false;
  }
  const node = schema as Record<string, unknown>;
  const patterns = node.patternProperties;
  if (
    patterns &&
    typeof patterns === 'object' &&
    node.additionalProperties !== false &&
    Object.keys(patterns).some((pattern) => pattern !== ANY_KEY)
  ) {
    return true;
  }
  return Object.values(node).some(looseRecord);
}

/**
 * A strict object (`additionalProperties: false`), or — when `unions` is true —
 * a union whose every member is a strict object, so a request body or a result
 * can be discriminated by a field (`{ channel: 'email', … } | { channel: 'sms', … }`).
 */
function strictObject(schema: TSchema, unions: boolean): boolean {
  if (schema.type === 'object') {
    return schema.additionalProperties === false;
  }
  const members = (schema as { anyOf?: unknown }).anyOf;
  return (
    unions &&
    Array.isArray(members) &&
    members.length > 0 &&
    members.every((member) => strictObject(member as TSchema, false))
  );
}
