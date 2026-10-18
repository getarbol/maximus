/**
 * The Worker that serves the tasks operations over HTTP and MCP.
 */
import { mcp } from '@arbol-ai/maximus/mcp';
import { createWorker } from '@arbol-ai/maximus/workers';

import { app } from './app';

/** The same operations over HTTP (`/v1/...`) and MCP (`/mcp`). */
const worker = createWorker(app, { transports: [mcp()] });

export default worker.handler;
