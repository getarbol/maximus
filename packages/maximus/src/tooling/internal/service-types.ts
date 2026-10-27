/**
 * The types of another Maximus service's native RPC methods, read from the OpenAPI document it publishes:
 * `maximus prepare` writes them to `.maximus/services/<binding>.ts`, so a project calls the service through
 * its binding, typed, without importing anything of that service's project.
 */

/** A JSON value of the document, as JSON parses it. */
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
/** A JSON object of the document. */
type JsonObject = Record<string, Json>;

/** Whether a JSON value is an object, rather than a list or a scalar. */
function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The prefix of a reference to a component schema. */
const COMPONENT = '#/components/schemas/';
/** A name TypeScript reads as an identifier. */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/** The methods OpenAPI names an operation under. */
const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
/** The names the module imports, which no type of the document may take. */
const IMPORTED = ['Principal', 'Result', 'WorkerEntrypoint'] as const;

/** A component's name as a type: its letters and digits, each part capitalized, `Note_2` as `Note2`. */
function typeName(component: string): string {
  const name = component
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
  return /^[A-Za-z]/.test(name) ? name : `Schema${name}`;
}

/**
 * A JSON value as a TypeScript literal type, a string in single quotes: `'USD'`, `true`, `null`, `3`. A
 * string keeps JSON's escapes, so no character of it ends the literal or its line.
 */
function literal(value: Json | undefined): string {
  if (typeof value === 'string') {
    return `'${JSON.stringify(value).slice(1, -1).replaceAll("'", "\\'")}'`;
  }
  return JSON.stringify(value ?? null);
}

/** A property's name as TypeScript writes it: bare when it is an identifier, quoted otherwise. */
function propertyName(name: string): string {
  return IDENTIFIER.test(name) ? name : literal(name);
}

/** A type alias's declaration, with a union that spans lines starting on the line after `=`. */
function typeAlias(name: string, type: string): string {
  return `export type ${name} =${type.startsWith('\n') ? '' : ' '}${type};`;
}

/** A union's members on one line, or one per line when they would not fit in 110 columns. */
function unionText(members: readonly string[], indent: string): string {
  const inline = members.join(' | ');
  if (members.length < 2 || inline.length + indent.length <= 90) {
    return inline;
  }
  return members.map((member) => `\n${indent}  | ${member}`).join('');
}

/** A description as a JSDoc comment at an indentation, or nothing without one. */
function comment(description: Json | undefined, indent: string): string[] {
  if (typeof description !== 'string' || !description.trim()) {
    return [];
  }
  const text = description.trim().replaceAll('*/', '* /');
  const lines = text.split(/\r\n?|\n|\u2028|\u2029/);
  return lines.length === 1
    ? [`${indent}/** ${text} */`]
    : [`${indent}/**`, ...lines.map((line) => `${indent} * ${line}`.trimEnd()), `${indent} */`];
}

