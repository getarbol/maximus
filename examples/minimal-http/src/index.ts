/**
 * The Worker that serves the notes application over HTTP.
 */
import { createWorker } from '@arbol-ai/maximus/workers';

import { app } from './app';

/** The application as a Worker: its fetch handler serves the HTTP operations. */
const worker = createWorker(app);

export default worker.handler;
