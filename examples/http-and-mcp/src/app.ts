/**
 * The tasks application with its resource modules mounted.
 */
import { tasks } from './api/tasks/operations';
import { base } from './application';

/** Every resource module, composed once. */
export const app = base.mount(tasks).build();
