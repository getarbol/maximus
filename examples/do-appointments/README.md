# Appointments in a Durable Object

An appointments service whose schedules are Durable Objects: one per organization and day, which every
booking of that day passes through one call at a time, so two callers never hold the same slot.

```text
vite.config.ts                                         The service, the DaySchedule export and its SCHEDULES binding
errors.ts                                              SLOT_TAKEN and BOOKING_NOT_FOUND
context.ts                                             schedule(date): the organization's schedule for that day
src/schedule.ts                                        The slots, the booking and the patient reference schemas
durable-objects/day-schedule.ts                        DaySchedule: the day's bookings in its own SQLite storage
routes/v1/days/[date]/slots.get.ts                     GET    /api/v1/days/{date}/slots      (+ MCP list_slots)
routes/v1/days/[date]/bookings.get.ts                  GET    /api/v1/days/{date}/bookings
routes/v1/days/[date]/bookings.post.ts                 POST   /api/v1/days/{date}/bookings   (+ MCP book_slot)
routes/v1/days/[date]/bookings/[bookingId].delete.ts   DELETE /api/v1/days/{date}/bookings/{bookingId}
mcp/instructions.md                                    What MCP clients read when they connect
tests/appointments.test.ts                             The API, the object and MCP in Node, the object on SQLite
```

## Run it

```sh
bun install                        # once, at the repository root
cd examples/do-appointments
echo "DEVELOPMENT_TOKEN=$(openssl rand -hex 32)" > .dev.vars
bun run dev                        # http://localhost:5173
```

```sh
TOKEN=$(cut -d= -f2 .dev.vars)
curl -s http://localhost:5173/api/v1/days/2026-11-02/slots -H "authorization: Bearer $TOKEN"
curl -s -X POST http://localhost:5173/api/v1/days/2026-11-02/bookings \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"slot":"09:30","patientRef":"MRN-20431"}'
# 201; the same request again answers 409 SLOT_TAKEN
```

## Deploy it

Set `tokens.issuer` to your authorization server first: a deployed Worker accepts its access tokens alone.

```sh
bunx cf auth login
export WORKERS_SUBDOMAIN=<your workers.dev subdomain>
bun run build && bunx cf deploy --prebuilt --mode production
```

## What to notice

- `durable-objects/day-schedule.ts` is exported as `DaySchedule`, the name `exports` declares with its
  SQLite storage. That name is its storage's: renaming or removing the class is a migration, declared in
  `exports`, never a file rename alone.
- The generated `Env` types `SCHEDULES` by the class it binds, so `schedule(date).book(…)` is checked
  against `DaySchedule`'s methods.
- A schedule is named after the verified organization and the day, so a caller reaches only its own
  organization's; the slots it lists say which are free, never who holds the others.
- A booking names its patient by the caller's own identifier, never by name, and the schema refuses
  anything else.
- The object reads its rows back through the booking's schema: a row the schema refuses is the
  service's error, never an answer.
- `vp test` runs the class in Node: `maximus()` resolves `cloudflare:workers` to a stand-in, and the
  tests give it SQL storage on Node's SQLite.
