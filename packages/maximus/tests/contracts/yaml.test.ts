/**
 * The YAML Maximus writes for `/openapi.yaml` and skill frontmatter: every value reads back as the JSON it
 * came from with a YAML 1.2 reader and as the same strings with a YAML 1.1 one, and plain text stays plain.
 */
import { expect, it } from 'vite-plus/test';
import { parse } from 'yaml';

import { createOpenApi, maximus, defineErrors, ok, t } from '../../src/index.ts';
import { toYaml } from '../../src/internal/yaml.ts';

/** Strings a careless writer would hand a YAML reader as something else. */
const TRICKY = [
  '',
  ' leading space',
  'trailing space ',
  'yes',
  'No',
  'ON',
  'off',
  'y',
  'TRUE',
  'null',
  '~',
  '0',
  '012',
  '1e3',
  '0x1F',
  '.inf',
  '-.nan',
  '2026-10-27',
  '12:30:00',
  '#comment',
  '&anchor',
  '*alias',
  '!tag',
  '- item',
  '? key',
  'key: value',
  'a #b',
  '{flow}',
  '[flow]',
  '"quoted"',
  "'single'",
  '%directive',
  '@at',
  '`tick`',
  '|literal',
  '>folded',
  'line\nbreak',
  'tab\there',
  'carriage\rreturn',
  'nul\u0000byte',
  'del\u007Fchar',
  'next\u0085line',
  'c1\u0090control',
  `line${String.fromCodePoint(0x20_28)}separator`,
  'emoji 🫀 and ñandú',
  `non${String.fromCodePoint(0xff_fe)}character`,
  '/v1/tasks/{taskId}',
  '#/components/schemas/Task',
  'application/json',
];

it('reads back every string as itself, quoted unless it is plain text', () => {
  for (const value of TRICKY) {
    const document = toYaml({ [value]: value, list: [value] });
    expect(parse(document), JSON.stringify(value)).toEqual({ [value]: value, list: [value] });
    expect(parse(document, { version: '1.1' }), JSON.stringify(value)).toEqual({
      [value]: value,
      list: [value],
    });
  }
  expect(toYaml({ type: 'string', format: 'date-time', ref: 'application/json' })).toBe(
    'type: string\nformat: date-time\nref: application/json\n'
  );
  expect(toYaml({ answer: 'yes', path: '/v1/tasks/{taskId}' })).toBe(
    'answer: "yes"\npath: "/v1/tasks/{taskId}"\n'
  );
});

it('writes nested mappings and sequences in block style, empty ones and scalars inline', () => {
  const value = {
    name: 'tasks',
    count: 3,
    ratio: -0.25,
    big: 1e21,
    active: true,
    missing: null,
    skipped: undefined,
    empty: {},
    none: [],
    tags: ['a', 'b'],
    owners: [
      { name: 'Ana', roles: ['admin'] },
      { name: 'Luis', address: { city: 'Lima' } },
    ],
    matrix: [
      [1, 2],
      [3, []],
    ],
  };
  const document = toYaml(value);
  expect(document).toBe(
    [
      'name: tasks',
      'count: 3',
      'ratio: -0.25',
      'big: 1e+21',
      'active: true',
      'missing: null',
      'empty: {}',
      'none: []',
      'tags:',
      '  - a',
      '  - b',
      'owners:',
      '  - name: Ana',
      '    roles:',
      '      - admin',
      '  - name: Luis',
      '    address:',
      '      city: Lima',
      'matrix:',
      '  - - 1',
      '    - 2',
      '  - - 3',
      '    - []',
      '',
    ].join('\n')
  );
  expect(parse(document)).toEqual(JSON.parse(JSON.stringify(value)));
  expect(toYaml('alone')).toBe('alone\n');
  expect(toYaml([])).toBe('[]\n');
  expect(toYaml([undefined, Number.NaN])).toBe('- null\n- null\n');
});

it("serves an application's OpenAPI document as YAML that reads back as its JSON", () => {
  const app = maximus({
    name: 'tasks',
    namespace: 'tasks',
    title: 'Tasks: plan & track',
    version: '1.0.0',
    origin: 'https://tasks.example.test',
    tokens: { issuer: 'https://issuer.example.test/', audience: 'tasks' },
    errors: defineErrors({}),
    rpc: { callers: [] },
  })
    .operation(
      'getTask',
      {
        scope: 'tasks:tasks:read',
        title: 'Get a task',
        description: 'Return one task: its title, status and #tags.',
        effect: 'read',
        input: t.Object({ taskId: t.String({ pattern: '^[a-z0-9-]+$' }) }, { additionalProperties: false }),
        output: t.Object(
          { title: t.String(), status: t.Union([t.Literal('yes'), t.Literal('no')]) },
          { additionalProperties: false }
        ),
        http: { method: 'GET', path: '/v1/tasks/{taskId}' },
      },
      async () => ok({ title: 'x', status: 'yes' as const })
    )
    .build();
  const document = createOpenApi(app);
  expect(parse(toYaml(document))).toEqual(JSON.parse(JSON.stringify(document)));
});