/** Whether a type joins others with `|` or `&` at its top level, outside brackets and string literals. */
function isCompound(type: string): boolean {
  let depth = 0;
  let quote: string | undefined;
  for (let index = 0; index < type.length; index += 1) {
    const character = type.charAt(index);
    if (quote) {
      if (character === '\\') {
        index += 1;
      } else if (character === quote) {
        quote = undefined;
      }
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if ('{([<'.includes(character)) {
      depth += 1;
    } else if ('})]>'.includes(character)) {
      depth -= 1;
    } else if (depth === 0 && (character === '|' || character === '&')) {
      return true;
    }
  }
  return false;
}

/**
 * Writes TypeScript for the JSON Schemas of one document: each expression as it is met, and a declaration
 * for every component an expression names, in the order they are first named.
 */
class TypeWriter {
  readonly #schemas: JsonObject;
  /** The components named so far, by their component name, each with its type's name. */
  readonly #named = new Map<string, string>();
  /** The declarations of the components named so far, in order. */
  readonly #declarations: string[] = [];

  constructor(schemas: JsonObject) {
    this.#schemas = schemas;
  }

  /** The declarations of every component the expressions named. */
  get declarations(): readonly string[] {
    return this.#declarations;
  }

  /** The type a component's name stands for, declaring the component the first time it is named. */
  named(component: string): string {
    const known = this.#named.get(component);
    if (known) {
      return known;
    }
    const schema = this.#schemas[component];
    if (!isObject(schema)) {
      throw new TypeError(`The document refers to the component ${component}, which it does not define.`);
    }
    const name = typeName(component);
    // Named before it is written, so a component that refers to itself names its own type.
    this.#named.set(component, name);
    const declaration = [...comment(schema.description, '')];
    const object = this.#isPlainObject(schema) ? this.#objectType(schema, '') : undefined;
    if (object?.startsWith('{')) {
      declaration.push(`export interface ${name} ${object}`);
    } else {
      declaration.push(typeAlias(name, object ?? this.type(schema)));
    }
    this.#declarations.push(declaration.join('\n'));
    return name;
  }

  /** The TypeScript type of a schema. */
  type(schema: Json | undefined, indent = ''): string {
    if (!isObject(schema)) {
      return schema === false ? 'never' : 'unknown';
    }
    if (typeof schema.$ref === 'string') {
      if (!schema.$ref.startsWith(COMPONENT)) {
        throw new TypeError(`The document refers to ${schema.$ref}, outside its component schemas.`);
      }
      return this.named(schema.$ref.slice(COMPONENT.length));
    }
    if ('const' in schema) {
      return literal(schema.const);
    }
    if (Array.isArray(schema.enum)) {
      return schema.enum.map((value) => literal(value)).join(' | ') || 'never';
    }
    const members = Array.isArray(schema.anyOf) ? schema.anyOf : schema.oneOf;
    if (Array.isArray(members)) {
      return this.#union(members, indent);
    }
    if (Array.isArray(schema.allOf)) {
      return schema.allOf.map((member) => this.#wrapped(this.type(member, indent))).join(' & ') || 'unknown';
    }
    if (Array.isArray(schema.type)) {
      return this.#union(
        schema.type.map((type) => ({ ...schema, type })),
        indent
      );
    }
    switch (schema.type) {
      case 'string': {
        return 'string';
      }
      case 'integer':
      case 'number': {
        return 'number';
      }
      case 'boolean': {
        return 'boolean';
      }
      case 'null': {
        return 'null';
      }
      case 'array': {
        return this.#arrayType(schema, indent);
      }
      case 'object': {
        return this.#objectType(schema, indent);
      }
      default: {
        return schema.properties ? this.#objectType(schema, indent) : 'unknown';
      }
    }
  }

  /** Whether a schema is one object with named fields, which an interface declares. */
  #isPlainObject(schema: JsonObject): boolean {
    return (
      schema.type === 'object' &&
      isObject(schema.properties) &&
      schema.patternProperties === undefined &&
      !isObject(schema.additionalProperties)
    );
  }

  /** A union of schemas' types, each member parenthesized where `|` would bind it otherwise. */
  #union(members: Json[], indent: string): string {
    const types = [...new Set(members.map((member) => this.#wrapped(this.type(member, indent))))];
    return types.length ? unionText(types, indent) : 'never';
  }

  /** A type wrapped in parentheses when it is a union or an intersection itself. */
  #wrapped(type: string): string {
    return isCompound(type) ? `(${type})` : type;
  }

  /** An array's type: a tuple of its `prefixItems`, else a list of its `items`. */
  #arrayType(schema: JsonObject, indent: string): string {
    if (Array.isArray(schema.prefixItems)) {
      return `[${schema.prefixItems.map((item) => this.type(item, indent)).join(', ')}]`;
    }
    const item = this.type(schema.items, indent);
    return /^[\w.$]+$/.test(item) ? `${item}[]` : `Array<${item}>`;
  }

  /** An object's type: its fields, optional unless required, and any key a pattern or the rest admits. */
  #objectType(schema: JsonObject, indent: string): string {
    const inner = `${indent}  `;
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    const fields = Object.entries(isObject(schema.properties) ? schema.properties : {}).flatMap(
      ([name, field]) => [
        ...comment(isObject(field) ? field.description : undefined, inner),
        `${inner}${propertyName(name)}${required.has(name) ? '' : '?'}: ${this.type(field, inner)};`,
      ]
    );
    const keyed = [
      ...Object.values(isObject(schema.patternProperties) ? schema.patternProperties : {}),
      ...(isObject(schema.additionalProperties) ? [schema.additionalProperties] : []),
    ];
    if (keyed.length) {
      fields.push(`${inner}[key: string]: ${this.#union(keyed, inner)};`);
    } else if (
      schema.additionalProperties === true ||
      (schema.type === 'object' && !fields.length && schema.additionalProperties !== false)
    ) {
      fields.push(`${inner}[key: string]: unknown;`);
    }
    return fields.length ? `{\n${fields.join('\n')}\n${indent}}` : 'Record<string, never>';
  }
}

