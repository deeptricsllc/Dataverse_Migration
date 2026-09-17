import type { AuthConfigDto, SessionUser } from '@shared/domain';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Boxes, FlaskConical } from 'lucide-react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { Callout, ErrorState, Spinner } from '../components/ui';
import { get, post, setCsrfToken } from '../lib/api';
import { useSessionQuery } from '../lib/session';

function MicrosoftLogo() {
  return (
    <svg viewBox="0 0 21 21" className="h-5 w-5" aria-hidden>
      <rect x="1" y="1" width="9" height="9" fill="#f25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
      <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
      <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
    </svg>
  );
}

const safeReturnTo = (v: string | null) => (v && v.startsWith('/') && !v.startsWith('//') ? v : '/');

export function LoginPage() {
  const [params] = useSearchParams();
  const returnTo = safeReturnTo(params.get('returnTo'));
  const error = params.get('error');
  const session = useSessionQuery();
  const qc = useQueryClient();
  const config = useQuery({ queryKey: ['auth-config'], queryFn: () => get<AuthConfigDto>('/api/auth/config') });
  const demo = useMutation({
    mutationFn: () => post<{ user: SessionUser; csrfToken: string }>('/api/auth/demo-login'),
    onSuccess: (data) => {
      setCsrfToken(data.csrfToken);
      qc.setQueryData(['session'], data);
      window.location.assign(returnTo);
    },
  });

  if (session.data) return <Navigate to={returnTo} replace />;

  return (
    <div className="flex min-h-full items-center justify-center bg-gradient-to-br from-slate-900 via-slate-900 to-brand-900 px-4 py-12">
      <div className="w-full max-w-md">
        <div className="mb-8 flex items-center justify-center gap-3 text-white">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-600">
            <Boxes className="h-6 w-6" aria-hidden />
          </div>
          <div>
            <div className="text-lg font-semibold leading-tight">Dataverse Migration Platform</div>
            <div className="text-sm text-slate-400">by DeepTrics</div>
          </div>
        </div>
        <div className="rounded-2xl bg-white p-8 shadow-2xl">
          <h1 className="text-xl font-semibold text-slate-900">Sign in</h1>
          <p className="mt-1 text-sm text-slate-500">
            Discover, compare, migrate and validate Microsoft Dataverse environments with your organizational account.
          </p>
          <div className="mt-6 space-y-3">
            {error && <Callout tone="danger" title="Sign-in failed">{error}</Callout>}
            {config.isLoading && <Spinner />}
            {config.error && <ErrorState error={config.error} onRetry={() => config.refetch()} />}
            {config.data && (
              <>
                {config.data.microsoftEnabled ? (
                  <a
                    href={`/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`}
                    className="flex w-full items-center justify-center gap-3 rounded-md border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-800 shadow-sm hover:bg-slate-50"
                  >
                    <MicrosoftLogo /> Continue with Microsoft
                  </a>
                ) : (
                  <Callout tone="info" title="Microsoft sign-in is not configured">
                    Set <code>ENTRA_CLIENT_ID</code> and <code>ENTRA_CLIENT_SECRET</code> (see README → Microsoft Entra setup) to enable “Continue with Microsoft”.
                  </Callout>
                )}
                {config.data.demoEnabled && (
                  <>
                    <div className="flex items-center gap-3 py-1 text-xs text-slate-400">
                      <span className="h-px flex-1 bg-slate-200" /> or <span className="h-px flex-1 bg-slate-200" />
                    </div>
                    <button
                      type="button"
                      onClick={() => demo.mutate()}
                      disabled={demo.isPending}
                      className="flex w-full items-center justify-center gap-2 rounded-md bg-amber-400 px-4 py-2.5 text-sm font-semibold text-amber-950 shadow-sm hover:bg-amber-300 disabled:opacity-60"
                    >
                      <FlaskConical className="h-4 w-4" aria-hidden />
                      {demo.isPending ? 'Preparing demo environments…' : 'Continue with demo account'}
                    </button>
                    <p className="text-center text-xs text-slate-500">
                      DEMO MODE uses simulated Dataverse environments. No Microsoft tenant data is accessed.
                    </p>
                    {demo.error && <ErrorState error={demo.error} />}
                  </>
                )}
              </>
            )}
          </div>
        </div>
        <p className="mt-6 text-center text-xs text-slate-400">
          Access tokens stay on the server. Your Dataverse password is never requested or stored.
        </p>
      </div>
    </div>
  );
}
