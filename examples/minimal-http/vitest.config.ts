/**
 * The tests run in Node against the HTTP handler, so they leave out `vite.config.ts`, the Worker's build.
 */
import { defineConfig } from 'vite-plus/test/config';

export default defineConfig({ test: { include: ['tests/**/*.test.ts'] } });
