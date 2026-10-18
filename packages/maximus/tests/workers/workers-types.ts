/**
 * Type tests of the Workers entry: an RPC method exists only for an operation that declares `rpc`, takes
 * its encoded input (codec fields as their source, defaulted fields optional) and answers its declared
 * output; `createWorker` takes the named `WorkerOptions`.
 */
import { defineErrors, maximus, ok, t } from '../../src/index.ts';
import type { Principal } from '../../src/index.ts';
import { defaultSchema, inputSchema, transformSchema } from '../../src/schemas.ts';
import { createWorker } from '../../src/workers/runtime.ts';
import type { RpcMethods, WorkerOptions } from '../../src/workers/runtime.ts';

/** The bindings the test Worker declares. */
interface Env {
  ASSETS: Fetcher;
  LABEL: string;
}

const Count = t.Object({ count: t.Integer() }, { additionalProperties: false });
const app = maximus<Env>({
  name: 'demo',
  namespace: 'demo',
  title: 'Demo',
  version: '1',
  origin: 'https://demo.test',
  tokens: { issuer: 'https://issuer.example.test/', audience: 'demo' },
  errors: defineErrors({}),
  rpc: { callers: ['orders'] },
})
  .operation(
    'tagRecord',
    {
      scope: 'demo:records:write',
      title: 'Tag a record',
      description: 'Tag a record.',
      effect: 'write',
      input: inputSchema(
        t.Object(
          {
            tags: transformSchema(t.String(), (value) => value.split(',')),
            limit: defaultSchema(t.Integer({ minimum: 1 }), 10),
          },
          { additionalProperties: false }
        )
      ),
      output: Count,
      rpc: true,
    },
    async (_context, input) => ok({ count: Math.min(input.tags.length, input.limit) })
  )
  .operation(
    'countRecords',
    {
      scope: 'demo:records:read',
      title: 'Count records',
      description: 'Count the records.',
      effect: 'read',
      input: t.Object({}, { additionalProperties: false }),
      output: Count,
      http: { method: 'GET', path: '/v1/records/count' },
    },
    async () => ok({ count: 0 })
  )
  .build();

declare const methods: RpcMethods<typeof app.operations>;
declare const principal: Principal;
void methods.tagRecord(principal, { tags: 'urgent,billing' }).then((result) => {
  const count: number | undefined = result.ok ? result.value.count : undefined;
  return count;
});
// @ts-expect-error An RPC caller sends a transformed field as its source.
void methods.tagRecord(principal, { tags: ['urgent', 'billing'] });
// @ts-expect-error Only an operation that declares rpc is a method.
void methods.countRecords;

const options: WorkerOptions<Env> = { assets: { binding: 'ASSETS', pages: { paths: ['/'] } } };
createWorker(app, options);
// @ts-expect-error The assets binding names one of the env's asset bindings.
const notAnAssetBinding: WorkerOptions<Env> = { assets: { binding: 'LABEL' } };
void notAnAssetBinding;
