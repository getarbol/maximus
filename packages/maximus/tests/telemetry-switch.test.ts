/**
 * Telemetry switches isolated per invocation, and observers isolated from each other's failures.
 */
import { expect, it, vi } from 'vitest';

import { reportUnexpected, withDiagnostics } from '../src/telemetry.ts';

it('isolates telemetry switches across concurrent invocations', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    await Promise.all([
      withDiagnostics(false, async () => {
        await Promise.resolve();
        reportUnexpected(new Error('private'));
      }),
      withDiagnostics(true, async () => {
        await Promise.resolve();
        reportUnexpected(new Error('visible'));
      }),
    ]);
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.stringify(log.mock.calls)).not.toContain('private');
  } finally {
    log.mockRestore();
  }
});

it('delivers to independent observers without allowing an exporter failure to escape', async () => {
  const { recordExecution } = await import('../src/telemetry.ts');
  const success = vi.fn(async () => undefined);
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const tasks: Promise<unknown>[] = [];
  try {
    recordExecution(
      {
        name: 'test',
        telemetry: {
          observers: [
            {
              execution: async () => {
                throw new Error('private-exporter-error');
              },
            },
            { execution: success },
          ],
        },
      },
      {},
      { waitUntil: (task) => tasks.push(task) },
      {
        principal: {
          organizationId: 'org_1234567890abcdef',
          actorId: 'client',
          actorKind: 'service',
          requestId: crypto.randomUUID(),
        },
        operation: 'readRecord',
        surface: 'http',
        started: performance.now(),
        result: { ok: true, value: { privateBody: 'never-export' } },
      }
    );
    await Promise.all(tasks);
    expect(success).toHaveBeenCalledOnce();
    expect(JSON.stringify(success.mock.calls)).not.toContain('never-export');
    expect(JSON.stringify(log.mock.calls)).not.toContain('private-exporter-error');
  } finally {
    log.mockRestore();
  }
});
