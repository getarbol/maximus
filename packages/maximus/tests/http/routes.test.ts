/**
 * Route templates and the router: versioned templates with whole-segment parameters, parameter values that
 * cannot change URL ownership, the header names a byte upload may read, path parameters every input member
 * must declare, and the compiled matcher that refuses ambiguity at construction and lets overlapping
 * templates share their continuations.
 */
import { expect, it } from 'vite-plus/test';

import {
  createHttpRouteResolver,
  decodePathParameter,
  isInputHeaderName,
  isPathParameterValue,
  operationPathParameters,
} from '../../src/http-paths.ts';
import { t } from '../../src/index.ts';
import { pathParameterSchemas } from '../../src/internal/http-routes.ts';

/** A definition as an application hands it to the router: its name and, when routed, its route. */
interface Definition {
  name: string;
  http?: { method: 'GET'; path: string };
}

it('reads the parameters of a versioned template and refuses any other template', () => {
  expect(operationPathParameters('/v1/records/{recordId}/notes/{noteId}')).toEqual(['recordId', 'noteId']);
  expect(operationPathParameters('/v12/records')).toEqual([]);
  for (const path of ['', '/', '/v1', 'v1/records', '/v0/records', '/records/{recordId}']) {
    expect(() => operationPathParameters(path), path).toThrow('Operations require a versioned path.');
  }
  for (const path of ['/v1/{constructor}', '/v1/records/{prototype}', '/v1/{recordId}/notes/{recordId}']) {
    expect(() => operationPathParameters(path), path).toThrow(
      'Path parameter names must be unique and safe.'
    );
  }
  for (const path of [
    '/v1/records/',
    '/v1//records',
    '/v1/{recordId}.json',
    '/v1/{__proto__}',
    '/v1/records/{record-id}',
    '/v1/re cords',
  ]) {
    expect(() => operationPathParameters(path), path).toThrow(
      'Use fixed routes or complete {parameter} segments; empty and malformed segments are forbidden.'
    );
  }
});

it('decodes a parameter value once and refuses one that could change URL ownership', () => {
  expect(decodePathParameter('r%201')).toBe('r 1');
  expect(decodePathParameter('caf%C3%A9')).toBe('café');
  expect(decodePathParameter('%252F')).toBe('%2F');
  for (const segment of [
    '',
    '.',
    '..',
    '%2E',
    '%2e%2E',
    '%2F',
    'a%2Fb',
    '%5C',
    '%00',
    '%1F',
    '%7F',
    '%E0%A4%A',
    '%',
  ]) {
    expect(decodePathParameter(segment), segment).toBeNull();
  }
  expect(isPathParameterValue('r1')).toBe(true);
  for (const value of [undefined, null, 42, ['r1'], { recordId: 'r1' }]) {
    expect(isPathParameterValue(value)).toBe(false);
  }
});

it('admits as byte-upload metadata only plain header names that carry no authority or framing', () => {
  for (const header of ['content-type', 'X-File-Name', 'x-checksum-sha256']) {
    expect(isInputHeaderName(header), header).toBe(true);
  }
  for (const header of [
    'authorization',
    'Authorization',
    'COOKIE',
    'host',
    'content-length',
    'Content-Encoding',
    'x_file_name',
    'x file',
    'x-file:name',
    'x-filé',
    '',
  ]) {
    expect(isInputHeaderName(header), header).toBe(false);
  }
});

it('requires each path parameter to be a required string field of every input member', () => {
  const recordId = t.String({ format: 'uuid' });
  expect(pathParameterSchemas(t.Object({ recordId, name: t.String() }), 'recordId')).toEqual([recordId]);
  const union = t.Union([
    t.Object({ recordId, kind: t.Literal('rename') }),
    t.Object({ recordId: t.String(), kind: t.Literal('archive') }),
  ]);
  expect(pathParameterSchemas(union, 'recordId')).toEqual([recordId, t.String()]);
  for (const input of [
    t.Object({ name: t.String() }),
    t.Object({ recordId: t.Integer() }),
    t.Object({ recordId: t.Optional(t.String()) }),
    t.Union([t.Object({ recordId: t.String() }), t.Object({ name: t.String() })]),
  ]) {
    expect(() => pathParameterSchemas(input, 'recordId')).toThrow(
      'Path parameter "recordId" must be a required string input field.'
    );
  }
  for (const input of [t.String(), t.Array(t.Object({ recordId })), t.Unsafe({ anyOf: [] })]) {
    expect(() => pathParameterSchemas(input, 'recordId')).toThrow(
      'Path parameters require object input contracts.'
    );
  }
});

