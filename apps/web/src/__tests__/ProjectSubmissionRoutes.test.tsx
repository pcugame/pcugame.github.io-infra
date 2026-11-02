/* @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { routes } from '../app/router';

vi.mock('../features/auth/useMe', () => ({
  useMe: () => ({ isAuthenticated: true, isLoading: false, user: { id: 9, role: 'ADMIN' } }),
}));

afterEach(cleanup);

it.each(['user', 'admin'] as const)('redirects the legacy %s submission URL to Studio and replaces history', async mode => {
  const prefix = mode === 'user' ? '/me' : '/admin';
  const path = `${prefix}/projects/new`;
  const children = routes[0]!.children!;
  const legacy = mode === 'user'
    ? children.find(route => route.path === path)!
    : children.find(route => route.path === '/admin')!.children!.find(route => route.path === 'projects/new')!;
  // Render the actual guarded lazy route, isolating only the surrounding layouts and destination.
  const router = createMemoryRouter([
    { path: '/before', element: <p>Previous page</p> },
    { ...legacy, path },
    { path: `${path}/studio`, element: <p>Studio destination</p> },
  ], { initialEntries: ['/before', path] });
  const view = render(<RouterProvider router={router} />);
  try {
    await screen.findByText('Studio destination');
    expect(router.state.location.pathname).toBe(`${path}/studio`);
    expect(router.state.historyAction).toBe('REPLACE');
    await act(async () => { await router.navigate(-1); });
    await waitFor(() => expect(router.state.location.pathname).toBe('/before'));
  } finally {
    view.unmount();
    router.dispose();
  }
});
