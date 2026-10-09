import type { AuthConfigDto } from '@shared/domain';
import { PRODUCT_NAME } from '@shared/product';
import { signInFailureMessage } from '@shared/sign-in-failures';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Boxes, Check, FlaskConical, Lock } from 'lucide-react';
import { useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { Callout, ErrorState, Spinner } from '../components/ui';
import { get } from '../lib/api';
import { useDemoLogin, useSessionQuery } from '../lib/session';

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

const POINTS = [
  'Profile any source down to the column, before deciding anything',
  'A dry run that classifies every record and writes nothing',
  'Proof of what happened afterwards, compared independently',
];

export function LoginPage() {
  const [params] = useSearchParams();
  const returnTo = safeReturnTo(params.get('returnTo'));
  // A code, never a sentence: the page decides the wording, so a crafted link cannot put words
  // under our “Sign-in failed” heading.
  const errorCode = params.get('error');
  const session = useSessionQuery();
  const config = useQuery({
    queryKey: ['auth-config'],
    queryFn: () => get<AuthConfigDto>('/api/auth/config'),
  });
  const demo = useDemoLogin(returnTo);
  const [name, setName] = useState('');

  if (session.data) return <Navigate to={returnTo} replace />;

  return (
    <div className="grid min-h-full lg:grid-cols-[1.1fr_1fr]">
      {/* The half that says what this is, for anyone who arrived at a deep link ------ */}
      <div className="relative hidden flex-col justify-between overflow-hidden bg-gradient-to-br from-slate-950 via-slate-900 to-brand-900 p-12 lg:flex">
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-32 -left-24 h-96 w-96 rounded-full bg-brand-600/20 blur-3xl"
        />
        <Link to="/" className="relative flex items-center gap-3 text-white">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-600">
            <Boxes className="h-6 w-6" aria-hidden />
          </div>
          <div>
            <div className="text-lg font-semibold leading-tight">{PRODUCT_NAME}</div>
            <div className="text-sm text-slate-400">by DeepTrics</div>
          </div>
        </Link>
        <div className="relative max-w-md">
          <h2 className="text-3xl font-bold leading-tight tracking-tight text-white">
            Know exactly what a migration will do, before it does it.
          </h2>
          <ul className="mt-8 space-y-3 text-sm text-slate-300">
            {POINTS.map((p) => (
              <li key={p} className="flex gap-3">
                <Check className="mt-0.5 h-4 w-4 flex-none text-emerald-400" aria-hidden />
                {p}
              </li>
            ))}
          </ul>
        </div>
        <Link
          to="/"
          className="relative inline-flex items-center gap-2 text-sm font-medium text-slate-400 hover:text-white"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Back to the product overview
        </Link>
      </div>

      {/* The half that signs you in ------------------------------------------------- */}
      <div className="flex items-center justify-center bg-slate-50 px-4 py-12">
        <div className="w-full max-w-md">
          <Link to="/" className="mb-8 flex items-center justify-center gap-3 lg:hidden">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-600">
              <Boxes className="h-5 w-5 text-white" aria-hidden />
            </div>
            <div>
              <div className="font-semibold leading-tight text-slate-900">{PRODUCT_NAME}</div>
              <div className="text-xs text-slate-500">by DeepTrics</div>
            </div>
          </Link>

          <div className="rounded-2xl border border-slate-200 bg-white p-8 shadow-xl shadow-slate-200/60">
            <h1 className="text-xl font-semibold text-slate-900">Sign in</h1>
            <p className="mt-1 text-sm text-slate-500">
              Analyse, map, migrate and validate with your organizational account.
            </p>
            <div className="mt-6 space-y-3">
              {errorCode && (
                <Callout tone="danger" title="Sign-in failed">
                  {signInFailureMessage(errorCode)}
                </Callout>
              )}
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
                    <Callout tone="info" title="Microsoft sign-in isn’t enabled here">
                      This environment doesn’t have Microsoft sign-in turned on yet. Use the demo workspace
                      below to see the whole product, or request access and we’ll set your organization up.
                    </Callout>
                  )}
                  {config.data.demoEnabled && (
                    <>
                      <div className="flex items-center gap-3 py-1 text-xs text-slate-400">
                        <span className="h-px flex-1 bg-slate-200" /> or{' '}
                        <span className="h-px flex-1 bg-slate-200" />
                      </div>
                      <div>
                        <label
                          className="mb-1.5 block text-xs font-medium text-slate-600"
                          htmlFor="demo-name"
                        >
                          Your name{' '}
                          <span className="font-normal text-slate-400">
                            (only if you are testing with a team)
                          </span>
                        </label>
                        <input
                          id="demo-name"
                          value={name}
                          data-testid="demo-name"
                          onChange={(e) => setName(e.target.value)}
                          placeholder="Priya Raman"
                          autoComplete="name"
                          className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                        />
                        {/*
                          The field decides which of the two demo workspaces this is, so it says so
                          rather than leaving somebody to discover it. A prospect evaluating alone
                          should leave it blank and get a workspace nobody else is in.
                        */}
                        <p className="mt-1 text-xs text-slate-500">
                          {name.trim()
                            ? 'You will join the shared team workspace, where everyone testing together sees the same projects and the audit trail says who did what.'
                            : 'Leave this blank and you get a private workspace of your own, with nothing in it but the worked examples. Add a name only to join a team already testing together.'}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => demo.mutate(name.trim() || undefined)}
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

          {/* What "sign up" means here, stated rather than implied. There is no password
              account to create: a workspace appears on the first sign-in from a tenant. */}
          <div className="mt-5 rounded-xl border border-slate-200 bg-white/60 p-5 text-sm">
            <h2 className="font-semibold text-slate-900">New here?</h2>
            {config.data?.signUpEnabled ? (
              <p className="mt-1.5 leading-relaxed text-slate-600">
                There is nothing separate to create. Signing in with a Microsoft work account sets up your
                workspace the first time somebody from your tenant arrives, and that first person becomes its
                administrator. Everyone after them joins the same workspace.
              </p>
            ) : (
              <p className="mt-1.5 leading-relaxed text-slate-600">
                This deployment only accepts tenants that have been enabled for it.{' '}
                {/* A full navigation, not a client-side one: the browser scrolls to the anchor. */}
                <a href="/#request" className="font-medium text-brand-700 hover:text-brand-800">
                  Request access
                </a>{' '}
                and we will set yours up.
              </p>
            )}
            {config.data?.demoEnabled && (
              <p className="mt-3 leading-relaxed text-slate-600">
                Not ready to involve your IT team? The demo account is the whole product on simulated data,
                and needs nothing from your tenant at all.
              </p>
            )}
          </div>

          <p className="mt-6 flex items-center justify-center gap-2 text-center text-xs text-slate-400">
            <Lock className="h-3.5 w-3.5 flex-none" aria-hidden />
            Access tokens stay on the server. Your Dataverse password is never requested or stored.
          </p>
        </div>
      </div>
    </div>
  );
}
