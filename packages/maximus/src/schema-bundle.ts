/**
 * Schema bundling: named schemas (`$id`) become shared components for an OpenAPI document, or are written
 * in place for a reader without components, such as an MCP tool listing.
 */

/** Plain identifiers TypeBox uses for Recursive/Ref schemas; URLs and pointers are left untouched. */
const SCHEMA_ID = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
/** Use-site annotations: they describe one occurrence and do not change which values validate. */
const ANNOTATIONS = new Set([
  'description',
  'title',
  'examples',
  'default',
  '$comment',
  'deprecated',
  'readOnly',
  'writeOnly',
]);
/** Marks a reference resolved only once every variant of its name is known. */
const PLACEHOLDER = '\u0000schema\u0000';

/** A reference outside any definition, resolved once every variant is known. */
function pending(id: string): string {
  return `${PLACEHOLDER}${id}`;
}

/** A value's JSON with sorted keys, so two equal schemas have one text. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Adds every plain `$id` found in a value to `ids`. */
function collectIds(value: unknown, ids: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectIds(item, ids);
    }
    return;
  }
  if (value && typeof value === 'object') {
    const id = (value as Record<string, unknown>).$id;
    if (typeof id === 'string' && SCHEMA_ID.test(id)) {
      ids.add(id);
    }
    for (const child of Object.values(value)) {
      collectIds(child, ids);
    }
  }
}

/** A copy of a value with every `$ref` passed through `replace`. */
function replaceReferences(value: unknown, replace: (reference: string) => string): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => replaceReferences(item, replace));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      key === '$ref' && typeof child === 'string' ? replace(child) : replaceReferences(child, replace),
    ])
  );
}

/**
 * Bundles `$id`-named schemas (TypeBox Recursive/Ref) into components so that every reference in an
 * OpenAPI document is a local `#/components/schemas/<name>` pointer. A plain-name reference resolves
 * against its enclosing `$id`, as in JSON Schema; structurally different definitions that share an
 * `$id` (for example a normalized input projection and its output) become distinct components. A
 * reference outside any definition must name exactly one variant. Use-site annotations stay beside
 * the reference. The owner's runtime schemas are not changed.
 */
export function bundleSchemas(
  sources: readonly unknown[],
  existing: Readonly<Record<string, unknown>>
): { values: unknown[]; components: Record<string, unknown> } {
  const ids = new Set<string>();
  for (const source of sources) {
    collectIds(source, ids);
  }
  const components: Record<string, unknown> = {};
  const variants = new Map<string, Map<string, string>>();
  const taken = new Set(Object.keys(existing));

  /**
   * A copy of a value with every `$id`-named schema replaced by a reference to its component, registering
   * each distinct shape once, and references resolved against the enclosing names.
   */
  function rewrite(value: unknown, scope: ReadonlyMap<string, string>): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => rewrite(item, scope));
    }
    if (!value || typeof value !== 'object') {
      return value;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.$id === 'string' && ids.has(record.$id)) {
      const { $id: id, ...rest } = record;
      const definition = Object.fromEntries(Object.entries(rest).filter(([key]) => !ANNOTATIONS.has(key)));
      const annotations = Object.fromEntries(Object.entries(rest).filter(([key]) => ANNOTATIONS.has(key)));
      const self = `#/components/schemas/${PLACEHOLDER}self`;
      const shaped = rewrite(definition, new Map([...scope, [id, self]]));
      const shape = canonical(shaped);
      const known = variants.get(id) ?? new Map<string, string>();
      variants.set(id, known);
      let name = known.get(shape);
      if (!name) {
        name = id;
        for (let index = 2; taken.has(name); index += 1) {
          name = `${id}_${index}`;
        }
        taken.add(name);
        known.set(shape, name);
        const target = `#/components/schemas/${name}`;
        components[name] = replaceReferences(shaped, (reference) =>
          reference === self ? target : reference
        );
      }
      // JSON Schema 2020-12 and OpenAPI 3.1 allow annotations beside a reference.
      return { $ref: `#/components/schemas/${name}`, ...annotations };
    }
    return Object.fromEntries(
      Object.entries(record).map(([key, child]) => {
        if (key === '$ref' && typeof child === 'string' && ids.has(child)) {
          return [key, scope.get(child) ?? pending(child)];
        }
        return [key, rewrite(child, scope)];
      })
    );
  }

  const rewritten = sources.map((source) => rewrite(source, new Map()));
  /**
   * A pending reference as the one component its name now has; refused when the name has several shapes or
   * none.
   */
  const resolve = (reference: string) => {
    if (!reference.startsWith(PLACEHOLDER)) {
      return reference;
    }
    const id = reference.slice(PLACEHOLDER.length);
    const names = [...(variants.get(id)?.values() ?? [])];
    if (names.length !== 1) {
      throw new TypeError(`Schema reference "${id}" does not name exactly one definition.`);
    }
    return `#/components/schemas/${names[0]}`;
  };
  for (const [name, schema] of Object.entries(components)) {
    components[name] = replaceReferences(schema, resolve);
  }
  return { values: rewritten.map((value) => replaceReferences(value, resolve)), components };
}

/** Whether a value refers to a named schema (`$ref` to a plain `$id`) anywhere within it. */
export function hasSchemaReferences(value: unknown): boolean {
  const references = new Set<string>();
  collectReferences(value, references);
  return [...references].some((reference) => SCHEMA_ID.test(reference));
}

/** Adds every `$ref` found in a value to `references`. */
function collectReferences(value: unknown, references: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectReferences(item, references);
    }
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (key === '$ref' && typeof child === 'string') {
        references.add(child);
      } else {
        collectReferences(child, references);
      }
    }
  }
}

/**
 * The schema with every `$id` nothing refers to removed, the definition left in place: what a reader
 * that resolves no components meets, the same as before the schema was named. A definition a `$ref`
 * names (TypeBox Recursive or Ref) keeps its `$id`, so the reference still resolves.
 */
function inlineSchemaNames(value: unknown): unknown {
  const references = new Set<string>();
  collectReferences(value, references);
  /** A copy of a node without the `$id`s nothing refers to. */
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      return node.map(strip);
    }
    if (!node || typeof node !== 'object') {
      return node;
    }
    return Object.fromEntries(
      Object.entries(node)
        .filter(
          ([key, child]) =>
            !(key === '$id' && typeof child === 'string' && SCHEMA_ID.test(child) && !references.has(child))
        )
        .map(([key, child]) => [key, strip(child)])
    );
  };
  return strip(value);
}

/** Points each component reference at the schema's own `$defs`. */
function local(node: unknown): unknown {
  return replaceReferences(node, (reference) =>
    reference.startsWith('#/components/schemas/')
      ? `#/$defs/${reference.slice('#/components/schemas/'.length)}`
      : reference
  );
}

/**
 * A self-contained schema for a reader with no components, such as an MCP tool listing: no `$id`
 * left, each named definition written where it is used, and the ones a `$ref` names bundled once
 * under `$defs`. JSON Schema validators refuse a schema that declares one `$id` twice.
 */
export function standaloneSchema(value: unknown): unknown {
  const { values, components } = bundleSchemas([inlineSchemaNames(value)], {});
  if (!Object.keys(components).length) {
    return values[0];
  }
  return { ...(local(values[0]) as Record<string, unknown>), $defs: local(components) };
}
