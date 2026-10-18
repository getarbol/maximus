/**
 * The type of the `@arbol-ai/maximus/oxfmt` preset.
 */
import type { defineConfig } from 'oxfmt';

/** The Maximus oxfmt preset; its `ignorePatterns` are always present, to extend them. */
declare const config: ReturnType<typeof defineConfig> & { ignorePatterns: string[] };
export default config;
