/**
 * The Durable Object example running: of two callers asking for one slot at once, exactly one holds it.
 */
import { describe, expect, it } from 'vite-plus/test';

import { call, data, required, service } from './services.ts';
import { publicSurface } from './surface.ts';

publicSurface('appointments', { method: 'GET', path: '/v1/days/{date}/slots', mcp: true });

/** A day of its own for this run, so bookings earlier runs left in the local state never meet its own. */
function day(): string {
  const random = (from: number, to: number) => String(from + Math.floor(Math.random() * (to - from + 1)));
  return `/api/v1/days/${random(2100, 2999)}-${random(10, 12)}-${random(10, 28)}`;
}

describe.runIf(service('appointments')?.token)('appointments: signed in', () => {
  it('gives a slot asked for by two callers at once to exactly one, and frees it on cancellation', async () => {
    const worker = required('appointments');
    const path = day();
    const answers = await Promise.all(
      ['MRN-1', 'MRN-2'].map((patientRef) =>
        call(worker, `${path}/bookings`, { method: 'POST', json: { slot: '09:00', patientRef } })
      )
    );
    expect(answers.map(({ status }) => status).toSorted()).toEqual([201, 409]);
    const booked = answers.find(({ status }) => status === 201);
    expect(booked).toBeDefined();
    const { bookingId } = await data<{ bookingId: string }>(booked as Response);
    expect((await call(worker, `${path}/bookings/${bookingId}`, { method: 'DELETE' })).status).toBe(200);
    const { slots } = await data<{ slots: { slot: string; free: boolean }[] }>(call(worker, `${path}/slots`));
    expect(slots.find(({ slot }) => slot === '09:00')?.free).toBe(true);
  });
});
