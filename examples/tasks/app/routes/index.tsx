/** Sign in with a bearer token: in development, the DEVELOPMENT_TOKEN in .dev.vars. */
import { Form, redirect } from 'react-router';
import type { ActionFunctionArgs } from 'react-router';

import { signIn } from '../api.ts';

/** Keeps the token the form sends and opens the tasks; a form without a token stays on this page. */
export async function action({ request }: ActionFunctionArgs) {
  const form = await request.formData();
  const token = form.get('token');
  if (typeof token !== 'string' || token === '') {
    return null;
  }
  signIn(token);
  return redirect('/tasks');
}

/** The sign-in form. */
export default function SignIn() {
  return (
    <Form method="post">
      <label>
        Token <input name="token" type="password" autoComplete="off" required />
      </label>
      <button type="submit">Sign in</button>
    </Form>
  );
}
