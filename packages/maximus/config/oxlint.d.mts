/**
 * The type of the `@arbol-ai/maximus/oxlint` preset.
 */
import type { defineConfig } from 'oxlint';

/** The Maximus oxlint preset; its `ignorePatterns` are always present, to repeat them when extending. */
declare const config: ReturnType<typeof defineConfig> & { ignorePatterns: string[] };
export default config;