/** One operation of the document that is a native RPC method. */
interface RpcOperation {
  name: string;
  summary: string | undefined;
  description: string | undefined;
  operation: JsonObject;
}

/** The operations of a document that are native RPC methods, in the document's order. */
function rpcOperations(paths: JsonObject): RpcOperation[] {
  return Object.values(paths).flatMap((item) =>
    METHODS.flatMap((method) => {
      const operation = isObject(item) ? item[method] : undefined;
      if (!isObject(operation) || operation['x-native-rpc'] !== true) {
        return [];
      }
      const name = operation.operationId;
      if (typeof name !== 'string' || !/^[a-z][A-Za-z0-9]*$/.test(name)) {
        throw new TypeError('Every native RPC operation of the document has a camelCase operationId.');
      }
      const { summary, description } = operation;
      return [
        {
          name,
          summary: typeof summary === 'string' ? summary : undefined,
          description: typeof description === 'string' ? description : undefined,
          operation,
        },
      ];
    })
  );
}

/** The schema of a response's or body's JSON content. */
function jsonSchema(content: Json | undefined): Json | undefined {
  const json = isObject(content) ? content['application/json'] : undefined;
  return isObject(json) ? json.schema : undefined;
}

/**
 * The input an RPC method takes: the fields of its path and query parameters, joined with its JSON body;
 * the RPC method receives them as one object, as the route's handler does.
 */
function inputType(operation: JsonObject, types: TypeWriter): string {
  const parameters = Array.isArray(operation.parameters) ? operation.parameters.filter(isObject) : [];
  const fields = parameters.map((parameter) => {
    const name = String(parameter.name);
    const optional = parameter.required === true ? '' : '?';
    return [
      ...comment(parameter.description, '  '),
      `  ${propertyName(name)}${optional}: ${types.type(parameter.schema, '  ')};`,
    ];
  });
  const located = fields.length ? `{\n${fields.flat().join('\n')}\n}` : undefined;
  const body = isObject(operation.requestBody) ? jsonSchema(operation.requestBody.content) : undefined;
  const sent = body === undefined ? undefined : types.type(body);
  if (located && sent) {
    return `${located} & ${sent}`;
  }
  return located ?? sent ?? 'Record<string, never>';
}

/** The component an envelope reference names, read from the document's schemas. */
function envelopeField(
  reference: Json | undefined,
  field: 'data' | 'error',
  schemas: JsonObject
): Json | undefined {
  if (!isObject(reference) || typeof reference.$ref !== 'string' || !reference.$ref.startsWith(COMPONENT)) {
    return undefined;
  }
  const envelope = schemas[reference.$ref.slice(COMPONENT.length)];
  const properties = isObject(envelope) ? envelope.properties : undefined;
  return isObject(properties) ? properties[field] : undefined;
}

/** What an RPC method answers when it succeeds: the `data` of its success envelope. */
function outputType(operation: JsonObject, types: TypeWriter, schemas: JsonObject): string {
  const responses = isObject(operation.responses) ? operation.responses : {};
  const success = Object.entries(responses).find(([status]) => /^2\d\d$/.test(status))?.[1];
  const data = envelopeField(jsonSchema(isObject(success) ? success.content : undefined), 'data', schemas);
  return data === undefined ? 'unknown' : types.type(data);
}

/** The failures an RPC method may answer: the `error` of each failure envelope its responses document. */
function failureType(operation: JsonObject, types: TypeWriter, schemas: JsonObject): string {
  const responses = isObject(operation.responses) ? operation.responses : {};
  const failures = Object.entries(responses).flatMap(([status, response]) => {
    if (!/^[45]\d\d$/.test(status) || !isObject(response)) {
      return [];
    }
    const error = envelopeField(jsonSchema(response.content), 'error', schemas);
    return error === undefined ? [] : [types.type(error)];
  });
  const unique = [...new Set(failures)];
  return unique.length ? unionText(unique, '') : 'never';
}

/** A binding's name as a type: `PRICING` is `Pricing`, `NOTES_API` is `NotesApi`. */
export function serviceTypeName(binding: string): string {
  return binding
    .toLowerCase()
    .split('_')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');
}

