/**
 * Values and objects that services publish alike, each named by its `$id`: an OpenAPI document carries
 * it once as `#/components/schemas/<name>`, and every SDK generated from those documents has one type
 * for it. A name is public, so it names exactly one shape. Domain records (people, patients,
 * identity documents) stay with the service that owns them.
 */
import { Type } from '@sinclair/typebox';
import type { Static, TString } from '@sinclair/typebox';

/** An email address of at most 254 characters, named `EmailAddress`. */
export const EmailAddressSchema = Type.String({
  $id: 'EmailAddress',
  format: 'email',
  maxLength: 254,
  description: 'Email address.',
});
/** A phone number in E.164 format, named `PhoneNumber`. */
export const PhoneNumberSchema = Type.String({
  $id: 'PhoneNumber',
  pattern: '^\\+[1-9][0-9]{1,14}$',
  description: 'Phone number in E.164 format.',
});
/** An HTTPS URL of at most 2048 characters, named `HttpsUrl`. */
export const HttpsUrlSchema = Type.String({
  $id: 'HttpsUrl',
  format: 'uri',
  pattern: '^https://',
  maxLength: 2048,
  description: 'An HTTPS URL.',
});
/** A `#rrggbb` color, named `HexColor`. */
export const HexColorSchema = Type.String({
  $id: 'HexColor',
  pattern: '^#[0-9a-fA-F]{6}$',
  description: 'A color, as #rrggbb.',
});

/** What every `delete` answers. */
export const DeletedObjectSchema = Type.Object(
  {
    id: Type.String({ description: 'The id of the deleted resource.' }),
    deleted: Type.Literal(true),
  },
  { $id: 'DeletedObject', additionalProperties: false }
);
/** What a `delete` answers: the id and `deleted: true`. */
export type DeletedObject = Static<typeof DeletedObjectSchema>;

/** The URL of a `SignedUrl`, described as the credential it is. */
const SignedUrlFieldSchema: TString = {
  ...HttpsUrlSchema,
  description: 'The signed URL. Anyone holding it has access until it expires.',
};
/** A link that grants access by itself until it expires, such as a file download. */
export const SignedUrlSchema = Type.Object(
  {
    url: SignedUrlFieldSchema,
    expiresAt: Type.String({ format: 'date-time', description: 'When the URL stops working.' }),
  },
  { $id: 'SignedUrl', additionalProperties: false }
);
/** A URL that grants access by itself, and when it expires. */
export type SignedUrl = Static<typeof SignedUrlSchema>;

/** Another resource, by its id and the name people know it by. */
export const NamedReferenceSchema = Type.Object(
  {
    id: Type.String({ description: 'The id of the referenced resource.' }),
    name: Type.String({ description: 'Its name.' }),
  },
  { $id: 'NamedReference', additionalProperties: false }
);
/** Another resource, by id and name. */
export type NamedReference = Static<typeof NamedReferenceSchema>;

/** A postal address, shaped as FHIR `Address`. */
export const PostalAddressSchema = Type.Object(
  {
    city: Type.Optional(Type.String({ maxLength: 120 })),
    countryCode: Type.Optional(Type.String({ description: 'ISO 3166-1 alpha-2.', pattern: '^[A-Z]{2}$' })),
    line: Type.Optional(Type.Array(Type.String({ maxLength: 200 }), { maxItems: 4 })),
    postalCode: Type.Optional(Type.String({ maxLength: 20 })),
    state: Type.Optional(Type.String({ maxLength: 120 })),
    use: Type.Optional(Type.Union([Type.Literal('home'), Type.Literal('work')])),
  },
  { $id: 'PostalAddress', additionalProperties: false }
);
/** A postal address, shaped as FHIR `Address`. */
export type PostalAddress = Static<typeof PostalAddressSchema>;
