import { defineHandler, t } from '@arbol-ai/maximus';

import { BookingSchema, DateSchema } from '#src/schedule.ts';

/** GET /api/v1/days/{date}/bookings: the day's bookings, by slot. */
export default defineHandler(
  async ({ input, daySchedule }) => {
    const bookings = await daySchedule(input.date).listBookings();
    return { bookings };
  },
  {
    description: "List a day's bookings, by slot.",
    input: { date: DateSchema },
    output: { bookings: t.Array(BookingSchema) },
  }
);
