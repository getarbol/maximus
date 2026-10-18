/**
 * The tasks resource's schemas.
 */
import { t, UuidSchema } from '@arbol-ai/maximus';
import type { Static } from '@arbol-ai/maximus';

/** A task is open until it is completed. */
export const TaskStatusSchema = t.Union([t.Literal('open'), t.Literal('done')]);

/** A task as it is stored and answered. */
export const TaskSchema = t.Object(
  {
    taskId: UuidSchema,
    title: t.String({ minLength: 1, maxLength: 200 }),
    status: TaskStatusSchema,
    createdAt: t.String({ format: 'date-time' }),
    completedAt: t.Union([t.String({ format: 'date-time' }), t.Null()]),
  },
  { additionalProperties: false }
);
/** A task as the handlers and the store use it. */
export type Task = Static<typeof TaskSchema>;

/** Lists every task, or only the ones with a status. */
export const ListTasksInputSchema = t.Object(
  { status: t.Optional(TaskStatusSchema) },
  { additionalProperties: false }
);
/** The organization's tasks. */
export const ListTasksOutputSchema = t.Object(
  { tasks: t.Array(TaskSchema) },
  { additionalProperties: false }
);
/** A new task needs only its title; the service sets everything else. */
export const CreateTaskInputSchema = t.Object(
  { title: TaskSchema.properties.title },
  { additionalProperties: false }
);
/** Names one task, by its id in the route. */
export const TaskReferenceSchema = t.Object({ taskId: UuidSchema }, { additionalProperties: false });
/** What a delete answers: the task's id and `deleted: true`. */
export const DeletedTaskSchema = t.Object(
  { taskId: UuidSchema, deleted: t.Literal(true) },
  { additionalProperties: false }
);
