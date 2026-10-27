/** The layout around every page, and what a page that fails shows instead. */
import { Link, Outlet, useRouteError } from 'react-router';

import { RefusalError } from './api.ts';

export default function Root() {
  return (
    <main>
      <h1>
        <Link to="/tasks">Tasks</Link>
      </h1>
      <Outlet />
    </main>
  );
}

/** A refusal by its catalog message, and a way back to sign in when the token is not accepted. */
export function ErrorBoundary() {
  const error = useRouteError();
  if (!(error instanceof RefusalError)) {
    return <p role="alert">Something went wrong.</p>;
  }
  return (
    <p role="alert">
      {error.message} {error.failure.code === 'UNAUTHORIZED' ? <Link to="/">Sign in again</Link> : null}
    </p>
  );
}
