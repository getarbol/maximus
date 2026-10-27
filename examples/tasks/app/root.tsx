/** The layout around every page, and what a page that fails shows instead. */
import { Link, Outlet, useRouteError } from 'react-router';

import { RefusalError } from './api.ts';

/** The layout around every page: a heading that leads back to the tasks, above the page. */
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

/**
 * What a page that fails shows: a refusal by its catalog message, and a way back to sign in when the token
 * was refused.
 */
export function ErrorBoundary() {
  const error = useRouteError();
  if (!(error instanceof RefusalError)) {
    return <p role="alert">Something went wrong.</p>;
  }
  const isTokenRefused = error.failure.code === 'UNAUTHORIZED';
  return (
    <p role="alert">
      {error.message} {isTokenRefused ? <Link to="/">Sign in again</Link> : null}
    </p>
  );
}
