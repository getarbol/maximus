/**
 * Reminders in Workers KV, and the messages that deliver them. Every key starts with the verified
 * organization. A message names its organization and reminder alone, never the reminder's text: the queue,
 * its retries and its dead letters never hold what a reminder says.
 */
import { OrganizationIdSchema, t, UuidSchema } from '@arbol-ai/maximus';
import type { Static } from '@arbol-ai/maximus';
import { readSchema } from '@arbol-ai/maximus/schemas';

/** What a reminder says, in at most 500 characters. */
export const ReminderTextSchema = t.String({ minLength: 1, maxLength: 500 });

/** A reminder as it is stored and answered. */
export const ReminderSchema = t.Object(
  {
    reminderId: UuidSchema,
    text: ReminderTextSchema,
    status: t.Union([t.Literal('pending'), t.Literal('delivered')]),
    dueAt: t.String({ format: 'date-time' }),
    deliveredAt: t.Optional(t.String({ format: 'date-time' })),
  },
  { $id: 'Reminder', additionalProperties: false }
);
/** A reminder. */
export type Reminder = Static<typeof ReminderSchema>;

/** A message of the reminders queue: the reminder to deliver and its organization. */
export const ReminderMessageSchema = t.Object(
  { organizationId: OrganizationIdSchema, reminderId: UuidSchema },
  { additionalProperties: false }
);
/** A message of the reminders queue. */
export type ReminderMessage = Static<typeof ReminderMessageSchema>;

declare global {
  interface Env {
    /** The reminders queue. vite.config.ts binds it by name, which carries no message type. */
    REMINDERS: Queue<ReminderMessage>;
  }
}

/** What a key's metadata says of its reminder, which the sweep reads without reading the reminder. */
interface ReminderMetadata {
  status: Reminder['status'];
  /** When the reminder is due, in milliseconds since the epoch. */
  dueAt: number;
}

/** Where every organization's reminders start. */
const PREFIX = 'reminders/';
/** The most messages one `sendBatch` takes. */
const MAX_MESSAGES_PER_BATCH = 100;

/** The reminders of one organization: stored in KV under its id, and delivered through the queue. */
export function reminderStore(namespace: KVNamespace, queue: Queue<ReminderMessage>, organizationId: string) {
  const prefix = `${PREFIX}${organizationId}/`;

  /** The key a reminder of the organization is stored under. */
  function reminderKey(reminderId: string): string {
    return `${prefix}${reminderId}`;
  }

  /** Stores the reminder, with what the sweep reads in its metadata, and answers it. */
  async function save(reminder: Reminder): Promise<Reminder> {
    const metadata: ReminderMetadata = { status: reminder.status, dueAt: Date.parse(reminder.dueAt) };
    await namespace.put(reminderKey(reminder.reminderId), JSON.stringify(reminder), { metadata });
    return reminder;
  }

  /** The reminder with this id, or undefined when the organization has none. */
  async function find(reminderId: string): Promise<Reminder | undefined> {
    const stored = await namespace.get(reminderKey(reminderId));
    if (stored === null) {
      return undefined;
    }
    return readSchema(ReminderSchema, JSON.parse(stored));
  }

  return {
    find,

    /**
     * Stores a pending reminder, due `delaySeconds` from now, then queues the message that delivers it, and
     * answers the reminder. Should queueing fail, the stored reminder waits for the sweep.
     */
    async schedule(text: string, delaySeconds = 0): Promise<Reminder> {
      const reminder = await save({
        reminderId: crypto.randomUUID(),
        text,
        status: 'pending',
        dueAt: new Date(Date.now() + delaySeconds * 1000).toISOString(),
      });
      await queue.send({ organizationId, reminderId: reminder.reminderId }, { delaySeconds });
      return reminder;
    },

    /**
     * Delivers the reminder once, and answers whether the organization has one with this id. A queue delivers
     * each message at least once, so a reminder already delivered stays as it is. A real service calls its
     * SMS or email provider here, with the reminder's id as the idempotency key.
     */
    async deliver(reminderId: string): Promise<boolean> {
      const reminder = await find(reminderId);
      if (!reminder) {
        return false;
      }
      if (reminder.status === 'pending') {
        await save({ ...reminder, status: 'delivered', deliveredAt: new Date().toISOString() });
      }
      return true;
    },
  };
}

/** Whether a key's reminder is still pending, though it was due before this time. */
function isOverdue(metadata: ReminderMetadata | undefined, dueBeforeMs: number): boolean {
  if (metadata?.status !== 'pending') {
    return false;
  }
  return metadata.dueAt < dueBeforeMs;
}

/** The message that delivers the reminder a key names. */
function messageFromKey(key: string): ReminderMessage {
  // An organization id never holds a `/`: the key splits into exactly these two.
  const [organizationId = '', reminderId = ''] = key.slice(PREFIX.length).split('/');
  return { organizationId, reminderId };
}

/** The reminders of every organization still pending though due before this time, as their messages. */
export async function findOverdueReminders(
  namespace: KVNamespace,
  dueBeforeMs: number
): Promise<ReminderMessage[]> {
  const overdueReminders: ReminderMessage[] = [];
  let cursor: string | undefined;
  do {
    const page = await namespace.list<ReminderMetadata>({ prefix: PREFIX, cursor });
    for (const key of page.keys) {
      if (isOverdue(key.metadata, dueBeforeMs)) {
        overdueReminders.push(messageFromKey(key.name));
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return overdueReminders;
}

/** Sends the messages to the queue, in as many batches as they need. */
export async function sendInBatches(
  queue: Queue<ReminderMessage>,
  messages: readonly ReminderMessage[]
): Promise<void> {
  for (let start = 0; start < messages.length; start += MAX_MESSAGES_PER_BATCH) {
    const batch = messages.slice(start, start + MAX_MESSAGES_PER_BATCH);
    await queue.sendBatch(batch.map((body) => ({ body })));
  }
}
