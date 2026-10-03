import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Spinner } from './components/ui';
import { SessionProvider, useSessionQuery } from './lib/session';
import { AnalysisPage } from './pages/AnalysisPage';
import { ComparePage } from './pages/ComparePage';
import { ComparisonPage } from './pages/ComparisonPage';
import { DashboardPage } from './pages/DashboardPage';
import { DiagnosticsPage } from './pages/DiagnosticsPage';
import { EnvironmentsPage } from './pages/EnvironmentsPage';
import { LandingPage } from './pages/LandingPage';
import { PrivacyPage, TermsPage } from './pages/LegalPage';
import { LoginPage } from './pages/LoginPage';
import { MigrationPage } from './pages/MigrationPage';
import { NewMigrationPage } from './pages/NewMigrationPage';
import { PlanPage } from './pages/PlanPage';
import { PreflightPage } from './pages/PreflightPage';
import { ProjectPage } from './pages/ProjectPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { RunDetailPage } from './pages/RunDetailPage';
import { AuditPage } from './pages/AuditPage';
import { TeamPage } from './pages/TeamPage';
import { RunsPage } from './pages/RunsPage';
import { SettingsPage } from './pages/SettingsPage';
import { UserMappingPage } from './pages/UserMappingPage';
import { ValidationPage } from './pages/ValidationPage';
import { ValidationReportPage } from './pages/ValidationReportPage';

/**
 * The root does double duty: the product for anyone signed in, and the public landing page for
 * everyone else.
 *
 * Deliberately not a separate `/app` prefix. Moving every screen's URL to make room for a marketing
 * page would break every link anybody has already shared, and the only thing that actually differs
 * is what `/` shows. Any deeper path still redirects to sign-in, carrying where it was going.
 */
function Protected() {
  const session = useSessionQuery();
  const location = useLocation();
  if (session.isLoading) return <Spinner label="Loading session…" />;
  if (!session.data) {
    if (location.pathname === '/') return <LandingPage />;
    return (
      <Navigate to={`/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`} replace />
    );
  }
  return (
    <SessionProvider user={session.data.user} realTenantReadOnly={session.data.realTenantReadOnly}>
      <Layout />
    </SessionProvider>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      {/* Public, whether or not anyone is signed in: a privacy notice behind a login is no notice. */}
      <Route path="/privacy" element={<PrivacyPage />} />
      <Route path="/terms" element={<TermsPage />} />
      <Route element={<Protected />}>
        <Route index element={<DashboardPage />} />
        <Route path="projects" element={<ProjectsPage />} />
        <Route path="projects/:projectId" element={<ProjectPage />} />
        <Route path="analyses/:analysisId" element={<AnalysisPage />} />
        <Route path="data-comparisons/:comparisonId" element={<ComparisonPage />} />
        <Route path="environments" element={<EnvironmentsPage />} />
        <Route path="compare" element={<ComparePage />} />
        <Route path="compare/:comparisonId" element={<ComparePage />} />
        <Route path="users" element={<UserMappingPage />} />
        <Route path="migration" element={<MigrationPage />} />
        <Route path="migration/new" element={<NewMigrationPage />} />
        <Route path="migration/plans/:planId" element={<PlanPage />} />
        <Route path="migration/plans/:planId/preflight" element={<PreflightPage />} />
        <Route path="diagnostics" element={<DiagnosticsPage />} />
        {/*
          Step one of the information-architecture recommendation: Audit and Team become destinations, and
          nothing else moves. Every existing route still works, so no link anybody has saved is broken.
        */}
        <Route path="team" element={<TeamPage />} />
        <Route path="audit" element={<AuditPage />} />
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
