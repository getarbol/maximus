import { defineHandler } from '@arbol-ai/maximus';

import { BookingSchema, DateSchema, PatientRefSchema, SlotSchema } from '#src/schedule.ts';

/**
 * POST /api/v1/days/{date}/bookings, also the MCP tool book_slot: the booking of a slot of the day for a
 * patient, or SLOT_TAKEN when someone holds the slot already, however many callers ask at once.
 */
export default defineHandler(
  async ({ input, daySchedule, fail }) => {
    const booking = await daySchedule(input.date).book(input.slot, input.patientRef);
    if (!booking) {
      return fail('SLOT_TAKEN');
    }
    return booking;
  },
  {
    description:
      "Book a free slot of a day for a patient, named by your system's identifier for them, never by their name.",
    input: { date: DateSchema, slot: SlotSchema, patientRef: PatientRefSchema },
    output: BookingSchema,
    failures: ['SLOT_TAKEN'],
    http: { successStatus: 201 },
    mcp: { name: 'book_slot' },
  }
);
