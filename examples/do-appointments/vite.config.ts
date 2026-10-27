/**
 * The only configuration: the appointments service, its Worker, and the Durable Object class that keeps each
 * day's schedule, which the Worker exports and binds itself.
 */
import { maximus } from '@arbol-ai/maximus/vite';
import { bindings, exports } from 'cf/config';
import { defineConfig } from 'vite-plus';

/** The Worker's name, which its binding to its own Durable Object class names. */
const NAME = 'example-do-appointments';

export default defineConfig({
  plugins: [
    maximus({
      name: NAME,
      namespace: 'appointments',
      title: 'Appointments',
      description:
        'Books appointments in the slots of a day, whose schedule one Durable Object per organization and day keeps.',
      groups: {
        Days: "Each day's slots and the bookings that hold them.",
      },
      // The Worker's workers.dev URL in the account it deploys to.
      origin: `https://${NAME}.${process.env.WORKERS_SUBDOMAIN ?? 'example'}.workers.dev`,
      tokens: { issuer: 'https://auth.example.com/' },
      compatibilityDate: '2026-10-26',
      // durable-objects/day-schedule.ts, exported as DaySchedule, keeps its bookings in SQLite. Its name is its
      // storage's: renaming or removing it is a migration, declared here.
      exports: { DaySchedule: exports.durableObject({ storage: 'sqlite' }) },
      env: { SCHEDULES: bindings.durableObject({ worker: NAME, exportName: 'DaySchedule' }) },
    }),
  ],
});
