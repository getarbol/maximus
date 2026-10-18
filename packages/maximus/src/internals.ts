/**
 * `@arbol-ai/maximus/internals`: the adapter SPI, for code that builds transports or adapters. Applications
 * use the fluent builder instead.
 */
export { executeOperation } from './execution.ts';
export { defineApp } from './define-app.ts';
export { composeOperations, operation, operationScopes } from './manifest.ts';
export type {
  AppManifest,
  OperationShape,
  Invocation,
  InvocationAuthority,
  OperationMiddleware,
} from './manifest.ts';
export type { HttpTransport, TransportContext, HttpOptions } from './http.ts';
export { telemetryEnabled, recordExecution, withDiagnostics } from './telemetry.ts';
export type { TelemetryConfig, BackgroundContext } from './telemetry.ts';

export { createHttpRouteResolver } from './http-paths.ts';
export type { HttpRouteDefinition, HttpRouteMatch } from './http-paths.ts';
