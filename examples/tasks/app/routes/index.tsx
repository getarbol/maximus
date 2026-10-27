/** Sign in with a bearer token: in development, the DEVELOPMENT_TOKEN in .dev.vars. */
import { Form, redirect } from 'react-router';
import type { ActionFunctionArgs } from 'react-router';

import { signIn } from '../api.ts';

export async function action({ request }: ActionFunctionArgs) {
  const token = (await request.formData()).get('token');
  if (typeof token !== 'string' || !token) {
    return null;
  }
  signIn(token);
  return redirect('/tasks');
}

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
