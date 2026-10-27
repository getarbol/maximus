/**
 * Reading a verified token's claims, which token verification and Cloudflare Access share.
 */
import { isRecord } from './record.ts';

/**
 * A claim's own value under its name, else at a dotted path through object claims; undefined when absent.
 * Only own properties are read, so no path reaches a prototype.
 */
export function claimAt(claims: Record<string, unknown>, path: string): unknown {
  if (Object.hasOwn(claims, path)) {
    return claims[path];
  }
  let value: unknown = claims;
  for (const key of path.split('.')) {
    if (!isRecord(value) || !Object.hasOwn(value, key)) {
      return undefined;
    }
    value = value[key];
  }
  return value;
}
