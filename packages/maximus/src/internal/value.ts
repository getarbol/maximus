/**
 * TypeBox's `Value`, as Maximus runs it: every module that checks, defaults or decodes a value imports it from
 * here, so TypeBox is configured before its first check. Validation is interpreted, never generated as code at
 * runtime, which Workers refuse and Maximus never does; a refusal builds at most the errors it carries; the
 * formats Maximus has always checked keep their RFC validators; and a format reads at most 8 KiB of text.
 */
import { fullFormats } from 'ajv-formats/dist/formats.js';
import { Format } from 'typebox/format';
import { Settings } from 'typebox/system';

/** The most errors one check builds: the field issues an `INVALID_INPUT` failure carries. */
export const MAX_ISSUES = 10;
/** The longest text a format reads; longer text is refused before its validator runs. */
const MAX_FORMAT_LENGTH = 8192;
/** The formats Maximus documents, checked by the maintained RFC validators it has always used. */
const RFC_FORMATS = ['date', 'time', 'date-time', 'email', 'uuid', 'uri'] as const;

Settings.Set({ useAcceleration: false, maxErrors: MAX_ISSUES });
for (const name of RFC_FORMATS) {
  const format = fullFormats[name];
  const validator = typeof format === 'object' && !(format instanceof RegExp) ? format.validate : format;
  Format.Set(name, (value) =>
    validator instanceof RegExp
      ? validator.test(value)
      : typeof validator === 'function' && (validator as (input: string) => unknown)(value) === true
  );
}
// TypeBox's own formats (hostname, ipv4, url, …) keep its validators, behind the same bound.
for (const [name, check] of Format.Entries()) {
  Format.Set(name, (value) => value.length <= MAX_FORMAT_LENGTH && check(value));
}

export { Value, DecodeUnsafe, HasCodec, AssertError } from 'typebox/value';
