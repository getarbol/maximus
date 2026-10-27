/** The organization's tasks, and a form that adds one. */
import { Form, Link, redirect, useLoaderData } from 'react-router';
import type { ActionFunctionArgs } from 'react-router';

import { signedIn, tasks } from '../../api.ts';

export async function loader() {
  if (!signedIn()) {
    throw redirect('/');
  }
  return await tasks.list();
}

export async function action({ request }: ActionFunctionArgs) {
  const title = (await request.formData()).get('title');
  if (typeof title === 'string' && title.trim()) {
    await tasks.create({ title: title.trim() });
  }
  return null;
}

export default function Tasks() {
  const { tasks: list } = useLoaderData<typeof loader>();
  return (
    <>
      <ul>
        {list.map((task) => (
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
