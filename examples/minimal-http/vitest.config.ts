/**
 * The tests run in Node against the HTTP handler, so they leave out `vite.config.ts`, the Worker's build.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { include: ['tests/**/*.test.ts'] } });
