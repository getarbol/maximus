/**
 * `@arbol-ai/maximus/schemas`: the browser-safe schema vocabulary: TypeBox (`t`), its types, the validators
 * and the shared identifier schemas, with nothing that needs a Worker runtime. A contract module that
 * browsers import (a Dashboard reading an API's limits, a widget's settings) imports from here rather than
 * the package root.
 */
import { Type } from '@sinclair/typebox';

export { Type, Type as t } from '@sinclair/typebox';
export type { Static, TSchema } from '@sinclair/typebox';
export type { StaticDecode } from './schema-types.ts';
export { parseInput, parseSchema, decodeInput, decodeSchema } from './validation.ts';
export type { InputIssue } from './validation.ts';

/** The input of an operation that takes none: an empty strict object. */
export const EmptyInputSchema = Type.Object({}, { additionalProperties: false });
/**
 * An organization id as identity providers issue them (`org_…`, a UUID, a slug): 1 to 128 letters, digits,
 * `_` and `-`, starting with a letter or digit, named `OrganizationId`. Nothing in it can change the meaning
 * of a storage key, a path or a log line.
 */
export const OrganizationIdSchema = Type.String({
  $id: 'OrganizationId',
  pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$',
  description: 'Verified organization identifier.',
});
/** A lowercase RFC 9562 UUID of version 1 to 8, named `Uuid`. */
export const UuidSchema = Type.String({
  $id: 'Uuid',
  format: 'uuid',
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});

export {
  literalUnion,
  defaultSchema,
  stripObject,
  strictObject,
  looseObject,
  extendObject,
  normalizeSchema,
  transformSchema,
  pipeSchema,
  inspectSchema,
  refineSchema,
  urlSchema,
  inputSchema,
  SchemaValidationError,
} from './input-schemas.ts';
export type { SchemaInput, SchemaIssue } from './input-schemas.ts';
export { checkSchema, readSchema } from './schema-reader.ts';
export type { Checked } from './schema-reader.ts';

export { AttachmentOutputSchema } from './attachment-schema.ts';
export type { Attachment } from './attachment-schema.ts';
export { Page, PageInfoSchema, PageQueryFields, pageLimit } from './pagination.ts';
export {
  DeletedObjectSchema,
  EmailAddressSchema,
  HexColorSchema,
  HttpsUrlSchema,
  NamedReferenceSchema,
  PhoneNumberSchema,
  PostalAddressSchema,
  SignedUrlSchema,
} from './common-schemas.ts';
export type { DeletedObject, NamedReference, PostalAddress, SignedUrl } from './common-schemas.ts';
export type { PageInfo, PageQuery, TPage } from './pagination.ts';
