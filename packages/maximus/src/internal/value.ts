/**
 * TypeBox's `Value`, as Maximus runs it: every module that checks, defaults or decodes a value imports it from
 * here, so TypeBox is configured before its first check. Validation is interpreted, never generated as code at
 * runtime, which Workers refuse and Maximus never does; a refusal builds at most the errors it carries; and a
 * format reads at most 8 KiB of text.
 */
import { Format } from 'typebox/format';
import { Settings } from 'typebox/system';

/** The most errors one check builds: the field issues an `INVALID_INPUT` failure carries. */
export const MAX_ISSUES = 10;
/** The longest text a format reads; longer text is refused before its expression runs. */
const MAX_FORMAT_LENGTH = 8192;
/** The formats Maximus's schemas use, each checked by TypeBox's own validator. */
const FORMATS = ['date', 'time', 'date-time', 'email', 'uuid', 'uri'] as const;

Settings.Set({ useAcceleration: false, maxErrors: MAX_ISSUES });
for (const name of FORMATS) {
  const check = Format.Get(name);
  if (check) {
    Format.Set(name, (value) => value.length <= MAX_FORMAT_LENGTH && check(value));
  }
}

export { Value, DecodeUnsafe, HasCodec, AssertError } from 'typebox/value';
