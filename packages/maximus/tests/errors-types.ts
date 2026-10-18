/**
 * Type tests of error catalogs: `create()` takes exactly the data a definition declares, `validate()` and
 * the union schema name the catalog's own failures rather than `any`, a catalog is an `ErrorCatalog`, and
 * a domain failure cannot take a standard failure's name or a catalog member's.
 */
import { defineErrors, resultSchema, standardErrors, t } from '../src/index.ts';
import type { DefinedErrors, ErrorCatalog, ErrorFactory, Failure, Static } from '../src/index.ts';

const errors = defineErrors({
  quotaExceeded: {
    code: 'QUOTA_EXCEEDED',
    status: 429,
    message: 'The organization has reached its quota.',
    retryable: true,
    dataSchema: t.Object({ limit: t.Integer() }, { additionalProperties: false }),
  },
  partialImport: {
    code: 'PARTIAL_IMPORT',
    status: 409,
    message: 'Some rows were not imported.',
    dataSchema: t.Object({ row: t.Optional(t.Integer()) }, { additionalProperties: false }),
  },
  recordNotFound: { code: 'RECORD_NOT_FOUND', status: 404, message: 'The record does not exist.' },
});

errors.quotaExceeded.create({ limit: 100 });
// @ts-expect-error A definition with required data needs it.
errors.quotaExceeded.create();
// @ts-expect-error The data follows the definition's schema.
errors.quotaExceeded.create({ limit: '100' });
errors.partialImport.create();
errors.partialImport.create({ row: 3 });
errors.recordNotFound.create();
// @ts-expect-error A definition without data takes none.
errors.recordNotFound.create({ row: 3 });
const missing = errors.recordNotFound.create();
const code: 'RECORD_NOT_FOUND' = missing.code;
// @ts-expect-error The code is the definition's literal.
const otherCode: 'NOT_FOUND' = missing.code;

const validated = errors.validate({});
const failure: Failure = validated;
// @ts-expect-error A validated failure is one of the catalog's, not `any`.
const { unknownField } = validated;
if (validated.code === 'QUOTA_EXCEEDED') {
  const limit: number = validated.data.limit;
  void limit;
}
type CatalogFailure = Static<typeof errors.schema>;
const ImportOutcome = resultSchema(t.Object({ imported: t.Integer() }), errors.schema);
const outcome: Static<typeof ImportOutcome> = { ok: false, error: errors.recordNotFound.create() };
if (!outcome.ok) {
  const outcomeCode: string = outcome.error.code;
  void outcomeCode;
}
// @ts-expect-error The union schema admits only the catalog's failures.
const foreign: CatalogFailure = { code: 'FOREIGN', message: 'x', retryable: false, data: {} };

const catalog: ErrorCatalog = errors;
const standard: DefinedErrors<Record<never, never>> = standardErrors;
const factory: ErrorFactory<{
  code: 'RECORD_NOT_FOUND';
  status: 404;
  message: 'The record does not exist.';
}> = errors.recordNotFound;
// @ts-expect-error The standard catalog has no domain failures.
const { recordNotFound } = standardErrors;

// @ts-expect-error A domain failure named after a catalog member would hide its factory.
defineErrors({ status: { code: 'STATUS_CONFLICT', status: 409, message: 'Conflict.' } });
// @ts-expect-error Standard names are reserved.
defineErrors({ notFound: { code: 'MISSING', status: 404, message: 'Missing.' } });

void [code, otherCode, failure, unknownField, foreign, catalog, standard, factory, recordNotFound];