/**
 * The module that types a service binding from the OpenAPI document its service publishes: the service's
 * entrypoint, `<Binding>Service`, with one method per operation the document marks as native RPC, each
 * answering a Result of its output or one of the failures its responses document, and the types of each
 * input, output and failure. A document that is not an OpenAPI 3.1 document of paths, or that marks no
 * operation as native RPC, throws a TypeError naming the binding and its file.
 */
export function serviceModule(binding: string, document: unknown, source: string): string {
  const parsed = document as Json;
  const where = `services.${binding}: ${source}`;
  if (
    !isObject(parsed) ||
    typeof parsed.openapi !== 'string' ||
    !parsed.openapi.startsWith('3.1') ||
    !isObject(parsed.paths)
  ) {
    throw new TypeError(
      `${where} is not an OpenAPI 3.1 document; write it with maximus openapi in that service.`
    );
  }
  const components = isObject(parsed.components) ? parsed.components : {};
  const schemas = isObject(components.schemas) ? components.schemas : {};
  const operations = rpcOperations(parsed.paths);
  if (!operations.length) {
    throw new TypeError(
      `${where} documents no route served over native RPC: declare rpc in the routes this service calls.`
    );
  }
  const types = new TypeWriter(schemas);
  const service = `${serviceTypeName(binding)}Service`;
  const methods = operations.flatMap(({ name, summary, description, operation }) => {
    const prefix = name.charAt(0).toUpperCase() + name.slice(1);
    const input = `${prefix}Input`;
    const failure = `${prefix}Failure`;
    // A component the document already names as the alias would be is that type itself.
    const taken = inputType(operation, types);
    const inputDeclaration =
      taken === input ? [] : [`/** What \`${name}\` takes. */\n${typeAlias(input, taken)}`];
    // An output its document names reads as that name; any other, by an alias.
    const answer = outputType(operation, types, schemas);
    const output = /^[A-Za-z_$][\w$]*$/.test(answer) ? answer : `${prefix}Output`;
    const outputDeclaration =
      output === answer
        ? []
        : [`/** What \`${name}\` answers when it succeeds. */\n${typeAlias(output, answer)}`];
    const answered = failureType(operation, types, schemas);
    const failureDeclaration =
      answered === failure
        ? []
        : [`/** The failures \`${name}\` may answer. */\n${typeAlias(failure, answered)}`];
    const words = [summary, description].filter(Boolean).join(': ');
    return [
      {
        method: [
          ...comment(words, '  '),
          `  ${name}(principal: Principal, input: ${input}): Promise<Result<${output}, ${failure}>>;`,
        ].join('\n'),
        declarations: [...inputDeclaration, ...outputDeclaration, ...failureDeclaration],
      },
    ];
  });
  const title = isObject(parsed.info) && typeof parsed.info.title === 'string' ? parsed.info.title : binding;
  const declared = [
    ...IMPORTED,
    service,
    ...[...methods.flatMap(({ declarations }) => declarations), ...types.declarations].flatMap(
      (declaration) => /export (?:interface|type) (\w+)/.exec(declaration)?.[1] ?? []
    ),
  ];
  const twice = declared.find((name, index) => declared.indexOf(name) !== index);
  if (twice) {
    throw new TypeError(
      `${where} names ${twice} twice among the types of the binding: rename that schema or operation in the service.`
    );
  }
  const owner = title.endsWith('s') ? `${title}'` : `${title}'s`;
  return [
    `// Generated by maximus prepare from ${source.replaceAll(/[\r\n\u2028\u2029]/g, ' ')}. Change that service's routes and run maximus openapi there; never edit this file.`,
    "import type { Principal, Result } from '@arbol-ai/maximus';",
    "import type { WorkerEntrypoint } from 'cloudflare:workers';",
    '',
    ...comment(
      `${owner} \`Service\` entrypoint, as the ${binding} binding reaches it: one method per operation it serves over native RPC.`,
      ''
    ),
    `export interface ${service} extends WorkerEntrypoint {`,
    methods.map(({ method }) => method).join('\n'),
    '}',
    '',
    ...methods.flatMap(({ declarations }) => declarations.flatMap((declaration) => [declaration, ''])),
    ...types.declarations.flatMap((declaration) => [declaration, '']),
  ].join('\n');
}
