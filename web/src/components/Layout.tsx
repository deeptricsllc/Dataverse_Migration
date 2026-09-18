import { CONNECTION_TYPE_LABELS, type ConnectionType } from '@shared/domain';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowRight,
  Boxes,
  ChevronDown,
  Database,
  GitCompareArrows,
  History,
  LayoutDashboard,
  Lock,
  LogOut,
  Settings,
  ShieldCheck,
  Stethoscope,
  Truck,
  Users,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { post, setCsrfToken } from '../lib/api';
import { useSession, useWorkspace } from '../lib/session';
import { cx } from './ui';

const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/environments', label: 'Connections', icon: Database },
  { to: '/compare', label: 'Compare', icon: GitCompareArrows },
  { to: '/users', label: 'User mapping', icon: Users },
  { to: '/migration', label: 'Migration', icon: Truck },
  { to: '/validation', label: 'Validation', icon: ShieldCheck },
  { to: '/runs', label: 'Runs', icon: History },
  { to: '/diagnostics', label: 'Diagnostics', icon: Stethoscope },
  { to: '/settings', label: 'Settings', icon: Settings },
];

function UserMenu() {
  const { user } = useSession();
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  const logout = useMutation({
    mutationFn: () => post<{ logoutUrl: string | null }>('/api/auth/logout'),
    onSettled: (data) => {
      setCsrfToken(null);
      qc.clear();
      window.location.assign(data?.logoutUrl ?? '/login');
    },
  });
  const initials = user.displayName
    .split(/\s+/)
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-slate-100"
      >
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-700 text-xs font-semibold text-white">
          {initials}
        </span>
        <span className="hidden sm:block">
          <span className="block text-sm font-medium leading-tight text-slate-900">{user.displayName}</span>
          <span className="block text-xs leading-tight text-slate-500">{user.organization.name}</span>
        </span>
        <ChevronDown className="h-4 w-4 text-slate-400" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-40 mt-2 w-64 rounded-lg border border-slate-200 bg-white p-1.5 shadow-lg"
        >
          <div className="px-3 py-2">
            <p className="text-sm font-medium text-slate-900">{user.displayName}</p>
            <p className="truncate text-xs text-slate-500">{user.email}</p>
            <p className="mt-1 text-xs text-slate-500">
              {user.organization.name} · {user.role === 'ADMIN' ? 'Administrator' : 'Member'} ·{' '}
              {user.authProvider === 'demo' ? 'Demo sign-in' : 'Microsoft'}
            </p>
          </div>
          <div className="my-1 border-t border-slate-100" />
          <Link
            role="menuitem"
            to="/settings"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 rounded px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
          >
            <Settings className="h-4 w-4" /> Settings
          </Link>
          <button
            role="menuitem"
            type="button"
            onClick={() => logout.mutate()}
            className="flex w-full items-center gap-2 rounded px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
          >
            <LogOut className="h-4 w-4" /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}

function EnvCard({
  role,
  env,
}: {
  role: 'SOURCE' | 'TARGET';
  env: { displayName: string; url: string; connectionType?: ConnectionType } | null;
}) {
  const isSource = role === 'SOURCE';
  return (
    <div
      className={cx(
        'min-w-0 flex-1 rounded-md border-l-4 bg-white px-3 py-1.5',
        isSource ? 'border-l-[var(--color-source)]' : 'border-l-[var(--color-target)]',
      )}
      data-testid={`workspace-${role.toLowerCase()}`}
    >
      <div
        className={cx(
          'text-[10px] font-bold tracking-widest',
          isSource ? 'text-[var(--color-source)]' : 'text-[var(--color-target)]',
        )}
      >
        {role}
      </div>
      {env ? (
        <>
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-semibold text-slate-900">{env.displayName}</span>
            <span className="whitespace-nowrap rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">
              {CONNECTION_TYPE_LABELS[env.connectionType ?? 'DATAVERSE']}
            </span>
          </div>
          <div className="truncate font-mono text-[11px] text-slate-500">{env.url}</div>
        </>
      ) : (
        <div className="text-sm text-slate-400">Not selected</div>
      )}
    </div>
  );
}

