/**
 * Type tests of the fluent builder: the context `.derive()` infers, read-only authority, the schemas a
 * handler is held to, the fields a definition may name, operation names declared once (by `.operation()`
 * and by `.mount()`), the named configuration, middleware and Result types, and the token audience.
 */
import { createHttpHandler, defineErrors, err, maximus, ok, standardErrors, t } from '../src/index.ts';
import type {
  ApplicationConfiguration,
  BackgroundContext,
  Exposure,
  Failure,
  FailureResult,
  HttpOptions,
  OperationMiddleware,
  Success,
  TokenPolicy,
} from '../src/index.ts';

const base = maximus<{ key: string }>({
  name: 'demo',
  namespace: 'demo',
  title: 'Demo',
  version: '2',
  origin: 'https://demo.test',
  tokens: { issuer: 'https://issuer.example.test/', audience: 'demo' },
  errors: defineErrors({}),
  rpc: { callers: [] },
}).derive(async ({ env }) => ok({ value: env.key }));
const schema = t.Object({ found: t.Boolean() }, { additionalProperties: false });
const definition = {
  scope: 'demo:records:read',
  title: 'Read',
  description: 'Read',
  effect: 'read' as const,
  input: schema,
  output: schema,
};
base.operation('readRecord', definition, async (context, input) => {
  // @ts-expect-error Authority is read-only, even after derived preparation.
  context.authority = undefined;
  if (context.authority) {
    // @ts-expect-error A handler cannot extend the verified scope set.
    context.authority.scopes.push('demo:records:manage');
  }
  const value: string = context.value;
  // @ts-expect-error Context retains its inferred string type.
  const invalid: number = context.value;
  // @ts-expect-error Schema inference rejects properties not in the input.
  const { missing } = input;
  return ok({ found: Boolean(value) && input.found && Boolean(invalid) && Boolean(missing) });
});
// @ts-expect-error Output must satisfy the declared schema.
base.operation('broken', definition, async () => ok({ found: 'wrong' }));
base.operation(
  'unrouted',
  {
    ...definition,
    actorKinds: ['user'],
    // @ts-expect-error A field no operation has, such as a retired `api` name, is refused, not ignored.
    api: { resource: 'records', verb: 'get' },
  },
  async (_context, input) => ok(input)
);
const one = base.operation('readRecord', definition, async (_context, input) => ok(input));
// @ts-expect-error Duplicate names fail at compile time as well as runtime.
one.operation('readRecord', definition, async (_context, input) => ok(input));
const connected = base.derive(async () => ok({ credential: 'server-only' }));
const protectedResource = connected.operation('protectedRead', definition, async (context, input) => {
  const credential: string = context.credential;
  return ok({ found: Boolean(credential) && input.found });
});
const management = base.operation('configure', definition, async (context, input) => {
  // @ts-expect-error Credential preparation is scoped to the connected group.
  const { credential } = context;
  void credential;
  return ok(input);
});
base.mount(protectedResource).mount(management).build();

const audiences: TokenPolicy = {
  issuer: 'https://issuer.example.test/',
  audience: ['https://demo.test', 'https://platform.example.test'],
};
// @ts-expect-error A token audience is a string or a list of strings.
const numbered: TokenPolicy = { issuer: 'https://issuer.example.test/', audience: ['https://demo.test', 1] };
// @ts-expect-error The audience may be a list; the first one is the canonical resource.
const resource: string = audiences.audience;
void numbered;
void resource;

const twice = base.operation('readRecord', definition, async (_context, input) => ok(input));
// @ts-expect-error A module that declares an operation the base already has is refused before it throws.
twice.mount(one);
twice.mount(management);

const configuration: ApplicationConfiguration<{ key: string }> = {
  name: 'demo',
  namespace: 'demo',
  title: 'Demo',
  version: '2',
  origin: 'https://demo.test',
  tokens: { issuer: 'https://issuer.example.test/', audience: 'demo' },
  errors: defineErrors({}),
  rpc: { callers: [] },
};
const configured = maximus(configuration);
// @ts-expect-error The builder declares the operations; the configuration has none.
const withOperations: ApplicationConfiguration<{ key: string }> = { ...configuration, operations: {} };

const forwarding: OperationMiddleware<{ value: string }> = async (context, next) =>
  context.value ? next() : err(standardErrors.forbidden.create());
base.use(forwarding);
const needsMissing: OperationMiddleware<{ missing: number }> = async (_context, next) => next();
// @ts-expect-error Middleware reads only the context the builder prepared.
base.use(needsMissing);

const success: Success<number> = ok(1);
const failed: FailureResult<Failure> = err(standardErrors.notFound.create());
// @ts-expect-error A success carries its value, never an error.
const mislabeled: FailureResult<Failure> = ok(1);

const exposure: Exposure = { http: { method: 'GET', path: '/v1/records' }, rpc: true };
// @ts-expect-error An HTTP route uses a method the router serves.
const traced: Exposure = { http: { method: 'TRACE', path: '/v1/records' } };
const options: HttpOptions<{ key: string }> = { basePath: '/api' };
const handle = createHttpHandler(configured.build(), options);
declare const background: BackgroundContext;
void handle(new Request('https://demo.test/api/health'), { key: 'k' }, background);
void [withOperations, success, failed, mislabeled, exposure, traced];
