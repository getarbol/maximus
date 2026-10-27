/**
 * Who calls: the principal every operation receives, and what a verified token grants before admission adds
 * the request id. Token verification (`tokens.ts`) and Cloudflare Access (`cloudflare-access.ts`) both answer
 * a `TokenPrincipal`, parsed strictly against these schemas.
 */
import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';

import { OrganizationIdSchema, UuidSchema } from './schemas.ts';

/**
 * Who calls, as every operation receives it: the actor, its kind, its verified organization and the request
 * id.
 */
export const PrincipalSchema = Type.Object(
  {
    actorId: Type.String({ minLength: 1, maxLength: 255 }),
    actorKind: Type.Union([Type.Literal('user'), Type.Literal('service')]),
    organizationId: OrganizationIdSchema,
    requestId: UuidSchema,
  },
  { additionalProperties: false }
);
/** Who calls: the actor, its kind, its organization and the request id. */
export type Principal = Static<typeof PrincipalSchema>;
/**
 * The OAuth client a token was issued to: its id and its class, `human`, `machine` or `dcr` (a dynamically
 * registered client).
 */
export const TokenClientSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 255 }),
    class: Type.Union([Type.Literal('human'), Type.Literal('machine'), Type.Literal('dcr')]),
  },
  { additionalProperties: false }
);
/** The OAuth client a token was issued to. */
export type TokenClient = Static<typeof TokenClientSchema>;
/**
 * What a verified token grants: the principal without a request id, its scopes and, for an OAuth token, its
 * client. A custom `tokens.resolve` returns this shape.
 */
export const TokenPrincipalSchema = Type.Object(
  {
    ...Type.Omit(PrincipalSchema, ['requestId']).properties,
    scopes: Type.Array(Type.String({ maxLength: 255 }), { maxItems: 1000 }),
    /** Custom resolvers must classify DCR from verified application policy, never request headers. */
    client: Type.Optional(TokenClientSchema),
  },
  { additionalProperties: false }
);
/** What a verified token grants. */
export type TokenPrincipal = Static<typeof TokenPrincipalSchema>;
