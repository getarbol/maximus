import { defineHandler, t } from '@arbol-ai/maximus';

import { BookingSchema, DateSchema } from '../../../../src/schedule.ts';

/** GET /api/v1/days/{date}/bookings: the day's bookings, by slot. */
export default defineHandler(
  async ({ input, schedule }) => ({ bookings: await schedule(input.date).bookings() }),
  {
    description: "List a day's bookings, by slot.",
    input: { date: DateSchema },
    output: { bookings: t.Array(BookingSchema) },
  }
);
