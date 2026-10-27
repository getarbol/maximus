/**
 * Maximus reconciles routes/ and mcp/ into .maximus/ before Cloudflare's Vite plugin bundles the Worker.
 */
import { maximusProject } from '@arbol-ai/maximus/vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig } from 'vite-plus';

export default defineConfig({ plugins: [maximusProject(), cloudflare()] });
