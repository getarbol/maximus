import { defineHandler, t } from '@arbol-ai/maximus';

import { DateSchema, SlotSchema, SLOTS } from '../../../../src/schedule.ts';

/**
 * GET /api/v1/days/{date}/slots, also the MCP tool list_slots: which of the day's slots are free. It says
 * nothing of who holds the others.
 */
export default defineHandler(
  async ({ input, schedule }) => {
    const held = new Set((await schedule(input.date).bookings()).map(({ slot }) => slot));
    return { date: input.date, slots: SLOTS.map((slot) => ({ slot, free: !held.has(slot) })) };
  },
  {
    description: 'List the slots of a day, each free or held, to choose one to book.',
    input: { date: DateSchema },
    output: { date: DateSchema, slots: t.Array(t.Object({ slot: SlotSchema, free: t.Boolean() })) },
    mcp: { name: 'list_slots' },
  }
);
