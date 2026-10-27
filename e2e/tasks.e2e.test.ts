/**
 * The tasks example running: its API and MCP signed in, and the web app its Worker serves at the root, with
 * the headers a production build answers it with.
 */
import { describe, expect, it } from 'vite-plus/test';

import { call, data, mcp, required, service } from './services.ts';
import { publicSurface } from './surface.ts';

publicSurface('tasks', { method: 'GET', path: '/v1/tasks', mcp: true });

describe.runIf(service('tasks'))('tasks: its web app', () => {
  it('serves the app at the root, and in production with its security headers', async () => {
    const worker = required('tasks');
    const page = await call(worker, '/', { signedIn: false });
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(await page.text()).toContain('<div id="root">');
    if (worker.deployed) {
      expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      expect(page.headers.get('strict-transport-security')).toContain('max-age=');
    }
  });
});

describe.runIf(service('tasks')?.token)('tasks: signed in', () => {
  it('creates a task, completes it over MCP and deletes it', async () => {
    const worker = required('tasks');
    const task = await data<{ taskId: string; done: boolean }>(
      call(worker, '/api/v1/tasks', { method: 'POST', json: { title: 'Send the invoice to Acme' } })
    );
    expect(task.done).toBe(false);
    expect(
      await mcp(worker, 'tools/call', { name: 'complete_task', arguments: { taskId: task.taskId } })
    ).toMatchObject({
      structuredContent: { taskId: task.taskId, done: true },
    });
    expect((await call(worker, `/api/v1/tasks/${task.taskId}`, { method: 'DELETE' })).status).toBe(200);
    expect((await call(worker, `/api/v1/tasks/${task.taskId}`)).status).toBe(404);
  });
});
