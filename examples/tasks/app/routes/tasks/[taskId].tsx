/** One task: complete it, or delete it. */
import { Form, redirect, useLoaderData } from 'react-router';
import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';

import { completeTask, deleteTask, getTask, isSignedIn } from '../../api.ts';

/** The task the path names; a person who has not signed in is sent to sign in first. */
export async function loader({ params }: LoaderFunctionArgs) {
  if (!isSignedIn()) {
    throw redirect('/');
  }
  const taskId = params.taskId ?? '';
  return await getTask(taskId);
}

/** Deletes the task and returns to the list, or completes it, as the button pressed says. */
export async function action({ params, request }: ActionFunctionArgs) {
  const taskId = params.taskId ?? '';
  const form = await request.formData();
  if (form.get('intent') === 'delete') {
    await deleteTask(taskId);
    return redirect('/tasks');
  }
  await completeTask(taskId);
  return null;
}

/** The task's title and state, a button that completes it while it is open, and one that deletes it. */
export default function Task() {
  const task = useLoaderData<typeof loader>();
  return (
    <article>
      <h2>{task.title}</h2>
      <p>{task.done ? 'Done' : 'Open'}</p>
      <Form method="post">
        {task.done ? null : (
          <button type="submit" name="intent" value="complete">
            Complete
          </button>
        )}
        <button type="submit" name="intent" value="delete">
          Delete
        </button>
      </Form>
    </article>
  );
}
