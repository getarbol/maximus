/**
 * The queue example running: a reminder scheduled through the API is delivered by the queue's consumer.
 */
import { setTimeout as sleep } from 'node:timers/promises';

import { describe, expect, it } from 'vite-plus/test';

import { call, data, required, service } from './services.ts';
import { publicSurface } from './surface.ts';

publicSurface('reminders', { method: 'POST', path: '/v1/reminders', mcp: true });

describe.runIf(service('reminders')?.token)('reminders: signed in', () => {
  it('delivers a scheduled reminder through the queue', async () => {
    const worker = required('reminders');
    const reminder = await data<{ reminderId: string; status: string }>(
      call(worker, '/api/v1/reminders', { method: 'POST', json: { text: 'Call the lab about the results' } })
    );
    expect(reminder.status).toBe('pending');
    let { status } = reminder;
    for (let attempt = 0; attempt < 40 && status !== 'delivered'; attempt += 1) {
      await sleep(500);
      ({ status } = await data<{ status: string }>(call(worker, `/api/v1/reminders/${reminder.reminderId}`)));
    }
    expect(status).toBe('delivered');
  });
});
