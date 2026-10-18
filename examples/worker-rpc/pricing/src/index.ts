/**
 * The pricing Worker: its named RPC entrypoint, which the orders Worker binds to.
 */
import { createWorker } from '@arbol-ai/maximus/workers';

import { app } from './app';

/** The application as a Worker: an RPC entrypoint and a fetch handler. */
const worker = createWorker(app);

/** The named entrypoint the orders Worker binds to; its methods are the `rpc` operations. */
export const PricingService = worker.entrypoint;

export default worker.handler;
