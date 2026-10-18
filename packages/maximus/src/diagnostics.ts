/**
 * `@arbol-ai/maximus/diagnostics`: diagnostics, safe error descriptions and request correlation for code
 * that runs beside the operations, such as a Durable Object or a queue consumer.
 */

export {
  withDiagnostics,
  diagnosticsEnabled,
  telemetryEnabled,
  reportUnexpected,
  recordExecution,
} from './telemetry.ts';
export type { TelemetryConfig, Observer, ExecutionObservation, BackgroundContext } from './telemetry.ts';
export { createDiagnostics } from './internal/diagnostics.ts';
export type { ErrorDescription } from './internal/diagnostics.ts';
export {
  createRequestId,
  durableCorrelation,
  isRequestId,
  parseTraceParent,
} from './internal/correlation.ts';
export type { DurableCorrelation, TraceParent } from './internal/correlation.ts';
