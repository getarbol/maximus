/** File modules use native Workers handlers; unmatched events fail instead of disappearing. */
type Handlers<E> = Omit<ExportedHandler<E>, 'fetch'>;

/** One schedule, declared beside the code it runs. Configure its trigger in Cloudflare as well. */
export interface ProjectCron<E> {
  cron: string;
  handler: NonNullable<Handlers<E>['scheduled']>;
}

/** Optional background modules discovered at build time. Keys are physical queue names and recipients. */
export interface ProjectEvents<E> {
  crons?: readonly ProjectCron<E>[];
  queues?: Readonly<Record<string, NonNullable<Handlers<E>['queue']>>>;
  email?: Readonly<Record<string, NonNullable<Handlers<E>['email']>>>;
}

/** Compose file handlers with explicit fallbacks, preserving the platform's execution context. */
export function projectHandlers<E>(events: ProjectEvents<E>, fallback: Handlers<E> = {}): Handlers<E> {
  const handlers: Handlers<E> = { ...fallback };
  if (events.crons?.length) {
    const schedules = new Map<string, NonNullable<Handlers<E>['scheduled']>[]>();
    for (const { cron, handler } of events.crons) {
      if (!cron.trim()) {
        throw new TypeError('A cron module must export a nonempty cron expression.');
      }
      schedules.set(cron, [...(schedules.get(cron) ?? []), handler]);
    }
    handlers.scheduled = async function scheduled(controller, env, context) {
      const matched = schedules.get(controller.cron);
      if (!matched) {
        if (fallback.scheduled) {
          await fallback.scheduled.call(this, controller, env, context);
          return;
        }
        throw new Error('No module handles this cron trigger.');
      }
      await Promise.all(
        matched.map(async (handler) => {
          await handler.call(this, controller, env, context);
        })
      );
    };
  }
  if (events.queues && Object.keys(events.queues).length) {
    const queues = new Map(Object.entries(events.queues));
    handlers.queue = async function queue(batch, env, context) {
      const handler = queues.get(batch.queue) ?? fallback.queue;
      if (!handler) {
        throw new Error('No module handles this queue; the batch must be retried.');
      }
      await handler.call(this, batch, env, context);
    };
  }
  if (events.email && Object.keys(events.email).length) {
    const recipients = new Map(Object.entries(events.email));
    handlers.email = async function email(message, env, context) {
      const handler = recipients.get(message.to) ?? recipients.get('_default') ?? fallback.email;
      if (!handler) {
        message.setReject('This recipient is not configured.');
        return;
      }
      await handler.call(this, message, env, context);
    };
  }
  return handlers;
}
