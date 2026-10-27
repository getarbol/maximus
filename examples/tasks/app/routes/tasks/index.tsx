/** The organization's tasks, and a form that adds one. */
import { Form, Link, redirect, useLoaderData } from 'react-router';
import type { ActionFunctionArgs } from 'react-router';

import { createTask, isSignedIn, listTasks } from '../../api.ts';

/** The organization's tasks; a person who has not signed in is sent to sign in first. */
export async function loader() {
  if (!isSignedIn()) {
    throw redirect('/');
  }
  return await listTasks();
}

/** Adds a task with the title the form sends, trimmed; a blank title adds nothing. */
export async function action({ request }: ActionFunctionArgs) {
  const form = await request.formData();
  const title = form.get('title');
  if (typeof title !== 'string') {
    return null;
  }
  const trimmedTitle = title.trim();
  if (trimmedTitle === '') {
    return null;
  }
  await createTask({ title: trimmedTitle });
  return null;
}

/** Each task as a link to its own page, done ones struck through, and the form that adds a task. */
export default function Tasks() {
  const { tasks } = useLoaderData<typeof loader>();
  return (
    <>
      <ul>
        {tasks.map((task) => (
          <li key={task.taskId}>
            <Link to={`/tasks/${task.taskId}`}>{task.done ? <s>{task.title}</s> : task.title}</Link>
          </li>
        ))}
      </ul>
      <Form method="post">
        <input name="title" aria-label="New task" maxLength={200} required />
        <button type="submit">Add</button>
      </Form>
    </>
  );
}
