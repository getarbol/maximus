import { defineHandler } from '@arbol-ai/maximus';

import { BookingSchema, DateSchema, PatientRefSchema, SlotSchema } from '#src/schedule.ts';

/** How long the clinic takes to confirm a booking: longer than a call waits before it answers a task. */
const CONFIRMATION_MS = 3000;

/**
 * POST /api/v1/days/{date}/confirmed-bookings: the booking of a slot once the clinic confirms it, which takes
 * a few seconds. A caller that sends `Prefer: respond-async` gets a task at once and reads the booking from
 * it; any other waits for the booking. SLOT_TAKEN when someone holds the slot already.
 */
export default defineHandler(
  async ({ input, daySchedule, fail }) => {
    await scheduler.wait(CONFIRMATION_MS);
    const booking = await daySchedule(input.date).book(input.slot, input.patientRef);
    if (!booking) {
      return fail('SLOT_TAKEN');
    }
    return booking;
  },
  {
    description:
      "Book a free slot of a day for a patient, named by your system's identifier for them, once the clinic confirms it, which takes a few seconds.",
    input: { date: DateSchema, slot: SlotSchema, patientRef: PatientRefSchema },
    output: BookingSchema,
    failures: ['SLOT_TAKEN'],
    http: { successStatus: 201 },
    task: true,
  }
);
