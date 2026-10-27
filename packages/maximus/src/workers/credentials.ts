/**
 * Reads one organization's credential from its own store, such as a Durable Object per organization, and
 * checks that it belongs to that organization.
 */
import { err, ok, parseInput, standardErrors } from '../index.ts';
import type { Failure, Principal, Result, Static, TSchema } from '../index.ts';

/**
 * Reads the caller's organization credential, for a `.derive()` that prepares it: `accounts.getByName`
 * addresses the organization's own store by its id (a Durable Object namespace, for example), whose
 * `readCredential` answers the credential. A failure it answers is returned as it is; a credential that does
 * not match `schema` or names another `organizationId` answers `INTERNAL_ERROR`. Otherwise it answers
 * `{ credential }`.
 */
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
