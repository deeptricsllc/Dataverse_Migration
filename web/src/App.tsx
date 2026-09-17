import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Spinner } from './components/ui';
import { SessionProvider, useSessionQuery } from './lib/session';
import { ComparePage } from './pages/ComparePage';
import { DashboardPage } from './pages/DashboardPage';
import { EnvironmentsPage } from './pages/EnvironmentsPage';
import { LoginPage } from './pages/LoginPage';
import { MigrationPage } from './pages/MigrationPage';
import { NewMigrationPage } from './pages/NewMigrationPage';
import { PlanPage } from './pages/PlanPage';
import { RunDetailPage } from './pages/RunDetailPage';
import { RunsPage } from './pages/RunsPage';
import { SettingsPage } from './pages/SettingsPage';
import { UserMappingPage } from './pages/UserMappingPage';
import { ValidationPage } from './pages/ValidationPage';
import { ValidationReportPage } from './pages/ValidationReportPage';

function Protected() {
  const session = useSessionQuery();
  const location = useLocation();
  if (session.isLoading) return <Spinner label="Loading session…" />;
  if (!session.data) {
    return (
      <Navigate to={`/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`} replace />
    );
  }
  return (
    <SessionProvider user={session.data.user}>
      <Layout />
    </SessionProvider>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<Protected />}>
        <Route index element={<DashboardPage />} />
        <Route path="environments" element={<EnvironmentsPage />} />
        <Route path="compare" element={<ComparePage />} />
        <Route path="compare/:comparisonId" element={<ComparePage />} />
        <Route path="users" element={<UserMappingPage />} />
        <Route path="migration" element={<MigrationPage />} />
        <Route path="migration/new" element={<NewMigrationPage />} />
        <Route path="migration/plans/:planId" element={<PlanPage />} />
        <Route path="runs" element={<RunsPage />} />
        <Route path="runs/:runId" element={<RunDetailPage />} />
        <Route path="validation" element={<ValidationPage />} />
        <Route path="validation/:validationId" element={<ValidationReportPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
