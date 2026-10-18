/**
 * The build `cf` runs for orders. Under `cf dev` the pricing Worker runs beside it, so the Service Binding
 * reaches it locally; each Worker builds and deploys from its own directory.
 */
import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig } from 'vite';

import { pricingWorker } from '../pricing/cloudflare.config.ts';

export default defineConfig({
  plugins: [cloudflare({ auxiliaryWorkers: [{ config: pricingWorker, devOnly: true }] })],
});
