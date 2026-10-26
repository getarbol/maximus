/**
 * String formats: date-time validation comes from the formats Maximus registers itself.
 */
import { it, expect } from 'vite-plus/test';

import { parseInput, t } from '../src/index.ts';

it('owns date-time validation without incidental framework format registration', () => {
  const schema = t.String({ format: 'date-time' });
  expect(parseInput(schema, '2024-02-29T10:00:00.000Z').ok).toBe(true);
  expect(parseInput(schema, '2025-02-29T10:00:00Z').ok).toBe(false);
  expect(parseInput(schema, '2024-02-29T10:00:00').ok).toBe(false);
  expect(parseInput(schema, '2024-02-29T10:00:00-05:00').ok).toBe(true);
});
