/**
 * The one execution path every transport calls: the caller's eligibility, input decoding, context
 * preparation, middleware, the handler, and the checks on what it returns.
 */
import { Value } from '@sinclair/typebox/value';

import { isAttachmentSchema, validAttachment } from './binary.ts';
import type { BinaryBody } from './binary.ts';
import { standardErrors } from './errors.ts';
import type { Failure } from './errors.ts';
import {
  ADMISSION_CODES,
  BODY_CODES,
  STANDARD_CODES,
  operationMatchesScopes,
  operationOutputLimit,
} from './manifest.ts';
import type { AppManifest, OperationShape, InvocationAuthority } from './manifest.ts';
import { err } from './result.ts';
import type { Result } from './result.ts';
import { telemetryEnabled, reportUnexpected } from './telemetry.ts';
import type { BackgroundContext } from './telemetry.ts';
import type { Principal } from './tokens.ts';
import { decodeInput } from './validation.ts';

/**
 * The execution path every transport shares: checks that the caller may run the operation (its scopes when
 * `authority` is given, its actor kind, and `authority` itself when the operation has conditional scopes),
 * decodes the input, prepares the context, runs the middleware and the handler, then checks the result
 * against the catalog, the declared failures, the output schema and the output limit. A refused caller
 * answers `FORBIDDEN` and a refused input `INVALID_INPUT`. An unexpected error becomes `INTERNAL_ERROR`,
 * reported while telemetry is on, and is never thrown.
 */
export async function executeOperation<E, C, O extends Record<string, OperationShape>>(
  manifest: AppManifest<E, C, O>,
  operation: OperationShape,
  env: E,
  principal: Principal,
  input: unknown,
  authority?: InvocationAuthority,
  background?: BackgroundContext,
  body?: BinaryBody
): Promise<Result<unknown, Failure>> {
  if (
    (operation.conditionalScopes?.length && !authority) ||
    (authority && !operationMatchesScopes(operation, authority.scopes)) ||
    (operation.actorKinds && !operation.actorKinds.includes(principal.actorKind))
  ) {
    return err(standardErrors.forbidden.create());
  }
  try {
    // A refused input answers INVALID_INPUT; an owner codec that fails is the server's error, caught below.
    const admitted = decodeInput(operation.input, input);
    if (!admitted.ok) {
      return err(standardErrors.invalidInput.create(admitted.error.data));
    }
    const trustedAuthority = authority
      ? Object.freeze({
          surface: authority.surface,
          scopes: Object.freeze([...authority.scopes]),
          client: Object.freeze({ ...authority.client }),
          ...(authority.token ? { token: authority.token } : {}),
        })
      : undefined;
    const invocation = {
      env,
      principal,
      input: admitted.value,
      ...(body ? { body } : {}),
      ...(background ? { background } : {}),
      ...(trustedAuthority ? { authority: trustedAuthority } : {}),
    };
    /**
     * A failure the call answers, from its context, middleware or handler: one of the catalog and, when the
     * operation declares its failures, a declared or standard one. A failure only admission answers, or a
     * body's for an operation that reads no byte body, is never the operation's. Any other is the server's
     * error.
     */
    const declared = (answered: Failure): Failure => {
      const failure = manifest.errors.validate(answered);
      if (
        ADMISSION_CODES.has(failure.code) ||
        (BODY_CODES.has(failure.code) && operation.http?.body !== 'bytes')
      ) {
        throw new TypeError(`Failure ${failure.code} is answered before an operation runs, never by it`);
      }
      if (
        operation.failures &&
        !STANDARD_CODES.has(failure.code) &&
        !operation.failures.includes(failure.code)
      ) {
        throw new TypeError(`Undeclared failure ${failure.code}`);
      }
      return failure;
    };
    const context = operation.pipeline
      ? await operation.pipeline.context(invocation as never)
      : await manifest.context(invocation);
    if (!context.ok) {
      return err(declared(context.error));
    }
    const chain = operation.pipeline?.middleware ?? manifest.middleware ?? [];
    let latest = -1;
    /**
     * Runs the middleware at `index`, whose `next` runs the following one, until the handler; each `next`
     * runs once.
     */
    const dispatch = async (index: number): Promise<Result<unknown, Failure>> => {
      if (index <= latest) {
        throw new Error('Middleware next() may be called only once.');
      }
      latest = index;
      const middleware = chain[index];
      return await (middleware
        ? middleware(context.value as never, () => dispatch(index + 1))
        : (operation.execute as (context: C, input: unknown) => Promise<Result<unknown, Failure>>)(
            context.value as C,
            admitted.value
          ));
    };
    const result = await dispatch(0);
    if (
      !result ||
      typeof result.ok !== 'boolean' ||
      !Object.hasOwn(result, 'ok') ||
      Object.keys(result).length !== 2 ||
      !Object.hasOwn(result, result.ok ? 'value' : 'error')
    ) {
      throw new TypeError('Invalid operation result');
    }
    if (!result.ok) {
      return err(declared(result.error));
    }
    const maxOutputBytes = operationOutputLimit(manifest, operation);
    if (isAttachmentSchema(operation.output)) {
      if (!validAttachment(result.value, maxOutputBytes)) {
        throw new TypeError('Invalid attachment output');
      }
      return result;
    }
    if (!Value.Check(operation.output, result.value)) {
      throw new TypeError('Invalid operation output');
    }
    if (new TextEncoder().encode(JSON.stringify(result.value)).byteLength > maxOutputBytes) {
      throw new TypeError('Operation output exceeds its limit');
    }
    return result;
  } catch (error) {
    if (telemetryEnabled(manifest.telemetry, env)) {
      reportUnexpected(error, 'operation', principal.requestId);
    }
    return err(standardErrors.internal.create());
  }
}
