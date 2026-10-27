# Durable Objects

A Durable Object is an instance of a class that Cloudflare runs once per name, with storage of its own and
one call at a time. This guide declares a class in `durable-objects/`, exports and binds it, reaches one
object per organization through a typed stub, stores rows and reads them back through a schema, and tests
it in Node. [`examples/do-appointments`](../../examples/do-appointments) is the complete service: one
schedule per organization and day, which never gives one slot to two callers.

## Declare the class

A module of `durable-objects/` default-exports a class that extends `DurableObject` from
`cloudflare:workers`:

```ts
// durable-objects/day-schedule.ts
import { readSchema } from '@arbol-ai/maximus/schemas';
import { DurableObject } from 'cloudflare:workers';

import { BookingSchema } from '../src/schedule.ts';
import type { Booking } from '../src/schedule.ts';

/** A row of the bookings table. */
type BookingRow = { slot: string; booking_id: string; patient_ref: string; booked_at: string };

/** One organization's schedule for one day: every booking of that day passes through it, one at a time. */
export default class DaySchedule extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS bookings (slot TEXT PRIMARY KEY, booking_id TEXT NOT NULL UNIQUE, patient_ref TEXT NOT NULL, booked_at TEXT NOT NULL)'
    );
  }

  /** The day's bookings, by slot, each read back through the booking's schema. */
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
}
```

The generated Worker exports the class under the PascalCase of its file's name, `DaySchedule` for
`day-schedule.ts`, and runs its methods inside the application's diagnostics. The file is named in
kebab-case at the top level of `durable-objects/`, and no class may be exported as `Service`, the name of
the Worker's RPC entrypoint. Under `vp dev`, adding or removing a module of `durable-objects/` restarts the
server so the Worker's exports follow.

## Export and bind it

The class becomes a Durable Object namespace when the Worker's configuration exports it, and the Worker
reaches its objects through a binding to it:

```ts
// vite.config.ts
import { maximus } from '@arbol-ai/maximus/vite';
import { bindings, exports } from 'cf/config';
import { defineConfig } from 'vite-plus';

/** The Worker's name, which its binding to its own Durable Object class names. */
const NAME = 'appointments';

export default defineConfig({
  plugins: [
    maximus({
      name: NAME,
      origin: 'https://appointments.example.com',
      tokens: { issuer: 'https://auth.example.com/' },
      compatibilityDate: '2026-10-27',
      // durable-objects/day-schedule.ts, exported as DaySchedule, keeps its bookings in SQLite.
      exports: { DaySchedule: exports.durableObject({ storage: 'sqlite' }) },
      env: { SCHEDULES: bindings.durableObject({ worker: NAME, exportName: 'DaySchedule' }) },
    }),
  ],
});
```

`worker` is the Worker's own name, so Maximus types the binding by the class:
`SCHEDULES: DurableObjectNamespace<DaySchedule>` in the generated `Env`. A stub's methods are then checked
against `DaySchedule`'s, and each answers a promise. A binding to another Worker's class keeps the untyped
`DurableObjectNamespace` that Cloudflare's inference gives it.

## Reach one object per organization

`getByName(name)` answers the stub of the object with that name, which Cloudflare creates on its first
call. Name objects after the verified organization, in `context.ts`, so a caller reaches only its own
organization's:

```ts
// context.ts
import { defineContext } from '@arbol-ai/maximus';

export default defineContext(({ env, principal }) => ({
  /** The organization's schedule for the day: one object per organization and day. */
  schedule: (date: string) => env.SCHEDULES.getByName(`${principal.organizationId}/${date}`),
}));
```

A route then calls the object as it would a store:

```ts
// routes/v1/days/[date]/bookings.post.ts
import { defineHandler } from '@arbol-ai/maximus';

import { BookingSchema, DateSchema, PatientRefSchema, SlotSchema } from '../../../../src/schedule.ts';

/** POST /api/v1/days/{date}/bookings: books a free slot, or answers SLOT_TAKEN. */
export default defineHandler(
  async ({ input, schedule, fail }) =>
    (await schedule(input.date).book(input.slot, input.patientRef)) ?? fail('SLOT_TAKEN'),
  {
    description: "Book a free slot of a day for a patient, named by your system's identifier for them.",
    input: { date: DateSchema, slot: SlotSchema, patientRef: PatientRefSchema },
    output: BookingSchema,
    failures: ['SLOT_TAKEN'],
    http: { successStatus: 201 },
  }
);
```

The organization comes from the token, never from input, so no date a caller sends reaches another
organization's schedule. Every booking of one day passes through one object, one call at a time, so of
two callers asking for one slot at once, one books it and the other answers `409 SLOT_TAKEN`.

## Store rows and read them back

`storage: 'sqlite'` gives each object a SQLite database of its own, `this.ctx.storage.sql`. The class above
creates its table in the constructor, which runs before the object's first call, and binds every value as
a parameter.

What an object reads back is untrusted like anything stored: `readSchema` checks each row against the
booking's schema and throws when one does not match, so a row the schema refuses is the server's error,
answered as `INTERNAL_ERROR`, never as a booking. See
[Schemas and validation](schemas-and-validation.md).

## Rename or remove a class

The class's exported name is the identity of its storage. Renaming the file renames the class, and with it
the namespace the binding reaches, so a rename or a removal is a migration declared in `exports`. To rename
`DaySchedule` to `BookingSchedule`, rename the file to `booking-schedule.ts`, bind the new name and declare
the rename:

```ts
exports: {
  BookingSchedule: exports.durableObject({ storage: 'sqlite' }),
  DaySchedule: exports.durableObject({ state: 'renamed', renamedTo: 'BookingSchedule' }),
},
env: { SCHEDULES: bindings.durableObject({ worker: NAME, exportName: 'BookingSchedule' }) },
```

`exports.durableObject({ state: 'deleted' })` retires the namespace of a class removed from the code.
Deploy each migration together with the code that matches it.

## Test it

`vp test` runs the class in Node. Under Vitest, `maximus()` resolves `cloudflare:workers` to a stand-in
whose `DurableObject` keeps the context and the bindings it is constructed with, so a test constructs the
class itself, with a state whose SQL storage is Node's SQLite, and stands in for the binding with a
namespace that keeps one object per name:

```ts
import { beforeEach } from 'vite-plus/test';

import DaySchedule from '../durable-objects/day-schedule.ts';
import { testNamespace } from './durable-objects.ts';

const token = 'test-development-token-for-local-tests';
let env: Env;

beforeEach(() => {
  const schedules = testNamespace((state) => new DaySchedule(state, env));
  env = { DEVELOPMENT_TOKEN: token, SCHEDULES: schedules } as unknown as Env;
});
```

[`examples/do-appointments/tests/durable-objects.ts`](../../examples/do-appointments/tests/durable-objects.ts)
holds that namespace, and
[`examples/do-appointments/tests/appointments.test.ts`](../../examples/do-appointments/tests/appointments.test.ts)
books through the API, gives one slot to exactly one of two callers, and proves that each organization and
day reaches its own object. See [Testing](testing.md).
