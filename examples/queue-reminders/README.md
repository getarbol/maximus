# Reminders over a queue

A reminders service built on Cloudflare Queues: the API stores a reminder and queues its delivery, the
queue's consumer delivers it, and a cron queues again whatever was never delivered.

```text
vite.config.ts                              The service, the REMINDERS queue, the REMINDER_STATE namespace,
                                            and how the queue is consumed (batches, retries, dead letters)
errors.ts                                   REMINDER_NOT_FOUND
context.ts                                  The caller's organization's reminders, in every handler
src/reminders.ts                            The reminder and message schemas, the store and the overdue scan
routes/v1/reminders/index.post.ts           POST /api/v1/reminders               202 (+ MCP schedule_reminder)
routes/v1/reminders/[reminderId].get.ts     GET  /api/v1/reminders/{reminderId}  (+ MCP get_reminder)
queues/maximus-example-reminders.ts         The consumer, named after its queue
crons/sweep.ts                              Every quarter of an hour, queues overdue reminders again
tests/reminders.test.ts                     The API, the consumer and the sweep in Node, over stand-ins
```

## Run it

```sh
bun install                        # once, at the repository root
cd examples/queue-reminders
echo "DEVELOPMENT_TOKEN=$(openssl rand -hex 32)" > .dev.vars
bun run dev                        # http://localhost:5173
```

```sh
TOKEN=$(cut -d= -f2 .dev.vars)
curl -s -X POST http://localhost:5173/api/v1/reminders \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"text":"Call the lab about the results"}'
# 202, status "pending"; a moment later GET /api/v1/reminders/<id> answers status "delivered"
```

`vp dev` runs the queue locally, so the consumer delivers the reminder within a second. To run the sweep
now, ask the dev server's explorer:

```sh
curl -s -X POST 'http://localhost:5173/cdn-cgi/local/explorer/api/local/scheduled?worker=example-queue-reminders' \
  -H 'content-type: application/json' -d '{"cron":"*/15 * * * *"}'
```

## Deploy it

Set `tokens.issuer` to your authorization server first: a deployed Worker accepts its access tokens alone.

```sh
bunx cf auth login
export WORKERS_SUBDOMAIN=<your workers.dev subdomain>
bun run build && bunx cf deploy --prebuilt --mode production
```

The first deployment creates the queue, the namespace and the cron trigger; the dead letter queue is
created when the first message moves to it.

## What to notice

- A message names its organization and reminder, never the reminder's text: the queue, its retries and
  its dead letters never hold what a reminder says.
- Queues deliver each message at least once, so delivering is idempotent: a reminder already delivered
  stays as it is. A real provider call passes the reminder's id as its idempotency key.
- The consumer checks every message against its schema. One the service never sends cannot succeed, so
  it is acknowledged and reported by its safe description; a delivery that fails is retried with a
  growing delay, and after five retries, six deliveries in all, the message moves to the dead letter queue.
- The reminder is stored before its message is sent. Should sending fail, the call fails, and the sweep
  queues the stored reminder once it is a quarter of an hour overdue.
- The sweep reads each key's metadata, not its value, to find what is overdue.
