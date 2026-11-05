/**
 * The one execution path every transport calls: the caller's eligibility, input decoding, context
 * preparation, middleware, the handler, and the checks on what it returns.
 */
import { Value } from '@sinclair/typebox/value';

import { isAttachmentSchema, validAttachment } from './binary.ts';
import type { BinaryBody } from './binary.ts';
import { standardErrors } from './errors.ts';
import type { Failure } from './errors.ts';
import { STANDARD_CODES, operationMatchesScopes, operationOutputLimit } from './manifest.ts';
import type { AppManifest, OperationShape, InvocationAuthority } from './manifest.ts';
import { err } from './result.ts';
import type { Result } from './result.ts';
import { telemetryEnabled, reportUnexpected } from './telemetry.ts';
import type { BackgroundContext } from './telemetry.ts';
import type { Principal } from './tokens.ts';
import { admitInput } from './validation.ts';

/**
 * What a transport knows of one call beyond its principal and token, and where execution leaves what the
 * recording points read once the call has answered.
 */
export interface ExecutionCall {
  /** Over native RPC, the caller admission checked: `Invocation.rpcCaller`. */
  readonly rpcCaller?: string;
  /** On HTTP and MCP, the request's user agent: `Invocation.userAgent`. */
  readonly userAgent?: string;
  /** Set once the input is admitted: what its schema checked, and the decoded value the handler receives. */
  admitted?: { readonly checked: unknown; readonly decoded: unknown };
  /** Set once preparation answers: the context the handler receives. */
  context?: unknown;
}

/**
 * The execution path every transport shares: checks that the caller may run the operation, decodes the input,
 * prepares the context, runs the middleware and the handler, then checks the result against the declared
 * output and failures. An unexpected error becomes `INTERNAL_ERROR` and is reported, never thrown. `call` hands
 * the admitted input and the prepared context to the recording points, which only the Result would otherwise
 * reach.
 */
export async function executeOperation<E, C, O extends Record<string, OperationShape>>(
  manifest: AppManifest<E, C, O>,
  operation: OperationShape,
  env: E,
  principal: Principal,
  input: unknown,
  authority?: InvocationAuthority,
  background?: BackgroundContext,
  body?: BinaryBody,
  call?: ExecutionCall
): Promise<Result<unknown, Failure>> {
  if (
    (operation.conditionalScopes?.length && !authority) ||
    (authority && !operationMatchesScopes(operation, authority.scopes)) ||
    (operation.actorKinds && !operation.actorKinds.includes(principal.actorKind))
  ) {
    return err(standardErrors.forbidden.create());
  }
  const admitted = admitInput(operation.input, input);
  if (!admitted.ok) {
    return err(standardErrors.invalidInput.create(admitted.error.data));
  }
  if (call) {
    call.admitted = { checked: admitted.checked, decoded: admitted.value };
  }
  try {
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
      ...(call?.rpcCaller ? { rpcCaller: call.rpcCaller } : {}),
      ...(call?.userAgent ? { userAgent: call.userAgent } : {}),
    };
    const context = operation.pipeline
      ? await operation.pipeline.context(invocation as never)
      : await manifest.context(invocation);
    if (!context.ok) {
      return err(manifest.errors.validate(context.error));
    }
    if (call) {
      call.context = context.value;
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
      const failure = manifest.errors.validate(result.error);
      if (
        operation.failures &&
        !STANDARD_CODES.has(failure.code) &&
        !operation.failures.includes(failure.code)
      ) {
        throw new TypeError(`Undeclared failure ${failure.code}`);
      }
      return err(failure);
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
