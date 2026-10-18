/**
 * `@arbol-ai/maximus/analytics`: an observer that turns each operation call's observation into an
 * allowlisted analytics event and records it in a sink the application provides. No input, output or
 * credential ever reaches the event.
 */
import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';

import { OrganizationIdSchema, UuidSchema } from '../index.ts';
import type { Failure, Observer, Result } from '../index.ts';
import { telemetryEnabled } from '../telemetry.ts';

/** An analytics event: the allowlisted metadata of one operation call, flattened, with an id of its own. */
export const ExecutionEventSchema = Type.Object(
  {
    id: UuidSchema,
    service: Type.String({ pattern: '^[a-z][a-z0-9-]{1,80}$' }),
    operation: Type.String({ pattern: '^[a-z][a-zA-Z0-9]{0,100}$' }),
    organizationId: OrganizationIdSchema,
    actorId: Type.String({ minLength: 1, maxLength: 255 }),
    actorKind: Type.Union([Type.Literal('user'), Type.Literal('service')]),
    requestId: UuidSchema,
    traceId: Type.Union([Type.String({ pattern: '^[0-9a-f]{32}$' }), Type.Null()]),
    surface: Type.Union([Type.Literal('http'), Type.Literal('mcp'), Type.Literal('rpc')]),
    occurredAt: Type.Integer({ minimum: 0 }),
    durationMicros: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    outcome: Type.Union([Type.Literal('success'), Type.Literal('failure')]),
    errorCode: Type.Union([Type.String({ pattern: '^[A-Z][A-Z0-9_]{0,80}$' }), Type.Null()]),
  },
  { additionalProperties: false }
);
/** An analytics event. */
export type ExecutionEvent = Static<typeof ExecutionEventSchema>;
/** A store that records analytics events and answers whether it kept each one. */
export interface ExecutionSink {
  /**
   * Keeps one event; an `ok: false` result means the event was not kept, which counts as a delivery failure.
   */
  record: (event: ExecutionEvent) => Promise<Result<null, Failure>>;
}
/** Safe metadata projection; no request or response bodies reach this sink. */
export function analytics<E>(options: {
  enabled?: boolean | ((env: E) => boolean);
  record: (env: E, event: ExecutionEvent) => Promise<unknown>;
}): Observer<E> {
  return {
    async execution(observation, env) {
      if (!telemetryEnabled(options, env)) {
        return;
      }
      const event: ExecutionEvent = {
        id: crypto.randomUUID(),
        service: observation.service,
        operation: observation.operation,
        organizationId: observation.principal.organizationId,
        actorId: observation.principal.actorId,
        actorKind: observation.principal.actorKind,
        requestId: observation.principal.requestId,
        traceId: observation.traceId,
        surface: observation.surface,
        occurredAt: observation.occurredAt,
        durationMicros: observation.durationMicros,
        outcome: observation.outcome,
        errorCode: observation.errorCode,
      };
      const result = await options.record(env, event);
      if (result && typeof result === 'object' && 'ok' in result && result.ok === false) {
        throw new Error('Analytics sink rejected the event.');
      }
    },
  };
}
