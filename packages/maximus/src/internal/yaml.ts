/**
 * A YAML writer for JSON data, for `/openapi.yaml` and a skill's frontmatter: block mappings and sequences,
 * two spaces deep, and every scalar written as any YAML reader takes it back. A string stays plain only when
 * no reader could take it for anything else, and is double-quoted with JSON's escapes otherwise.
 */

/**
 * A string that is plain text to every YAML reader: it starts with a letter or `_` and holds only letters,
 * digits, `_`, `.`, `/` and `-`, so it is no number, date, comment, alias, tag or flow collection.
 */
const PLAIN = /^[A-Za-z_][\w./-]*$/;
/** Words a YAML 1.1 reader takes for a boolean or null, whatever their case. */
const KEYWORDS = new Set(['y', 'n', 'yes', 'no', 'on', 'off', 'true', 'false', 'null']);
/** Characters YAML requires escaped in a double-quoted scalar that JSON leaves as they are. */
const UNPRINTABLE = /[\u007F-\u0084\u0086-\u009F￾￿]/g;

/** A string as a YAML scalar. */
function text(value: string): string {
  if (PLAIN.test(value) && !KEYWORDS.has(value.toLowerCase())) {
    return value;
  }
  return JSON.stringify(value).replaceAll(
    UNPRINTABLE,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
  );
}

/** A value's own entries, as JSON keeps them: its items, or the fields whose value is defined. */
function entries(value: object): [string, unknown][] {
  return Object.entries(value).filter(([, child]) => child !== undefined && typeof child !== 'function');
}

/** A value written on one line: a scalar, or an empty mapping or sequence. Undefined for any other. */
function inline(value: unknown): string | undefined {
  if (value === null) {
    return 'null';
  }
  switch (typeof value) {
    case 'string': {
      return text(value);
    }
    case 'number': {
      return Number.isFinite(value) ? String(value) : 'null';
    }
    case 'boolean': {
      return String(value);
    }
    case 'object': {
      if (Array.isArray(value)) {
        return value.length ? undefined : '[]';
      }
      return entries(value).length ? undefined : '{}';
    }
    default: {
      return 'null';
    }
  }
}

/** The lines of a mapping or sequence that is not empty, `depth` levels in. */
function block(value: object, depth: number): string[] {
  const indent = '  '.repeat(depth);
  const lines: string[] = [];
  if (Array.isArray(value)) {
    for (const item of value as unknown[]) {
      const single = inline(item === undefined ? null : item);
      if (single === undefined) {
        // The item's first line takes the dash: `- name: Ana` and then its other fields below `name`.
        const [first = '', ...rest] = block(item as object, depth + 1);
        lines.push(`${indent}- ${first.trimStart()}`, ...rest);
      } else {
        lines.push(`${indent}- ${single}`);
      }
    }
    return lines;
  }
  for (const [key, child] of entries(value)) {
    const single = inline(child);
    lines.push(single === undefined ? `${indent}${text(key)}:` : `${indent}${text(key)}: ${single}`);
    if (single === undefined) {
      lines.push(...block(child as object, depth + 1));
    }
  }
  return lines;
}

/** A JSON value as a YAML document. */
export function toYaml(value: unknown): string {
  const single = inline(value);
  return `${single ?? block(value as object, 0).join('\n')}\n`;
}
