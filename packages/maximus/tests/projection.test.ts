import { expect, it } from 'vite-plus/test';

import { kebab, mcpToolName, permissionDescription, queryKind, snake } from '../src/projection.ts';

const input = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    from: { type: 'string', format: 'date' },
    limit: { type: 'integer' },
    exact: { type: 'boolean' },
    status: {
      anyOf: [{ const: 'scheduled' }, { type: 'array', items: { enum: ['scheduled', 'confirmed'] } }],
    },
    payer: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    filter: { type: 'object' },
    shared: { $ref: '#/components/schemas/Shared' },
  },
} as const;

it('derives the MCP tool and the CLI words from one resource and verb', () => {
  const name = { resource: 'appointments', verb: 'findNearest' };
  expect(mcpToolName('agenda', name)).toBe('agenda_appointments_find_nearest');
  expect(mcpToolName('service-accounts', { resource: 'apiKeys', verb: 'rotate' })).toBe(
    'service_accounts_api_keys_rotate'
  );
  expect([kebab(name.resource), kebab(name.verb)]).toEqual(['appointments', 'find-nearest']);
  expect(snake('find-nearest')).toBe('find_nearest');
  expect(() => mcpToolName('agenda', { resource: 'appointments', verb: 'x'.repeat(64) })).toThrow(
    'not portable'
  );
  // @ts-expect-error A name without its verb is not a projected name.
  expect(() => mcpToolName('agenda', { resource: 'appointments' })).toThrow(TypeError);
});

it('reads how each input field travels in a query string', () => {
  const { properties } = input;
  expect(queryKind(properties.from)).toBe('string');
  expect(queryKind(properties.limit)).toBe('integer');
  expect(queryKind(properties.exact)).toBe('boolean');
  expect(queryKind(properties.status)).toBe('list');
  expect(queryKind(properties.payer)).toBe('string');
  expect(queryKind(properties.filter)).toBeNull();
  // A bundled document's reference resolves through its components.
  expect(queryKind(properties.shared)).toBeNull();
  expect(queryKind(properties.shared, () => ({ type: 'number' }))).toBe('number');
});

it('describes a permission by what its scope lets a person do', () => {
  expect(permissionDescription('integrations:service-accounts:write')).toBe('Write service accounts');
  expect(permissionDescription('integrations:agenda-automation:provision')).toBe(
    'Provision agenda automation'
  );
  expect(permissionDescription('billing:invoices:read')).toBe('Read invoices');
});
