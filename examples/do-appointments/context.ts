/**
 * What every handler receives besides its input: the schedule of any day of the caller's organization.
 */
import { defineContext } from '@arbol-ai/maximus';

export default defineContext(({ env, principal }) => ({
  /**
   * The organization's schedule for the day: one Durable Object per organization and day, named after both,
   * so a caller reaches only its own organization's.
   */
  schedule: (date: string) => env.SCHEDULES.getByName(`${principal.organizationId}/${date}`),
}));
