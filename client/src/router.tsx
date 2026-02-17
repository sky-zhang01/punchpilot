import React, { Suspense, useEffect, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router';
import { useAppSelector, useAppDispatch } from './store/hooks';
import { checkAuthStatus } from './store/authSlice';
import { Spin } from 'antd';

// Lazy-loaded pages
const LoginPage = React.lazy(() => import('./pages/LoginPage'));
const ForcePasswordChangePage = React.lazy(() => import('./pages/ForcePasswordChangePage'));
const AppLayout = React.lazy(() => import('./components/layout/AppLayout'));
const DashboardPage = React.lazy(() => import('./pages/DashboardPage'));
const SettingsPage = React.lazy(() => import('./pages/SettingsPage'));
const LogsPage = React.lazy(() => import('./pages/LogsPage'));
const CalendarPage = React.lazy(() => import('./pages/CalendarPage'));
const UserProfilePage = React.lazy(() => import('./pages/UserProfilePage'));

// Loading fallback using antd Spin
const LoadingFallback: React.FC = () => (
  <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh' }}>
    <Spin size="large" />
  </div>
);

// Auth guard component
const AuthGuard: React.FC<{ children: React.ReactNode; allowMustChange?: boolean }> = ({
  children,
  allowMustChange = false,
}) => {
  const dispatch = useAppDispatch();
  const { authenticated, checked, mustChangePassword } = useAppSelector((state) => state.auth);
  const [loading, setLoading] = useState(!checked);

  useEffect(() => {
    if (!checked) {
      dispatch(checkAuthStatus()).finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, [checked, dispatch]);

  if (loading) {
    return <LoadingFallback />;
  }

  if (!authenticated) {
    return <Navigate to="/login" replace />;
  }

  if (mustChangePassword && !allowMustChange) {
    return <Navigate to="/change-password" replace />;
  }

  return <>{children}</>;
};

const AppRouter: React.FC = () => {
  return (
    <Suspense fallback={<LoadingFallback />}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/change-password"
          element={
            <AuthGuard allowMustChange>
              <ForcePasswordChangePage />
            </AuthGuard>
          }
        />
        <Route
          path="/"
          element={
            <AuthGuard>
              <AppLayout />
            </AuthGuard>
          }
        >
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard" element={<DashboardPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="logs" element={<LogsPage />} />
          <Route path="calendar" element={<CalendarPage />} />
          {/* Redirect old /holidays route to /calendar */}
          <Route path="holidays" element={<Navigate to="/calendar" replace />} />
          <Route path="profile" element={<UserProfilePage />} />
        </Route>
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </Suspense>
  );
};

export default AppRouter;
