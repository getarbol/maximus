import { defineHandler, UuidSchema } from '@arbol-ai/maximus';

import { DateSchema } from '#src/schedule.ts';

/** DELETE /api/v1/days/{date}/bookings/{bookingId}: frees the booking's slot. */
export default defineHandler(
  async ({ input, daySchedule, fail }) => {
    const wasCancelled = await daySchedule(input.date).cancel(input.bookingId);
    if (!wasCancelled) {
      return fail('BOOKING_NOT_FOUND');
    }
  },
  {
    description: 'Cancel a booking, freeing its slot.',
    input: { date: DateSchema, bookingId: UuidSchema },
    failures: ['BOOKING_NOT_FOUND'],
  }
);
