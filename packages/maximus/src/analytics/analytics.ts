/**
 * `@arbol-ai/maximus/analytics`: an observer that turns each operation call's observation into an
 * allowlisted analytics event and records it in a sink the application provides. No input, output or
 * credential ever reaches the event.
 */
import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

import { OrganizationIdSchema, UuidSchema } from '../index.ts';
import type { Observer } from '../index.ts';
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
/** What `analytics()` takes: where events go, whether it records, and how events name the actor. */
export interface AnalyticsOptions<E> {
  /**
   * Whether events are recorded: a boolean, or a function that decides for each env; on by default. A
   * function that throws turns recording off for that call.
   */
  enabled?: boolean | ((env: E) => boolean);
  /** Keeps one event in the application's store; an `ok: false` result counts as a delivery failure. */
  record: (env: E, event: ExecutionEvent) => Promise<unknown>;
  /**
   * How an event names its actor. `pseudonymous`, the default, records the hex SHA-256 of the organization id
   * and the actor id: distinct actors stay countable, and an identity provider that uses email addresses as
   * subjects does not put them in analytics. `id` records the actor id as the token states it.
   */
  actor?: 'pseudonymous' | 'id';
}

/** The hex SHA-256 of an actor within its organization. */
async function pseudonym(organizationId: string, actorId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${organizationId}:${actorId}`)
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * An observer that records one allowlisted event for each operation call: who called which operation, over
 * which surface, how it ended and how long it took. No input, output, credential or message ever reaches
 * it. `.build()` and `defineErrors` refuse a service name, an operation name or a failure code the event
 * could not carry; an event that still does not match `ExecutionEventSchema` is never recorded: the
 * observer fails, and diagnostics report it.
 */
export function analytics<E>(options: AnalyticsOptions<E>): Observer<E> {
  return {
    async execution(observation, env) {
      if (!telemetryEnabled(options, env)) {
        return;
      }
      const { organizationId, actorId } = observation.principal;
      const event: ExecutionEvent = {
        id: crypto.randomUUID(),
        service: observation.service,
        operation: observation.operation,
        organizationId,
        actorId: options.actor === 'id' ? actorId : await pseudonym(organizationId, actorId),
        actorKind: observation.principal.actorKind,
        requestId: observation.principal.requestId,
        traceId: observation.traceId,
        surface: observation.surface,
        occurredAt: observation.occurredAt,
        durationMicros: observation.durationMicros,
        outcome: observation.outcome,
        errorCode: observation.errorCode,
      };
      if (!Value.Check(ExecutionEventSchema, event)) {
        throw new TypeError('The analytics event does not match ExecutionEventSchema.');
      }
      const result = await options.record(env, event);
      if (result && typeof result === 'object' && 'ok' in result && result.ok === false) {
        throw new Error('Analytics sink rejected the event.');
      }
    },
  };
}
