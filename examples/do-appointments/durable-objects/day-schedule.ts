/**
 * One organization's schedule for one day, exported as DaySchedule. Every booking of that day passes through
 * this one object, one call at a time, so two callers never hold the same slot. Bookings live in the object's
 * own SQLite storage and are read back through their schema.
 */
import { readSchema } from '@arbol-ai/maximus/schemas';
import { DurableObject } from 'cloudflare:workers';

import { BookingSchema } from '#src/schedule.ts';
import type { Booking, Slot } from '#src/schedule.ts';

/** A row of the bookings table. */
type BookingRow = { slot: string; booking_id: string; patient_ref: string; booked_at: string };

/** The booking a row stores, checked against the booking's schema. */
function bookingFromRow(row: BookingRow): Booking {
  return readSchema(BookingSchema, {
    bookingId: row.booking_id,
    slot: row.slot,
    patientRef: row.patient_ref,
    bookedAt: row.booked_at,
  });
}

/** Whether the day already has a booking that holds the slot. */
function isSlotHeld(sql: SqlStorage, slot: Slot): boolean {
  const bookings = sql.exec('SELECT 1 FROM bookings WHERE slot = ?', slot).toArray();
  return bookings.length > 0;
}

/** One organization's schedule for one day: its bookings, changed one call at a time. */
export default class DaySchedule extends DurableObject<Env> {
  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    state.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS bookings (slot TEXT PRIMARY KEY, booking_id TEXT NOT NULL UNIQUE, patient_ref TEXT NOT NULL, booked_at TEXT NOT NULL)'
    );
  }

  /** The day's bookings, by slot. */
  listBookings(): Booking[] {
    const rows = this.ctx.storage.sql
      .exec<BookingRow>('SELECT slot, booking_id, patient_ref, booked_at FROM bookings ORDER BY slot')
      .toArray();
    return rows.map(bookingFromRow);
  }

  /** Books the slot for the patient: the new booking, or undefined when the slot is already held. */
  book(slot: Slot, patientRef: string): Booking | undefined {
    if (isSlotHeld(this.ctx.storage.sql, slot)) {
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

  /** Cancels the booking, and answers whether the day held one with this id. */
  cancel(bookingId: string): boolean {
    const { rowsWritten } = this.ctx.storage.sql.exec('DELETE FROM bookings WHERE booking_id = ?', bookingId);
    return rowsWritten > 0;
  }
}
