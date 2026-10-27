/**
 * What a day's schedule offers and holds: its slots, a booking, and the reference to a patient a booking
 * carries, which is the caller's own identifier for them, never their name.
 */
import { t, UuidSchema } from '@arbol-ai/maximus';
import type { Static } from '@arbol-ai/maximus';
import { literalUnion } from '@arbol-ai/maximus/schemas';

/** The slots every day offers: each half hour from 09:00 to 16:30. */
export const SLOTS = [
  '09:00',
  '09:30',
  '10:00',
  '10:30',
  '11:00',
  '11:30',
  '12:00',
  '12:30',
  '13:00',
  '13:30',
  '14:00',
  '14:30',
  '15:00',
  '15:30',
  '16:00',
  '16:30',
] as const;

/** One of the day's slots. */
export const SlotSchema = literalUnion(SLOTS);

/** A day, `YYYY-MM-DD`. */
export const DateSchema = t.String({ format: 'date' });

/** The caller's reference to a patient: an identifier of their own system, never a name. */
export const PatientRefSchema = t.String({ pattern: '^[A-Za-z0-9_-]{1,64}$' });

/** A booking: the slot it holds, for whom, and when it was made. */
export const BookingSchema = t.Object(
  {
    bookingId: UuidSchema,
    slot: SlotSchema,
    patientRef: PatientRefSchema,
    bookedAt: t.String({ format: 'date-time' }),
  },
  { $id: 'Booking', additionalProperties: false }
);
/** A booking. */
export type Booking = Static<typeof BookingSchema>;
