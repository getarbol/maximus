/**
 * Compile-only coverage of `middleware/` modules: each phase keeps its own context, request middleware sees
 * no principal, and only the two helpers make a module.
 */
import { defineErrors, maximus, ok } from '../../src/index.ts';
import {
  collectMiddleware,
  defineMiddleware,
  defineOperationMiddleware,
  useProjectMiddleware,
} from '../../src/project/config.ts';

const base = maximus<{ prefix: string }>({
  name: 'project',
  namespace: 'project',
  title: 'Project',
  version: '1',
  origin: 'https://project.example.test',
  tokens: { issuer: 'https://issuer.example.test', audience: 'project' },
  errors: defineErrors({}),
  rpc: { callers: [] },
}).derive(async ({ env }) => ok({ label: env.prefix }));

const policy = defineOperationMiddleware<{ label: string }>(async ({ label }, proceed) => {
  const inferred: string = label;
  // @ts-expect-error Operation middleware keeps its context's types.
  const count: number = label;
  void [inferred, count];
  return proceed();
});
const headers = defineMiddleware<{ prefix: string }>(async (_request, env, context, proceed) => {
  const prefix: string = env.prefix;
  // @ts-expect-error Request middleware never receives a principal before admission.
  void context.principal;
  void prefix;
  return proceed();
});
const { middleware, requestMiddleware } = collectMiddleware([headers, policy] as const);
useProjectMiddleware(base, middleware);
void requestMiddleware;
// @ts-expect-error A middleware module comes from defineMiddleware or defineOperationMiddleware.
collectMiddleware([async () => new Response()] as const);
