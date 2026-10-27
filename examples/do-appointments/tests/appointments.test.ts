/**
 * The appointments service in Node, its Durable Object on Node's SQLite: a booking's life, one slot asked for
 * by two callers at once, each organization and day reaching its own schedule, refusals, MCP, and a stored
 * booking its schema refuses, which is never answered.
 */
import { beforeEach, expect, it, vi } from 'vite-plus/test';

import { handler } from '#maximus/http';
import type { Booking } from '#src/schedule.ts';

import DaySchedule from '../durable-objects/day-schedule.ts';
import { testNamespace } from './durable-objects.ts';

/** The development token `vp test` accepts from localhost, as a developer holding every scope. */
const token = 'test-development-token-for-local-tests';
/** The path of the day most tests book. */
const DAY_PATH = '/v1/days/2026-11-02';
let schedules: ReturnType<typeof testNamespace<DaySchedule>>;
let env: Env;

beforeEach(() => {
  schedules = testNamespace((state) => new DaySchedule(state, env));
  env = { DEVELOPMENT_TOKEN: token, SCHEDULES: schedules } as unknown as Env;
  vi.restoreAllMocks();
});

/** Calls the API with the development token, sending `body` as JSON when there is one. */
async function call(method: string, path: string, body?: unknown) {
  const response = await handler(
    new Request(`http://localhost/api${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env
  );
  return { status: response.status, body: (await response.json()) as { data: unknown; error: unknown } };
}

/** Whether each slot of the day is free, by slot. */
async function readSlotAvailability(dayPath = DAY_PATH): Promise<Record<string, boolean>> {
  const { slots } = (await call('GET', `${dayPath}/slots`)).body.data as {
    slots: { slot: string; free: boolean }[];
  };
  return Object.fromEntries(slots.map(({ slot, free }) => [slot, free]));
}

/** Calls an MCP method with the development token and answers its result. */
async function callMcp(method: string, params: object = {}) {
  const response = await handler(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-11-25',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
    env
  );
  const text = await response.text();
  return (JSON.parse(/data: (\{[^\n]*)/u.exec(text)?.[1] ?? text) as { result: Record<string, unknown> })
    .result;
}

it('books a free slot, lists it, and frees it again when the booking is cancelled', async () => {
  expect(Object.values(await readSlotAvailability())).toEqual(Array.from({ length: 16 }, () => true));
  const booked = await call('POST', `${DAY_PATH}/bookings`, { slot: '10:30', patientRef: 'MRN-20431' });
  expect(booked).toMatchObject({ status: 201, body: { data: { slot: '10:30', patientRef: 'MRN-20431' } } });
  const booking = booked.body.data as Booking;
  expect(await readSlotAvailability()).toMatchObject({ '10:00': true, '10:30': false });
  expect((await call('GET', `${DAY_PATH}/bookings`)).body.data).toEqual({ bookings: [booking] });
  expect((await call('DELETE', `${DAY_PATH}/bookings/${booking.bookingId}`)).status).toBe(200);
  expect((await readSlotAvailability())['10:30']).toBe(true);
  expect(await call('DELETE', `${DAY_PATH}/bookings/${booking.bookingId}`)).toMatchObject({
    status: 404,
    body: { error: { code: 'BOOKING_NOT_FOUND' } },
  });
});

it('gives a slot asked for by two callers at once to exactly one of them', async () => {
  const answers = await Promise.all(
    ['MRN-1', 'MRN-2'].map((patientRef) =>
      call('POST', `${DAY_PATH}/bookings`, { slot: '09:00', patientRef })
    )
  );
  expect(answers.map(({ status }) => status).toSorted()).toEqual([201, 409]);
  expect(answers.find(({ status }) => status === 409)).toMatchObject({
    body: { error: { code: 'SLOT_TAKEN' } },
  });
});

it('reaches one schedule per organization and day, named after both', async () => {
  await call('POST', `${DAY_PATH}/bookings`, { slot: '09:00', patientRef: 'MRN-1' });
  expect((await readSlotAvailability('/v1/days/2026-11-03'))['09:00']).toBe(true);
  // Another organization's schedule of the same day is another object, which this caller never reaches.
  expect(schedules.getByName('org_lab/2026-11-02').listBookings()).toEqual([]);
  expect(schedules.listNames()).toEqual([
    'local-development/2026-11-02',
    'local-development/2026-11-03',
    'org_lab/2026-11-02',
  ]);
});

it('refuses a day that is no date, a slot the day does not offer and a patient named rather than referenced', async () => {
  for (const [path, body] of [
    ['/v1/days/2026-13-40/bookings', { slot: '09:00', patientRef: 'MRN-1' }],
    ['/v1/days/tomorrow/bookings', { slot: '09:00', patientRef: 'MRN-1' }],
    [`${DAY_PATH}/bookings`, { slot: '08:00', patientRef: 'MRN-1' }],
    [`${DAY_PATH}/bookings`, { slot: '09:00', patientRef: 'Jane Doe' }],
  ] as const) {
    expect((await call('POST', path, body)).status, `${path} ${JSON.stringify(body)}`).toBe(400);
  }
  expect(schedules.listNames()).toEqual([]);
});

it('serves list_slots and book_slot over MCP', async () => {
  const tools = (await callMcp('tools/list')).tools as { name: string }[];
  expect(tools.map(({ name }) => name).toSorted()).toEqual(['book_slot', 'list_slots']);
  expect(
    await callMcp('tools/call', {
      name: 'book_slot',
      arguments: { date: '2026-11-02', slot: '11:00', patientRef: 'MRN-7' },
    })
  ).toMatchObject({ structuredContent: { slot: '11:00', patientRef: 'MRN-7' } });
  expect((await readSlotAvailability())['11:00']).toBe(false);
});

it('never answers a stored booking its schema refuses', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  await call('POST', `${DAY_PATH}/bookings`, { slot: '09:00', patientRef: 'MRN-1' });
  const schedule = schedules.getByName('local-development/2026-11-02');
  Reflect.get(schedule, 'ctx').storage.sql.exec(
    "UPDATE bookings SET patient_ref = 'Jane Doe' WHERE slot = '09:00'"
  );
  expect(await call('GET', `${DAY_PATH}/bookings`)).toMatchObject({
    status: 500,
    body: { error: { code: 'INTERNAL_ERROR' } },
  });
});
