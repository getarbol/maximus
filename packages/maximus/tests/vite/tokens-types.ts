/**
 * Compile-only coverage of the token presets and the token options they state: each preset plugs into
 * `maximus({ tokens })`, and leaving out what identifies the provider, or naming what it never signs with, is a
 * type error.
 */
import { auth0, cloudflareAccess } from '../../src/vite/index.ts';
import type { MaximusOptions, TokenOptions } from '../../src/vite/index.ts';

/** An Access application's AUD tag. */
const AUD = '4714c1358e65fe4b408ad6d432a5f878f08194bdb4752441fd56faefa9b2b6f2';

/** An API whose tokens Auth0 issues. */
const withAuth0: MaximusOptions = {
  origin: 'https://notes.example.com',
  compatibilityDate: '2026-10-27',
  tokens: auth0({ domain: 'acme.us.auth0.com', audience: 'https://notes.example.com' }),
};
/** An application of several tenants behind Cloudflare Access, which reads each caller's from a claim. */
const behindAccess: MaximusOptions = {
  origin: 'https://notes.example.com',
  compatibilityDate: '2026-10-27',
  tokens: {
    ...cloudflareAccess({ team: 'acme', aud: AUD, scopes: { people: ['notes:notes:read'] } }),
    claims: { organization: 'custom.org_id' },
  },
};
void [withAuth0, behindAccess];

// @ts-expect-error The tenant's domain is required.
auth0({ audience: 'https://notes.example.com' });
// @ts-expect-error The API's audience is required.
auth0({ domain: 'acme.us.auth0.com' });
// @ts-expect-error A list of domains names one at least.
auth0({ domain: [], audience: 'https://notes.example.com' });
// @ts-expect-error HS256 tokens are signed with a secret, which no JWKS publishes.
auth0({ domain: 'acme.us.auth0.com', audience: 'https://notes.example.com', algorithms: ['HS256'] });

// @ts-expect-error The Access application's AUD tag is required.
cloudflareAccess({ team: 'acme', scopes: { people: [] } });
// @ts-expect-error The team is required.
cloudflareAccess({ aud: AUD, scopes: { people: [] } });
// @ts-expect-error What people hold is stated, if only as nothing.
cloudflareAccess({ team: 'acme', aud: AUD, scopes: {} });

/** Token options that name a source Maximus does not know. */
const unknownSource: TokenOptions = {
  // @ts-expect-error A token source is authorization or cloudflare-access.
  source: 'cf-access',
};
/** Token options whose Access grants leave out what people hold. */
const accessWithoutPeople: TokenOptions = {
  source: 'cloudflare-access',
  // @ts-expect-error What Access grants names the scopes of people.
  access: { organizationId: 'org_acme' },
};
void [unknownSource, accessWithoutPeople];
