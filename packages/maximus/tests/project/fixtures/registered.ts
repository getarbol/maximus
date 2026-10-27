/**
 * The application the handler tests register, as a project's generated code does: a tasks service whose
 * base derives a prefix from its bindings and whose catalog declares two domain failures.
 */
import { defineErrors, maximus, ok, t } from '../../../src/index.ts';

/** The bindings: the prefix every answer starts with, and the development token. */
export interface Env {
  PREFIX: string;
  DEVELOPMENT_TOKEN?: string;
}

export const errors = defineErrors({
  taskNotFound: { code: 'TASK_NOT_FOUND', status: 404, message: 'The task does not exist.' },
  quotaReached: {
    code: 'QUOTA_REACHED',
    status: 429,
    message: 'The task quota is reached.',
    dataSchema: t.Object({ limit: t.Integer() }, { additionalProperties: false }),
  },
});

export const base = maximus<Env>({
  name: 'tasks',
  namespace: 'tasks',
  title: 'Tasks',
  version: '1',
  origin: 'https://tasks.example.test',
  tokens: {
    issuer: 'https://issuer.example.test/',
    audience: 'https://tasks.example.test',
    development: { binding: 'DEVELOPMENT_TOKEN' },
  },
  errors,
  rpc: { callers: ['billing'] },
  telemetry: { enabled: false },
}).derive(async ({ env }) => ok({ prefix: env.PREFIX }));

declare global {
  interface MaximusRegister {
    base: typeof base;
    errors: typeof errors;
    env: Env;
  }
}
