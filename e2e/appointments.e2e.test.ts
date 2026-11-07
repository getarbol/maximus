/**
 * The Durable Object example running: of two callers asking for one slot at once, exactly one holds it; and
 * a booking that takes longer than a call waits answers a task, which runs once, beside the organization's
 * other tasks, for its caller alone.
 */
import { setTimeout as sleep } from 'node:timers/promises';

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

/** How long `confirmed-bookings` takes to confirm a booking, as its route declares. */
const CONFIRMATION_MS = 3000;
/** A task as the task routes answer it. */
interface Task {
  taskId: string;
  status: string;
  ttlMs: number;
  result?: { bookingId: string; slot: string; bookedAt: string };
}

describe.runIf(service('appointments')?.token)('appointments: tasks', () => {
  it("runs two of an organization's tasks side by side, each once, and answers them to their caller", async () => {
    const worker = required('appointments');
    const path = day();
    const prefer = { prefer: 'respond-async' };
    const answers = await Promise.all(
      ['10:00', '11:00'].map((slot) =>
        call(worker, `${path}/confirmed-bookings`, {
          method: 'POST',
          headers: prefer,
          json: { slot, patientRef: `MRN-${slot.slice(0, 2)}` },
        })
      )
    );
    const started: Task[] = [];
    for (const answer of answers) {
      expect(answer.status).toBe(202);
      expect(answer.headers.get('preference-applied')).toBe('respond-async');
      const task = await data<Task>(answer);
      expect(task).toMatchObject({ status: 'working', ttlMs: 3_600_000 });
      expect(answer.headers.get('location')).toMatch(new RegExp(`/api/v1/operation-tasks/${task.taskId}$`));
      started.push(task);
    }
    const [first, second] = started as [Task, Task];
    // A task that has started runs to its end: cancelling it changes nothing.
    const cancelled = await data<Task>(
      call(worker, `/api/v1/operation-tasks/${first.taskId}/cancel`, { method: 'POST', json: {} })
    );
    expect(cancelled.status).toBe('working');
    // An id this caller never started, of the service or not, names no task.
    for (const taskId of [`appointments.${crypto.randomUUID()}`, `notes.${crypto.randomUUID()}`, 'x']) {
      const unknown = await call(worker, `/api/v1/operation-tasks/${taskId}`);
      expect(unknown.status).toBe(400);
      expect(await unknown.json()).toMatchObject({ error: { code: 'INVALID_INPUT' } });
    }
    const settle = async ({ taskId }: Task): Promise<Task> => {
      let read = await data<Task>(call(worker, `/api/v1/operation-tasks/${taskId}`));
      for (let attempt = 0; attempt < 40 && read.status === 'working'; attempt += 1) {
        await sleep(250);
        read = await data<Task>(call(worker, `/api/v1/operation-tasks/${taskId}`));
      }
      return read;
    };
    const [one, two] = await Promise.all([settle(first), settle(second)]);
    expect(one).toMatchObject({ status: 'completed', result: { slot: '10:00' } });
    expect(two).toMatchObject({ status: 'completed', result: { slot: '11:00' } });
    // Side by side: the two confirmations ended together, not one after the other.
    const apart = Math.abs(Date.parse(one.result?.bookedAt ?? '') - Date.parse(two.result?.bookedAt ?? ''));
    expect(apart).toBeLessThan(CONFIRMATION_MS);
    // Each ran once: one booking per slot, the one each task answers, however often it is read.
    const { bookings } = await data<{ bookings: { bookingId: string; slot: string }[] }>(
      call(worker, `${path}/bookings`)
    );
    expect(bookings.map(({ bookingId }) => bookingId).toSorted()).toEqual(
      [one.result?.bookingId, two.result?.bookingId].toSorted()
    );
    expect((await settle(first)).result?.bookingId).toBe(one.result?.bookingId);
  });
});
