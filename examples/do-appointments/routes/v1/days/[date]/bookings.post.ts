import { defineHandler } from '@arbol-ai/maximus';

import { BookingSchema, DateSchema, PatientRefSchema, SlotSchema } from '../../../../src/schedule.ts';

/**
 * POST /api/v1/days/{date}/bookings, also the MCP tool book_slot: books a slot of the day for a patient, or
 * answers SLOT_TAKEN when someone holds it already, however many callers ask at once.
 */
export default defineHandler(
  async ({ input, schedule, fail }) =>
    (await schedule(input.date).book(input.slot, input.patientRef)) ?? fail('SLOT_TAKEN'),
  {
    description:
      "Book a free slot of a day for a patient, named by your system's identifier for them, never their name.",
    input: { date: DateSchema, slot: SlotSchema, patientRef: PatientRefSchema },
    output: BookingSchema,
    failures: ['SLOT_TAKEN'],
    http: { successStatus: 201 },
    mcp: { name: 'book_slot' },
  }
);
