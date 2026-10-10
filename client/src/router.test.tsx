import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AppRouter from './router';

const mockDispatch = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({
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
}));

vi.mock('./store/hooks', () => ({
  useAppDispatch: () => mockDispatch,
  useAppSelector: (selector: (value: typeof state) => unknown) => selector(state),
}));
vi.mock('./store/authSlice', () => ({
  checkAuthStatus: () => ({ type: 'auth/checkStatus' }),
}));

vi.mock('./pages/LoginPage', () => ({ default: () => <div>login-page</div> }));
vi.mock('./pages/ForcePasswordChangePage', () => ({
  default: () => <div>change-password-page</div>,
}));
vi.mock('./pages/DashboardPage', () => ({ default: () => <div>dashboard-page</div> }));
vi.mock('./pages/SettingsPage', () => ({ default: () => <div>settings-page</div> }));
vi.mock('./pages/LogsPage', () => ({ default: () => <div>logs-page</div> }));
vi.mock('./pages/CalendarPage', () => ({ default: () => <div>calendar-page</div> }));
vi.mock('./pages/UserProfilePage', () => ({ default: () => <div>profile-page</div> }));
vi.mock('./components/layout/AppLayout', async () => {
  const { Outlet } = await import('react-router');
  return { default: () => <main><span>app-layout</span><Outlet /></main> };
});

function renderRouter(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppRouter />
    </MemoryRouter>,
  );
}

describe('AppRouter', () => {
  beforeEach(() => {
    vi.stubGlobal('__APP_VERSION__', '0.5.0');
    mockDispatch.mockReset();
    mockDispatch.mockResolvedValue(undefined);
    Object.assign(state.auth, {
      authenticated: false,
      checked: true,
      username: '',
      mustChangePassword: false,
      loading: false,
    });
  });

  it('redirects unauthenticated users away from protected routes', async () => {
    renderRouter('/dashboard');

    expect(await screen.findByText('login-page')).toBeTruthy();
    expect(screen.queryByText('dashboard-page')).toBeNull();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('uses the real index route for an authenticated user', async () => {
    state.auth.authenticated = true;
    renderRouter('/');

    expect(await screen.findByText('dashboard-page')).toBeTruthy();
    expect(screen.getByText('app-layout')).toBeTruthy();
  });

  it('forces password change before rendering a protected page', async () => {
    state.auth.authenticated = true;
    state.auth.mustChangePassword = true;
    renderRouter('/settings');

    expect(await screen.findByText('change-password-page')).toBeTruthy();
    expect(screen.queryByText('settings-page')).toBeNull();
  });

  it('keeps the legacy holidays redirect on the real route tree', async () => {
    state.auth.authenticated = true;
    renderRouter('/holidays');

    expect(await screen.findByText('calendar-page')).toBeTruthy();
  });

  it('routes unknown paths through the protected dashboard fallback', async () => {
    state.auth.authenticated = true;
    renderRouter('/unknown-path');

    expect(await screen.findByText('dashboard-page')).toBeTruthy();
  });
});
