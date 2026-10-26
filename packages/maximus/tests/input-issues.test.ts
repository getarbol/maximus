/**
 * INVALID_INPUT issues: JSON Pointer paths and expectations, never the refused values, bounded in number.
 */
import { DefaultErrorFunction, SetErrorFunction } from '@sinclair/typebox/errors';
import { expect, it } from 'vite-plus/test';

import { executeOperation } from '../src/execution.ts';
import { defineErrors, maximus, ok, standardErrors, t } from '../src/index.ts';
import { decodeInput, inputSchema, normalizeSchema, refineSchema } from '../src/schemas.ts';

const Confirm = t.Object(
  {
    confirmed: t.Literal(true),
    offerToken: t.String({ pattern: '^[a-f0-9]{32}$' }),
    note: t.Optional(normalizeSchema(t.String({ minLength: 1, maxLength: 20 }), (value) => value.trim())),
  },
  { additionalProperties: false }
);

it('refuses an input with its first field issues as JSON Pointers, never with its values', () => {
  const refused = decodeInput(Confirm, {
    confirmed: false,
    offerToken: 'OFFER_TOKEN_SENTINEL',
    extra: 'secret',
  });
  expect(refused.ok).toBe(false);
  const issues = refused.ok ? [] : refused.error.data.issues;
  expect(issues.map((issue) => issue.path)).toEqual(
    expect.arrayContaining(['/confirmed', '/offerToken', '/extra'])
  );
  expect(JSON.stringify(issues)).not.toContain('OFFER_TOKEN_SENTINEL');
  expect(JSON.stringify(issues)).not.toContain('secret');
  // Text is normalized before its checks, so a blank note is refused at its own path.
  const blank = decodeInput(inputSchema(Confirm), {
    confirmed: true,
    offerToken: 'a'.repeat(32),
    note: '   ',
  });
  expect(blank.ok ? [] : blank.error.data.issues.map((issue) => issue.path)).toEqual(['/note']);
});

it('bounds the issues a refusal carries', () => {
  const Wide = t.Object(
    Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`field${index}`, t.String()])),
    { additionalProperties: false }
  );
  const refused = decodeInput(Wide, {});
  expect(refused.ok ? 0 : refused.error.data.issues.length).toBe(10);
});

it('builds no more issues than a refusal carries, however many the input has', () => {
  // TypeBox builds each issue's message through the error function, so its calls count the issues built.
  let built = 0;
  SetErrorFunction((parameter) => {
    built += 1;
    return DefaultErrorFunction(parameter);
  });
  try {
    const refused = decodeInput(
      t.Array(t.String()),
      Array.from({ length: 100_000 }, () => 0)
    );
    expect(refused.ok ? 0 : refused.error.data.issues.length).toBe(10);
    expect(built).toBeLessThanOrEqual(10);
  } finally {
    SetErrorFunction(DefaultErrorFunction);
  }
});

it('an operation refuses an invalid input with the declared INVALID_INPUT failure and its issues', async () => {
  const app = maximus({
    name: 'test',
    namespace: 'test',
    title: 'Test',
    version: '1',
    origin: 'https://example.test',
    tokens: { issuer: 'https://issuer.example.test/', audience: 'test' },
    errors: defineErrors({}),
    rpc: { callers: ['internal'] },
  })
    .operation(
      'confirm',
      {
        scope: 'test:offers:write',
        title: 'Confirm',
        description: 'Confirm an offer.',
        effect: 'write',
        input: inputSchema(
          refineSchema(Confirm, (value) => value.offerToken !== 'f'.repeat(32), {
            message: 'This offer was withdrawn.',
            path: ['offerToken'],
          })
        ),
        output: t.Object({ confirmed: t.Boolean() }, { additionalProperties: false }),
        rpc: true,
      },
      () => Promise.resolve(ok({ confirmed: true }))
    )
    .build();
  const principal = {
    actorId: 'service',
    actorKind: 'service' as const,
    organizationId: 'org_1234567890abcdef',
    requestId: '00000000-0000-4000-8000-000000000001',
  };
  const authority = {
    surface: 'http' as const,
    scopes: ['test:offers:write'],
    client: { id: 'runtime', class: 'machine' as const },
  };
  const refused = await executeOperation(
    app,
    app.operations.confirm,
    {},
    principal,
    { confirmed: true },
    authority
  );
  expect(refused.ok).toBe(false);
  if (refused.ok) {
    return;
  }
  expect(standardErrors.invalidInput.is(refused.error)).toBe(true);
  expect(refused.error.data).toEqual({
    issues: [
      { path: '/offerToken', message: 'Expected required property' },
      { path: '/offerToken', message: 'Expected string' },
    ],
  });
  const withdrawn = await executeOperation(
    app,
    app.operations.confirm,
    {},
    principal,
    { confirmed: true, offerToken: 'f'.repeat(32) },
    authority
  );
  expect(withdrawn).toMatchObject({
    ok: false,
    error: {
      code: 'INVALID_INPUT',
      data: { issues: [{ path: '/offerToken', message: 'This offer was withdrawn.' }] },
    },
  });
});
