/**
 * One organization's schedule for one day, exported as DaySchedule. Every booking of that day passes through
 * this one object, one call at a time, so two callers never hold the same slot. Bookings live in the object's
 * own SQLite storage and are read back through their schema.
 */
import { readSchema } from '@arbol-ai/maximus/schemas';
import { DurableObject } from 'cloudflare:workers';

import { BookingSchema } from '../src/schedule.ts';
import type { Booking } from '../src/schedule.ts';

/** A row of the bookings table. */
type BookingRow = { slot: string; booking_id: string; patient_ref: string; booked_at: string };

export default class DaySchedule extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS bookings (slot TEXT PRIMARY KEY, booking_id TEXT NOT NULL UNIQUE, patient_ref TEXT NOT NULL, booked_at TEXT NOT NULL)'
    );
  }

  /** The day's bookings, by slot. */
  bookings(): Booking[] {
    return this.ctx.storage.sql
      .exec<BookingRow>('SELECT slot, booking_id, patient_ref, booked_at FROM bookings ORDER BY slot')
      .toArray()
      .map((row) =>
        readSchema(BookingSchema, {
          bookingId: row.booking_id,
          slot: row.slot,
          patientRef: row.patient_ref,
          bookedAt: row.booked_at,
        })
      );
  }

  /** Books the slot for the patient: the new booking, or undefined when the slot is already held. */
  book(slot: Booking['slot'], patientRef: string): Booking | undefined {
    if (this.ctx.storage.sql.exec('SELECT 1 FROM bookings WHERE slot = ?', slot).toArray().length > 0) {
      return undefined;
    }
    const booking: Booking = {
      bookingId: crypto.randomUUID(),
      slot,
      patientRef,
      bookedAt: new Date().toISOString(),
    };
    this.ctx.storage.sql.exec(
      'INSERT INTO bookings (slot, booking_id, patient_ref, booked_at) VALUES (?, ?, ?, ?)',
      booking.slot,
      booking.bookingId,
      booking.patientRef,
      booking.bookedAt
    );
    return booking;
  }

  /** Cancels the booking; false when the day holds none with this id. */
  cancel(bookingId: string): boolean {
    return this.ctx.storage.sql.exec('DELETE FROM bookings WHERE booking_id = ?', bookingId).rowsWritten > 0;
  }
}
