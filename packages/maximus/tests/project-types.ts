/** Compile-only coverage: file routes keep schema, exposure, derived context and native RPC inference. */
import { defineErrors, maximus, ok, t } from '../src/index.ts';
import type { Principal } from '../src/index.ts';
import {
  createRoute,
  defineConfig,
  defineMiddleware,
  defineOperationMiddleware,
  useProjectMiddleware,
} from '../src/project/config.ts';
import type { ProjectContext } from '../src/project/config.ts';
import type { RpcMethods } from '../src/workers/runtime.ts';

const config = defineConfig({
  application: maximus<{ prefix: string }>({
    name: 'project',
    namespace: 'project',
    title: 'Project',
    version: '1',
    origin: 'https://project.example.test',
    tokens: { issuer: 'https://issuer.example.test', audience: 'project' },
    errors: defineErrors({}),
    rpc: { callers: ['consumer'] },
  }).derive(async ({ env }) => ok({ label: env.prefix })),
});
const policy = defineOperationMiddleware<ProjectContext<typeof config>>(async ({ label }, proceed) => {
  const inferred: string = label;
  void inferred;
  return proceed();
});
const base = useProjectMiddleware(config.application, [policy.handle]);
const defineRoute = createRoute(base);
const schema = t.Object({ message: t.String() }, { additionalProperties: false });
const definition = {
  title: 'Greeting',
  description: 'Return a greeting.',
  scope: 'project:greeting:read',
  effect: 'read' as const,
  input: schema,
  output: schema,
  rpc: true as const,
  mcp: { name: 'getGreeting', idempotent: true },
};
const GET = defineRoute('getGreeting', definition, async ({ label }, input) => {
  // @ts-expect-error Derived context retains its string type.
  const number: number = label;
  // @ts-expect-error Input remains the declared schema.
  void input.unknown;
  void number;
  return ok({ message: label + input.message });
});
const app = base.mount(GET('/v1/greeting', 'GET')).build();
const path: '/v1/greeting' = app.operations.getGreeting.http.path;
const method: 'GET' = app.operations.getGreeting.http.method;
void [path, method];
declare const rpc: RpcMethods<typeof app.operations>;
declare const principal: Principal;
void rpc.getGreeting(principal, { message: 'hello' });
// @ts-expect-error Native RPC retains the input contract.
void rpc.getGreeting(principal, { message: 123 });
// @ts-expect-error Named operations do not widen to arbitrary keys.
void rpc.otherMethod;
// @ts-expect-error Output must match the declared schema.
defineRoute('badOutput', definition, async () => ok({ message: 1 }));
defineRoute(
  'badPath',
  // @ts-expect-error Paths belong to the file convention even alongside valid HTTP options.
  { ...definition, http: { successStatus: 200, path: '/v1/override' } },
  async (_context, input) => ok(input)
);
defineMiddleware<{ prefix: string }>(async (_request, env, context, proceed) => {
  const prefix: string = env.prefix;
  // @ts-expect-error Request middleware never receives a principal before admission.
  void context.principal;
  void prefix;
  return proceed();
});
