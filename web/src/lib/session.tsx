import type { EnvironmentDto, SessionResponseDto, SessionUser, WorkspaceDto } from '@shared/domain';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, type ReactNode } from 'react';
import { get, post, put, setCsrfToken } from './api';

interface SessionValue {
  user: SessionUser;
  /** True when the deployment blocks every Dataverse write (real-tenant certification mode). */
  realTenantReadOnly: boolean;
}

const SessionContext = createContext<SessionValue | null>(null);

export function useSessionQuery() {
  return useQuery({
    queryKey: ['session'],
    queryFn: async () => {
      const s = await get<SessionResponseDto>('/api/auth/session');
      setCsrfToken(s.csrfToken);
      return s.user
        ? { user: s.user, csrfToken: s.csrfToken!, realTenantReadOnly: s.realTenantReadOnly }
        : null;
    },
    retry: false,
    staleTime: 5 * 60_000,
  });
}

/**
 * Signing in as the demo account.
 *
 * Shared rather than duplicated because it is now offered from two places, and the two must agree
 * about what happens afterwards: the session goes into the cache before the navigation so the app
 * does not flash the sign-in screen on the way to the dashboard.
 */
export function useDemoLogin(returnTo = '/') {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => post<{ user: SessionUser; csrfToken: string }>('/api/auth/demo-login'),
    onSuccess: (data) => {
      setCsrfToken(data.csrfToken);
      qc.setQueryData(['session'], data);
      window.location.assign(returnTo);
    },
  });
}

export function SessionProvider({
  user,
  realTenantReadOnly,
  children,
}: {
  user: SessionUser;
  realTenantReadOnly: boolean;
  children: ReactNode;
}) {
  return <SessionContext.Provider value={{ user, realTenantReadOnly }}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession outside SessionProvider');
  return ctx;
}

export function useWorkspace() {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ['workspace'], queryFn: () => get<WorkspaceDto>('/api/workspace') });
  const mutation = useMutation({
    mutationFn: (input: { sourceEnvironmentId: string | null; targetEnvironmentId: string | null }) =>
      put<WorkspaceDto>('/api/workspace', input),
    onSuccess: (data) => qc.setQueryData(['workspace'], data),
  });
  const source: EnvironmentDto | null = query.data?.source ?? null;
  const target: EnvironmentDto | null = query.data?.target ?? null;
  return {
    source,
    target,
    ready: Boolean(source && target),
    isLoading: query.isLoading,
    setWorkspace: mutation.mutateAsync,
    saving: mutation.isPending,
    error: mutation.error,
  };
}
