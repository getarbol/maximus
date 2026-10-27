/**
 * What middleware/ declares and how the generated modules apply it: middleware declared for the request or the
 * operation phase and split by collectMiddleware, operation policy applied in filename order, and
 * checkProjectPipeline refusing an operation declared without that policy.
 */
import { describe, expect, it } from 'vite-plus/test';

import { createHttpHandler, defineErrors, maximus, ok, t } from '../../src/index.ts';
import type { Invocation, OperationMiddleware } from '../../src/index.ts';
import { defineApp, operation } from '../../src/internals.ts';
import {
  checkProjectPipeline,
  collectMiddleware,
  defineMiddleware,
  defineOperationMiddleware,
  useProjectMiddleware,
} from '../../src/project/config.ts';

interface Env {
  DEVELOPMENT_TOKEN: string;
}

/** The development token the policy accepts from localhost: every declared scope. */
const TOKEN = 'local-development-token-0123456789';
const env: Env = { DEVELOPMENT_TOKEN: TOKEN };

/** A notes service's configuration. */
function configuration() {
  return {
    name: 'notes',
    namespace: 'notes',
    title: 'Notes',
    version: '1',
    origin: 'https://notes.example.test',
    tokens: {
      issuer: 'https://issuer.example.test/',
      audience: 'https://notes.example.test',
      development: { binding: 'DEVELOPMENT_TOKEN' },
    },
    errors: defineErrors({}),
    rpc: { callers: [] },
    telemetry: { enabled: false },
  };
}

/** The base a configuration starts. */
function application() {
  return maximus<Env>(configuration());
}

const empty = t.Object({}, { additionalProperties: false });
const listing = {
  scope: 'notes:notes:read',
  title: 'List notes',
  description: 'List the notes.',
  effect: 'read' as const,
  input: empty,
  output: t.Object({ count: t.Integer() }, { additionalProperties: false }),
  http: { method: 'GET' as const, path: '/v1/notes' },
};
const archiving = {
  ...listing,
  title: 'Archive notes',
  description: 'Archive the done notes.',
  scope: 'notes:notes:write',
  effect: 'write' as const,
  http: { method: 'POST' as const, path: '/v1/notes/archive' },
};
const passThrough: OperationMiddleware<Invocation<Env>> = async (_context, proceed) => proceed();

describe('middleware modules', () => {
  it('name their phase', async () => {
    const handle = async (
      _request: Request,
      _env: Env,
      _context: unknown,
      proceed: () => Promise<Response>
    ) => proceed();
    expect(defineMiddleware<Env>(handle)).toEqual({ phase: 'request', handle });
    expect(defineOperationMiddleware(passThrough)).toEqual({ phase: 'operation', handle: passThrough });
  });

  it('split into the two phases in their order', () => {
    const headers = defineMiddleware<Env>(async (_request, _env, _context, proceed) => proceed());
    const cors = defineMiddleware<Env>(async (_request, _env, _context, proceed) => proceed());
    const audit = defineOperationMiddleware(passThrough);
    const policy = defineOperationMiddleware<Invocation<Env>>(async (_context, proceed) => proceed());
    const { middleware, requestMiddleware } = collectMiddleware([headers, audit, policy, cors] as const);
    expect(middleware).toEqual([passThrough, policy.handle]);
    expect(requestMiddleware).toEqual([headers.handle, cors.handle]);
  });

  it('are refused when they name no phase or no handler, as a bare function is', () => {
    for (const module of [
      passThrough,
      undefined,
      {},
      { phase: 'request' },
      { phase: 'operation', handle: 'proceed' },
      { phase: 'response', handle: passThrough },
    ]) {
      expect(() => collectMiddleware([module as never]), JSON.stringify(module)).toThrow(
        new TypeError(
          'A middleware module must default-export defineMiddleware or defineOperationMiddleware.'
        )
      );
    }
  });
});

it('useProjectMiddleware wraps every operation declared after it, in the order of the files', async () => {
  const trail: string[] = [];
  const step =
    (name: string): OperationMiddleware<Invocation<Env>> =>
    async (_context, proceed) => {
      trail.push(`${name} in`);
      const result = await proceed();
      trail.push(`${name} out`);
      return result;
    };
  const audit = step('10-audit');
  const tenant = step('20-tenant');
  const configured = application();
  expect(useProjectMiddleware(configured, [])).toBe(configured);
  const base = useProjectMiddleware(configured, [audit, tenant]);
  expect(base.definition.middleware).toEqual([audit, tenant]);
  const app = base
    .operation('listNotes', listing, async () => {
      trail.push('handler');
      return ok({ count: 0 });
    })
    .build();
  const response = await createHttpHandler(app)(
    new Request('http://localhost:5173/v1/notes', { headers: { authorization: `Bearer ${TOKEN}` } }),
    env
  );
  expect(response.status).toBe(200);
  expect(trail).toEqual(['10-audit in', '20-tenant in', 'handler', '20-tenant out', '10-audit out']);
});

describe('checkProjectPipeline', () => {
  it('accepts operations declared after the project middleware, or on a base derived from it', () => {
    const base = useProjectMiddleware(application(), [passThrough]);
    const derived = base.use(async (_context, proceed) => proceed());
    const app = base
      .operation('listNotes', listing, async () => ok({ count: 0 }))
      .mount(derived.operation('archiveNotes', archiving, async () => ok({ count: 0 })))
      .build();
    expect(checkProjectPipeline(base, app)).toBe(app);
    // A base without project middleware has no policy to omit.
    const plain = application();
    const plainApp = plain.operation('listNotes', listing, async () => ok({ count: 0 })).build();
    expect(checkProjectPipeline(plain, plainApp)).toBe(plainApp);
  });

  it('refuses an operation whose factory captured the base before the project middleware', () => {
    const configured = application();
    const base = useProjectMiddleware(configured, [passThrough]);
    const stale = configured.operation('archiveNotes', archiving, async () => ok({ count: 0 }));
    const app = base
      .operation('listNotes', listing, async () => ok({ count: 0 }))
      .mount(stale)
      .build();
    expect(() => checkProjectPipeline(base, app)).toThrow(
      new TypeError(
        'Operation "archiveNotes" omits project middleware. Bind it to the base in .maximus/base.ts.'
      )
    );
  });

  it('refuses an operation assembled without the builder, which carries no pipeline', () => {
    const configured = application();
    const assembled = defineApp<Env, Invocation<Env>>()({
      ...configured.definition,
      operations: {
        listNotes: operation<
          Invocation<Env>,
          typeof empty,
          typeof listing.output,
          { http: typeof listing.http }
        >({
          ...listing,
          execute: async () => ok({ count: 0 }),
        }),
      },
    });
    expect(() => checkProjectPipeline(useProjectMiddleware(configured, [passThrough]), assembled)).toThrow(
      'Operation "listNotes" omits project middleware.'
    );
  });
});
