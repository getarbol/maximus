/**
 * `@arbol-ai/maximus/testing`: a contract smoke test for a local or deployed service.
 */
import { parse } from 'yaml';

/** One deployed contract smoke; security and protocol matrices remain framework tests. */
export async function verifyContract(fetch: (request: Request) => Promise<Response>, origin: string) {
  const json = await fetch(new Request(`${origin}/openapi.json`));
  const yaml = await fetch(new Request(`${origin}/openapi.yaml`));
  if (!json.ok || !yaml.ok) {
    throw new Error('OpenAPI is unavailable.');
  }
  const schema = (await json.json()) as { paths: Record<string, Record<string, { operationId: string }>> };
  if (JSON.stringify(schema) !== JSON.stringify(parse(await yaml.text()))) {
    throw new Error('OpenAPI JSON/YAML differ.');
  }
  return {
    paths: Object.keys(schema.paths),
    operations: Object.values(schema.paths).flatMap((path) =>
      Object.values(path).map((op) => op.operationId)
    ),
  };
}