export function WorkspaceHeader() {
  const { source, target, isLoading } = useWorkspace();
  if (isLoading) return <div className="h-[58px]" />;
  return (
    <div className="flex items-center gap-3" aria-label="Migration workspace">
      <EnvCard role="SOURCE" env={source} />
      <ArrowRight className="h-5 w-5 flex-none text-slate-400" aria-label="migrates to" />
      <EnvCard role="TARGET" env={target} />
      <Link
        to="/environments"
        className="flex-none whitespace-nowrap rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50"
      >
        Change Environments
      </Link>
    </div>
  );
}

export function Layout() {
  const { user, realTenantReadOnly } = useSession();
  const location = useLocation();
  const showWorkspace = !['/', '/settings'].includes(location.pathname);
  return (
    <div className="flex h-full">
      <aside className="hidden w-60 flex-none flex-col border-r border-slate-200 bg-slate-900 text-slate-300 md:flex">
        <div className="flex items-center gap-2.5 px-5 py-4">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600">
            <Boxes className="h-4.5 w-4.5 text-white" aria-hidden />
          </div>
          <div>
            <div className="text-sm font-semibold leading-tight text-white">DeepTrics</div>
            <div className="text-[11px] leading-tight text-slate-400">Dataverse Migration</div>
          </div>
        </div>
        <nav className="mt-2 flex-1 space-y-0.5 px-3" aria-label="Main">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cx(
                  'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                  isActive ? 'bg-slate-800 text-white' : 'hover:bg-slate-800/60 hover:text-white',
                )
              }
            >
              <Icon className="h-4 w-4" aria-hidden />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="px-5 py-4 text-[11px] leading-relaxed text-slate-500">
          Know what will happen before migration. Migrate safely. Know exactly what happened afterward.
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Demo organizations use simulated environments, which the read-only switch does not
            block, so the banner would be misleading there. */}
        {realTenantReadOnly && !user.organization.isDemo && (
          <div
            className="flex items-center justify-center gap-2 bg-sky-800 px-4 py-1 text-center text-xs font-semibold text-white"
            role="note"
            data-testid="read-only-banner"
          >
            <Lock className="h-3.5 w-3.5" aria-hidden />
            REAL TENANT — READ ONLY. Dataverse reads are allowed; every write is blocked by the server.
          </div>
        )}
        {user.organization.isDemo && (
          <div
            className="bg-amber-400 px-4 py-1 text-center text-xs font-semibold text-amber-950"
            role="note"
            data-testid="demo-banner"
          >
            DEMO MODE — simulated Dataverse environments. No Microsoft tenant is connected and no real data is
            read or written.
          </div>
        )}
        <header className="flex items-center justify-between gap-4 border-b border-slate-200 bg-white px-6 py-2.5">
          <div className="flex items-center gap-3">
            <span className="text-sm font-semibold text-slate-900">Dataverse Migration Platform</span>
            {realTenantReadOnly && !user.organization.isDemo && (
              <span className="rounded bg-sky-100 px-2 py-0.5 text-[11px] font-bold tracking-wide text-sky-900">
                READ ONLY
              </span>
            )}
            {user.organization.isDemo && (
              <span className="rounded bg-amber-100 px-2 py-0.5 text-[11px] font-bold tracking-wide text-amber-800">
                DEMO MODE
              </span>
            )}
          </div>
          <nav className="flex gap-1 overflow-x-auto md:hidden" aria-label="Main mobile">
            {NAV.map(({ to, label, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) =>
                  cx('rounded px-2 py-1 text-xs', isActive ? 'bg-slate-900 text-white' : 'text-slate-600')
                }
              >
                {label}
              </NavLink>
            ))}
          </nav>
          <UserMenu />
        </header>
        {showWorkspace && (
          <div className="border-b border-slate-200 bg-slate-100/70 px-6 py-2">
            <WorkspaceHeader />
          </div>
        )}
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-7xl px-6 py-6">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
