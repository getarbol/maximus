/** One task: complete it, or delete it. */
import { Form, redirect, useLoaderData } from 'react-router';
import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';

import { api, signedIn } from '../../api.ts';

export async function loader({ params }: LoaderFunctionArgs) {
  if (!signedIn()) {
    throw redirect('/');
  }
  return await api.getV1TasksTaskId({ taskId: params.taskId ?? '' });
}

export async function action({ params, request }: ActionFunctionArgs) {
  const taskId = params.taskId ?? '';
  if ((await request.formData()).get('intent') === 'delete') {
    await api.deleteV1TasksTaskId({ taskId });
    return redirect('/tasks');
  }
  await api.postV1TasksTaskIdComplete({ taskId });
  return null;
}

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
