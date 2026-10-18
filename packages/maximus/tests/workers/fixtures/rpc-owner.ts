/**
 * A Worker whose operations are served over RPC to the callers they name, for the workerd RPC tests.
 */
import { maximus, t, defineErrors, ok } from '../../../src/index.ts';
import { createWorker } from '../../../src/workers/runtime.ts';

const schema = t.Object({ managed: t.Boolean() }, { additionalProperties: false });
const app = maximus<Record<string, never>>({
  name: 'fixture',
  namespace: 'fixture',
  title: 'Fixture',
  version: '1',
  origin: 'https://fixture.test',
  tokens: { issuer: 'https://issuer.fixture.test/', audience: 'fixture' },
  errors: defineErrors({}),
  rpc: { callers: ['internal', 'reports'] },
  telemetry: { enabled: false },
})
  .operation(
    'internalRead',
    {
      scope: 'fixture:internal:read',
      title: 'Internal',
      description: 'Internal fixture',
      effect: 'read',
      input: schema,
      output: t.Object({ organizationId: t.String(), managed: t.Boolean() }, { additionalProperties: false }),
      rpc: { callers: ['internal'] },
    },
    async ({ principal }, input) => ok({ organizationId: principal.organizationId, managed: input.managed })
  )
  .operation(
    'conditionalRead',
    {
      scope: 'fixture:internal:read',
      conditionalScopes: ['fixture:internal:manage'],
      title: 'Conditional',
      description: 'Conditional fixture',
      effect: 'read',
      input: schema,
      output: schema,
      rpc: true,
    },
    async (_context, input) => ok(input)
  )
  .build();
const runtime = createWorker(app);
export const InternalEntrypoint = runtime.entrypoint;
export default { fetch: () => new Response(null, { status: 404 }) };

type AssertFalse<T extends false> = T;
type IsNever<T> = [T] extends [never] ? true : false;
export type NativeReturnMustExist = AssertFalse<
  IsNever<Awaited<ReturnType<Service<typeof InternalEntrypoint>['internalRead']>>>
>;
// @ts-expect-error Negative control must fail, otherwise the serializable-return guard is ineffective.
export type NeverNegativeControl = AssertFalse<IsNever<never>>;
