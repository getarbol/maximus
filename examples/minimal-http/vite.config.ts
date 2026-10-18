/**
 * The build `cf` runs: Cloudflare's Vite plugin bundles the Worker and, under `cf dev`, runs it in workerd.
 */
import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig } from 'vite';

export default defineConfig({ plugins: [cloudflare()] });
