/**
 * `@arbol-ai/maximus`: the core. Define an application once with `maximus()` and serve it with
 * `createHttpHandler` (or `createWorker` from `@arbol-ai/maximus/workers`). Every optional capability
 * is its own entry and depends on this one, never the other way round.
 */

// The fluent builder and what it builds.
export { maximus } from './builder.ts';
export type { ApplicationBuilder, ApplicationConfiguration } from './builder.ts';
export type {
  AppManifest,
  Exposure,
  OperationShape,
  OperationScope,
  OperationMiddleware,
  Invocation,
  InvocationAuthority,
  McpConfiguration,
  McpGuide,
  McpSkill,
} from './manifest.ts';
export { isPublicOperation, operationScopes, operationMatchesScopes } from './manifest.ts';

// File routes and MCP tools, each a file's default export that the project binds to the application.
export { defineAuth, defineContext, defineHandler, defineTool } from './handler.ts';
export type {
  AuthOptions,
  ContextArguments,
  ContextDeclaration,
  DomainCode,
  Fail,
  Failed,
  HandlerAnswer,
  HandlerArguments,
  HandlerDeclaration,
  HandlerHttp,
  HandlerMcp,
  HandlerOptions,
  PreparedContext,
  RouteBody,
  SchemaOf,
  SchemaOrFields,
  ToolDeclaration,
  ToolOptions,
} from './handler.ts';

// Schemas: TypeBox as `t`, the validators and the schemas services share.
export { Type, Type as t } from '@sinclair/typebox';
export type { Static, TSchema } from '@sinclair/typebox';
export { parseInput, parseSchema } from './validation.ts';
export { EmptyInputSchema, OrganizationIdSchema, UuidSchema } from './schemas.ts';
export {
  DeletedObjectSchema,
  EmailAddressSchema,
  HexColorSchema,
  HttpsUrlSchema,
  NamedReferenceSchema,
  PhoneNumberSchema,
  PostalAddressSchema,
  SignedUrlSchema,
} from './common-schemas.ts';
export type { DeletedObject, NamedReference, PostalAddress, SignedUrl } from './common-schemas.ts';
export { Page, PageInfoSchema, PageQueryFields, pageLimit } from './pagination.ts';
export type { PageInfo, PageQuery, TPage } from './pagination.ts';
export { AttachmentOutputSchema } from './attachment-schema.ts';
export type { Attachment } from './attachment-schema.ts';
export type { BinaryBody, BodyFailure } from './binary.ts';

// Results and the error catalog.
export { ok, err, isResult } from './result.ts';
export type { Result, Success, FailureResult } from './result.ts';
export { defineErrors, FailureSchema, resultSchema, standardErrors } from './errors.ts';
export type {
  Failure,
  FailureData,
  ErrorDefinition,
  ErrorCatalog,
  ErrorFactory,
  DefinedErrors,
} from './errors.ts';

// Tokens, scopes and OAuth discovery.
export { createTokenAuthorization, createTokenVerifier, projectToken, PrincipalSchema } from './tokens.ts';
export type {
  Principal,
  TokenPrincipal,
  TokenPolicy,
  TokenResolutionContext,
  TokenScheme,
  TokenClient,
  TokenClaims,
  TokenAlgorithm,
  TokenDevelopment,
} from './tokens.ts';
export { matchesScopes } from './scopes.ts';
export type { ScopeMatch } from './scopes.ts';
export { protectedResourceMetadata } from './oauth.ts';
export type { OAuthResource } from './oauth.ts';

// HTTP: the handler, its routes and the bounded body readers.
export { createHttpHandler } from './http.ts';
export type {
  HttpOptions,
  HttpTransport,
  TransportContext,
  HttpRoute,
  HttpMiddleware,
  RouteContext,
} from './http.ts';
export { createHttpRouteResolver } from './http-paths.ts';
export type { HttpRouteDefinition, HttpRouteMatch } from './http-paths.ts';
export { readBodyText, readBodyBytes } from './internal/body.ts';
export type { BodyReadOptions, HttpBodyFailure, HttpBodyFailureReason } from './internal/body.ts';
export { readJsonResponse, readJsonBody, retryAfterSeconds, isJsonMediaType } from './internal/json.ts';

// The contract: the OpenAPI document.
export { createOpenApi } from './openapi.ts';

// Telemetry.
export { reportUnexpected } from './telemetry.ts';
export type {
  Observer,
  TelemetryConfig,
  ExecutionObservation,
  AdmissionObservation,
  BackgroundContext,
} from './telemetry.ts';
