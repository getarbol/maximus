/**
 * Reminders in Workers KV, and the messages that deliver them. Every key starts with the verified
 * organization. A message names its organization and reminder alone, never the reminder's text: the queue,
 * its retries and its dead letters never hold what a reminder says.
 */
import { OrganizationIdSchema, t, UuidSchema } from '@arbol-ai/maximus';
import type { Static } from '@arbol-ai/maximus';
import { readSchema } from '@arbol-ai/maximus/schemas';

/** A reminder as it is stored and answered. */
export const ReminderSchema = t.Object(
  {
    reminderId: UuidSchema,
    text: t.String({ minLength: 1, maxLength: 500 }),
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

/** The organization's reminders. */
export function reminderStore(store: KVNamespace, organizationId: string) {
  const prefix = `${PREFIX}${organizationId}/`;
  /** Stores the reminder, with what the sweep reads in its metadata, and answers it. */
  const write = async (reminder: Reminder): Promise<Reminder> => {
    const metadata: ReminderMetadata = { status: reminder.status, dueAt: Date.parse(reminder.dueAt) };
    await store.put(`${prefix}${reminder.reminderId}`, JSON.stringify(reminder), { metadata });
    return reminder;
  };
  /** The reminder, or undefined when the organization has none with this id. */
  const get = async (reminderId: string): Promise<Reminder | undefined> => {
    const stored = await store.get(`${prefix}${reminderId}`);
    return stored === null ? undefined : readSchema(ReminderSchema, JSON.parse(stored));
  };
  return {
    get,
    /** Stores a pending reminder, due `delaySeconds` from now, and answers it. */
    create(text: string, delaySeconds: number): Promise<Reminder> {
      return write({
        reminderId: crypto.randomUUID(),
        text,
        status: 'pending',
        dueAt: new Date(Date.now() + delaySeconds * 1000).toISOString(),
      });
    },
    /**
     * Delivers the reminder once. A queue delivers each message at least once, so a reminder already
     * delivered stays as it is. A real service calls its SMS or email provider here, with the reminder's id
     * as the idempotency key. False when the organization has no such reminder.
     */
    async deliver(reminderId: string): Promise<boolean> {
      const reminder = await get(reminderId);
      if (!reminder) {
        return false;
      }
      if (reminder.status === 'pending') {
        await write({ ...reminder, status: 'delivered', deliveredAt: new Date().toISOString() });
      }
      return true;
    },
  };
}

/** The reminders of every organization still pending at `before`, as the messages that deliver them. */
export async function overdueReminders(store: KVNamespace, before: number): Promise<ReminderMessage[]> {
  const overdue: ReminderMessage[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.list<ReminderMetadata>({ prefix: PREFIX, cursor });
    for (const { name, metadata } of page.keys) {
      if (metadata?.status === 'pending' && metadata.dueAt < before) {
        // An organization id never holds a `/`: the key splits into exactly these two.
        const [organizationId = '', reminderId = ''] = name.slice(PREFIX.length).split('/');
        overdue.push({ organizationId, reminderId });
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return overdue;
}
