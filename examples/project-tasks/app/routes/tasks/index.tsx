/** The organization's tasks, and a form that adds one. */
import { Form, Link, redirect, useLoaderData } from 'react-router';
import type { ActionFunctionArgs } from 'react-router';

import { api, signedIn } from '../../api.ts';

export async function loader() {
  if (!signedIn()) {
    throw redirect('/');
  }
  return await api.getV1Tasks({});
}

export async function action({ request }: ActionFunctionArgs) {
  const title = (await request.formData()).get('title');
  if (typeof title === 'string' && title.trim()) {
    await api.postV1Tasks({ title: title.trim() });
  }
  return null;
}

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