it('matches exact routes by method and path, and templates one segment at a time', () => {
  const list = { name: 'list', http: { method: 'GET', path: '/v1/records' } } as const;
  const read = { name: 'read', http: { method: 'GET', path: '/v1/records/{recordId}' } } as const;
  const note = {
    name: 'note',
    http: { method: 'GET', path: '/v1/records/{recordId}/notes/{noteId}' },
  } as const;
  const notes = { name: 'notes', http: { method: 'GET', path: '/v1/notes/{noteId}' } } as const;
  // A definition without a route, such as an RPC-only operation, is not routed.
  const internal = { name: 'internal' } as const;
  const routes = createHttpRouteResolver<Definition>([list, read, note, notes, internal]);
  expect(routes.match('GET', '/v1/records')).toEqual({ definition: list, parameters: {} });
  expect(routes.match('GET', '/v1/records/r1')).toEqual({ definition: read, parameters: { recordId: 'r1' } });
  expect(routes.match('GET', '/v1/records/r1/notes/n%201')).toEqual({
    definition: note,
    parameters: { recordId: 'r1', noteId: 'n 1' },
  });
  expect(routes.match('GET', '/v1/notes/n1')).toEqual({ definition: notes, parameters: { noteId: 'n1' } });
  for (const [method, path] of [
    ['POST', '/v1/records'],
    ['DELETE', '/v1/records/r1'],
    ['GET', '/v1/records/'],
    ['GET', 'v1/records/r1'],
    ['GET', '/v1/records//notes/n1'],
    ['GET', '/v1/records/r1/notes'],
    ['GET', '/v1/records/r1/notes/n1/history'],
    ['GET', '/v1/records/%2F'],
  ] as const) {
    expect(routes.match(method, path), `${method} ${path}`).toBeNull();
  }
  expect(routes.ownsPath('/v1/records/r1/notes/n1')).toBe(true);
  expect(routes.ownsPath('/v1/records/r1/notes')).toBe(false);
});

it('refuses an unsupported method, a duplicate route and ambiguous templates at construction', () => {
  const route = (method: 'GET' | 'DELETE', path: string) => ({ http: { method, path } });
  // Only a caller without types can name another method.
  expect(() => createHttpRouteResolver([route('HEAD' as 'GET', '/v1/records')])).toThrow(
    'Operation routes require a supported HTTP method.'
  );
  expect(() => createHttpRouteResolver([route('GET', '/v1/records'), route('GET', '/v1/records')])).toThrow(
    'Duplicate operation route.'
  );
  expect(() =>
    createHttpRouteResolver([route('GET', '/v1/records/{recordId}'), route('GET', '/v1/records/{id}')])
  ).toThrow('Ambiguous operation path templates.');
  // `/v1/records/archived/history` would match both.
  expect(() =>
    createHttpRouteResolver([
      route('GET', '/v1/records/{recordId}/history'),
      route('GET', '/v1/records/archived/{entryId}'),
    ])
  ).toThrow('Ambiguous overlapping operation path templates.');
  // The same template under two methods is two routes.
  expect(() =>
    createHttpRouteResolver([route('GET', '/v1/records/{recordId}'), route('DELETE', '/v1/records/{id}')])
  ).not.toThrow();
});

it('lets a fixed segment continue an overlapping parameter template', () => {
  const summary = { name: 'summary', http: { method: 'GET', path: '/v1/{section}/summary' } } as const;
  const daily = { name: 'daily', http: { method: 'GET', path: '/v1/exports/daily/{day}' } } as const;
  const routes = createHttpRouteResolver<Definition>([summary, daily]);
  expect(routes.match('GET', '/v1/reports/summary')).toEqual({
    definition: summary,
    parameters: { section: 'reports' },
  });
  // The fixed `exports` segment still reaches the parameter template's own continuation.
  expect(routes.match('GET', '/v1/exports/summary')).toEqual({
    definition: summary,
    parameters: { section: 'exports' },
  });
  expect(routes.match('GET', '/v1/exports/daily/2026-10-27')).toEqual({
    definition: daily,
    parameters: { day: '2026-10-27' },
  });
  for (const path of ['/v1/exports/daily', '/v1/reports/daily/2026-10-27', '/v1/exports']) {
    expect(routes.match('GET', path), path).toBeNull();
  }
});
