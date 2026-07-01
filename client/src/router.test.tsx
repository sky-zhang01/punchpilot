import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AppRouter from './router';

const mockDispatch = vi.fn();

const unauthenticatedState = {
  auth: {
    authenticated: false,
    checked: true,
    username: '',
    mustChangePassword: false,
    loading: false,
  },
  config: {},
  status: {},
  attendance: {},
};

vi.mock('./store/hooks', () => ({
  useAppDispatch: () => mockDispatch,
  useAppSelector: (selector: (state: typeof unauthenticatedState) => unknown) =>
    selector(unauthenticatedState),
}));

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location">{location.pathname}</span>;
}

describe('AppRouter', () => {
  beforeEach(() => {
    vi.stubGlobal('__APP_VERSION__', '0.4.14');
    mockDispatch.mockReset();
  });

  it('redirects unauthenticated users away from protected routes', async () => {
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <AppRouter />
        <LocationProbe />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByTestId('location').textContent).toBe('/login');
    });
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});
