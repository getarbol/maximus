/**
 * The appointments service's own failures, registered for every handler: `fail` and `failures` take these
 * codes.
 */
import { defineErrors } from '@arbol-ai/maximus';

export default defineErrors({
  slotTaken: { code: 'SLOT_TAKEN', status: 409, message: 'The slot is already booked; choose another.' },
  bookingNotFound: { code: 'BOOKING_NOT_FOUND', status: 404, message: 'The booking does not exist.' },
});
