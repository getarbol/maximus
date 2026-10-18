/**
 * Type tests of the shared named schemas, the failure base and `pageLimit`: what each static type admits
 * and refuses.
 */
import { pageLimit } from '../src/index.ts';
import type {
  DeletedObject,
  FailureSchema,
  NamedReference,
  PostalAddress,
  SignedUrl,
  Static,
} from '../src/index.ts';

const deleted: DeletedObject = { id: 'rec_1', deleted: true };
// @ts-expect-error A delete always answers deleted: true.
const undeleted: DeletedObject = { id: 'rec_1', deleted: false };
const link: SignedUrl = { url: 'https://files.example.test/a', expiresAt: '2026-10-17T12:00:00Z' };
// @ts-expect-error A signed URL always says when it expires.
const endless: SignedUrl = { url: 'https://files.example.test/a' };
const reference: NamedReference = { id: 'x', name: 'Main office' };
const address: PostalAddress = { line: ['1 Example Street'], use: 'home' };
// @ts-expect-error An address is for home or work.
const temporary: PostalAddress = { use: 'temp' };
const failure: Static<typeof FailureSchema> = { code: 'X', message: 'Y', retryable: false, data: {} };
// @ts-expect-error Every failure says whether it is retryable.
const partial: Static<typeof FailureSchema> = { code: 'X', message: 'Y', data: {} };

pageLimit({ maximum: 20, default: 10 });
// @ts-expect-error The maximum is a number.
pageLimit({ maximum: '20' });

void [deleted, undeleted, link, endless, reference, address, temporary, failure, partial];
