/** Mounts the web app: React Router with the pages of app/routes/, which maximus prepare lists. */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';

import { routes } from '#maximus/app-routes';

const container = document.querySelector('#root');
if (!container) {
  throw new Error('index.html needs an element with the id root.');
}
createRoot(container).render(
  <StrictMode>
    <RouterProvider router={createBrowserRouter(routes)} />
  </StrictMode>
);
