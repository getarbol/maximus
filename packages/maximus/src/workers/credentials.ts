/**
 * Reads one organization's credential from its own store, such as a Durable Object per organization, and
 * checks that it belongs to that organization.
 */
import { err, ok, parseInput, standardErrors } from '../index.ts';
import type { Failure, Principal, Result, Static, TSchema } from '../index.ts';

/** Typed organization credential preparation for one derived operation group. */
export async function credentials<Schema extends TSchema>(options: {
  principal: Principal;
  accounts: {
    getByName: (name: string) => {
      readCredential: (organizationId: string) => Promise<Result<unknown, Failure>>;
    };
  };
  schema: Schema;
}): Promise<Result<{ credential: Static<Schema> }, Failure>> {
  const { organizationId } = options.principal;
  const result = await options.accounts.getByName(organizationId).readCredential(organizationId);
  if (!result.ok) {
    return result;
  }
  const parsed = parseInput(options.schema, result.value);
  if (
    !parsed.ok ||
    !parsed.value ||
    typeof parsed.value !== 'object' ||
    !('organizationId' in parsed.value) ||
    parsed.value.organizationId !== organizationId
  ) {
    return err(standardErrors.internal.create());
  }
  return ok({ credential: parsed.value });
}
