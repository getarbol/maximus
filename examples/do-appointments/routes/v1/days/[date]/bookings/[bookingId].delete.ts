import { defineHandler, UuidSchema } from '@arbol-ai/maximus';

import { DateSchema } from '../../../../../src/schedule.ts';

/** DELETE /api/v1/days/{date}/bookings/{bookingId}: frees the booking's slot. */
export default defineHandler(
  async ({ input, schedule, fail }) => {
    if (!(await schedule(input.date).cancel(input.bookingId))) {
      return fail('BOOKING_NOT_FOUND');
    }
  },
  {
    description: 'Cancel a booking, freeing its slot.',
    input: { date: DateSchema, bookingId: UuidSchema },
    failures: ['BOOKING_NOT_FOUND'],
  }
);
