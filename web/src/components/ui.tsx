import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Info, Loader2, X, XCircle } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { ApiError } from '../lib/api';
import { humanize } from '../lib/format';

export const cx = (...classes: (string | false | null | undefined)[]) => classes.filter(Boolean).join(' ');

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export function Button({
  variant = 'secondary',
  size = 'md',
  loading,
  icon,
  children,
  className,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: 'sm' | 'md'; loading?: boolean; icon?: ReactNode }) {
  const styles: Record<ButtonVariant, string> = {
    primary: 'bg-brand-700 text-white hover:bg-brand-800 shadow-sm disabled:bg-brand-700/50',
    secondary: 'bg-white text-slate-700 border border-slate-300 hover:bg-slate-50 shadow-sm disabled:text-slate-400',
    ghost: 'text-slate-600 hover:bg-slate-100 disabled:text-slate-300',
    danger: 'bg-red-600 text-white hover:bg-red-700 shadow-sm disabled:bg-red-600/50',
  };
  return (
    <button
      type="button"
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:cursor-not-allowed',
        size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3.5 py-2 text-sm',
        styles[variant],
        className,
      )}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Layout primitives
// ---------------------------------------------------------------------------

export function Card({ title, actions, children, className, bodyClassName, subtitle }: { title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string }) {
  return (
    <section className={cx('rounded-lg border border-slate-200 bg-white shadow-sm', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-3.5">
          <div>
            {title && <h2 className="text-sm font-semibold text-slate-900">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cx('p-5', bodyClassName)}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">{title}</h1>
        {description && <p className="mt-1 max-w-3xl text-sm text-slate-500">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Stat({ label, value, tone = 'default', hint, onClick, active }: { label: string; value: ReactNode; tone?: 'default' | 'green' | 'amber' | 'red' | 'blue' | 'violet' | 'slate'; hint?: ReactNode; onClick?: () => void; active?: boolean }) {
  const tones = {
    default: 'text-slate-900',
    green: 'text-emerald-700',
    amber: 'text-amber-700',
    red: 'text-red-700',
    blue: 'text-brand-700',
    violet: 'text-violet-700',
    slate: 'text-slate-500',
  };
  const Comp = onClick ? 'button' : 'div';
  return (
    <Comp
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={cx(
        'rounded-lg border bg-white px-4 py-3 text-left shadow-sm',
        active ? 'border-brand-500 ring-1 ring-brand-500' : 'border-slate-200',
        onClick && 'transition hover:border-brand-300',
      )}
    >
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className={cx('mt-1 text-2xl font-semibold tabular-nums', tones[tone])}>{value}</div>
      {hint && <div className="mt-0.5 text-xs text-slate-500">{hint}</div>}
    </Comp>
  );
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

const STATUS_TONES: Record<string, string> = {
  // generic
  MATCH: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  PASS: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  COMPLETED: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  CONNECTED: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  CREATED: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  AUTO_MAPPED: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  RESOLVED: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  PLANNED: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  MANUAL: 'bg-brand-50 text-brand-700 ring-brand-600/20',
  UPDATED: 'bg-brand-50 text-brand-700 ring-brand-600/20',
  RUNNING: 'bg-brand-50 text-brand-700 ring-brand-600/20',
  QUEUED: 'bg-slate-100 text-slate-700 ring-slate-500/20',
  PENDING: 'bg-slate-100 text-slate-600 ring-slate-500/20',
  DRAFT: 'bg-slate-100 text-slate-600 ring-slate-500/20',
  EXECUTED: 'bg-brand-50 text-brand-700 ring-brand-600/20',
  UNKNOWN: 'bg-slate-100 text-slate-600 ring-slate-500/20',
  IGNORED: 'bg-slate-100 text-slate-600 ring-slate-500/20',
  SKIPPED: 'bg-slate-100 text-slate-600 ring-slate-500/20',
  INFO: 'bg-sky-50 text-sky-700 ring-sky-600/20',
  PAUSED: 'bg-amber-50 text-amber-700 ring-amber-600/20',
  DIFFERENT: 'bg-amber-50 text-amber-700 ring-amber-600/20',
  WARNING: 'bg-amber-50 text-amber-700 ring-amber-600/20',
  COMPLETED_WITH_ERRORS: 'bg-amber-50 text-amber-800 ring-amber-600/20',
  UNMAPPED: 'bg-amber-50 text-amber-700 ring-amber-600/20',
  SOURCE_ONLY: 'bg-violet-50 text-violet-700 ring-violet-600/20',
  TARGET_ONLY: 'bg-teal-50 text-teal-700 ring-teal-600/20',
  INCOMPATIBLE: 'bg-red-50 text-red-700 ring-red-600/20',
  FAIL: 'bg-red-50 text-red-700 ring-red-600/20',
  FAILED: 'bg-red-50 text-red-700 ring-red-600/20',
  BLOCKER: 'bg-red-50 text-red-700 ring-red-600/20',
  CANCELLED: 'bg-slate-200 text-slate-700 ring-slate-500/20',
  ERROR: 'bg-red-50 text-red-700 ring-red-600/20',
};

const STATUS_LABELS: Record<string, string> = {
  SOURCE_ONLY: 'Missing in target',
  TARGET_ONLY: 'Target only',
  COMPLETED_WITH_ERRORS: 'Completed with errors',
  AUTO_MAPPED: 'Auto-mapped',
};

export function StatusBadge({ status, label, className }: { status: string | null | undefined; label?: string; className?: string }) {
  if (!status) return <span className="text-xs text-slate-400">—</span>;
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
        STATUS_TONES[status] ?? 'bg-slate-100 text-slate-700 ring-slate-500/20',
        className,
      )}
    >
      {status === 'RUNNING' && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
      {label ?? STATUS_LABELS[status] ?? humanize(status)}
    </span>
  );
}

export function Pill({ children, tone = 'slate', title }: { children: ReactNode; tone?: 'slate' | 'violet' | 'teal' | 'amber' | 'blue' | 'red'; title?: string }) {
  const tones = {
    slate: 'bg-slate-100 text-slate-600',
    violet: 'bg-violet-100 text-violet-700',
    teal: 'bg-teal-100 text-teal-700',
    amber: 'bg-amber-100 text-amber-800',
    blue: 'bg-brand-100 text-brand-800',
    red: 'bg-red-100 text-red-700',
  };
  return (
    <span title={title} className={cx('inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium', tones[tone])}>
      {children}
    </span>
  );
}

export function ProgressBar({ value, tone = 'brand', label }: { value: number; tone?: 'brand' | 'green' | 'amber' | 'red'; label?: string }) {
  const tones = { brand: 'bg-brand-600', green: 'bg-emerald-500', amber: 'bg-amber-500', red: 'bg-red-500' };
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
      <div className={cx('h-full rounded-full transition-all duration-500', tones[tone])} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-sm text-slate-500" role="status">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> {label}
    </div>
  );
}

export function EmptyState({ icon, title, description, action }: { icon?: ReactNode; title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      {icon && <div className="mb-3 text-slate-400">{icon}</div>}
      <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
      {description && <p className="mt-1 max-w-md text-sm text-slate-500">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : 'Something went wrong';
  const requestId = error instanceof ApiError ? error.requestId : undefined;
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800" role="alert">
      <div className="flex items-start gap-2">
        <XCircle className="mt-0.5 h-4 w-4 flex-none" aria-hidden />
        <div className="flex-1">
          <p className="font-medium">{message}</p>
          {requestId && <p className="mt-0.5 text-xs text-red-700/80">Request ID: {requestId}</p>}
        </div>
        {onRetry && (
          <Button size="sm" onClick={onRetry}>
            Retry
          </Button>
        )}
      </div>
    </div>
  );
}

export function Callout({ tone = 'info', title, children }: { tone?: 'info' | 'warning' | 'danger' | 'success'; title?: ReactNode; children?: ReactNode }) {
  const map = {
    info: { cls: 'border-sky-200 bg-sky-50 text-sky-900', Icon: Info },
    warning: { cls: 'border-amber-200 bg-amber-50 text-amber-900', Icon: AlertTriangle },
    danger: { cls: 'border-red-200 bg-red-50 text-red-900', Icon: XCircle },
    success: { cls: 'border-emerald-200 bg-emerald-50 text-emerald-900', Icon: CheckCircle2 },
  }[tone];
  return (
    <div className={cx('flex gap-2.5 rounded-lg border px-4 py-3 text-sm', map.cls)}>
      <map.Icon className="mt-0.5 h-4 w-4 flex-none" aria-hidden />
      <div>
        {title && <p className="font-medium">{title}</p>}
        {children && <div className={cx(title ? 'mt-0.5' : '', 'opacity-90')}>{children}</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export function SearchInput({ value, onChange, placeholder = 'Search…', className }: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string }) {
  return (
    <input
      type="search"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      aria-label={placeholder}
      className={cx('w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm shadow-sm placeholder:text-slate-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 sm:w-64', className)}
    />
  );
}

export function Select({ value, onChange, options, label, className, disabled }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; label: string; className?: string; disabled?: boolean }) {
  return (
    <select
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className={cx('rounded-md border border-slate-300 bg-white py-1.5 pl-2.5 pr-8 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:bg-slate-50', className)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Checkbox({ checked, onChange, label, disabled, indeterminate }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean; indeterminate?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = Boolean(indeterminate);
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label={label}
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
      className="h-4 w-4 rounded border-slate-300 text-brand-700 focus:ring-brand-500"
    />
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { value: T; label: ReactNode }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div role="tablist" className="flex gap-1 border-b border-slate-200">
      {tabs.map((t) => (
        <button
          key={t.value}
          role="tab"
          type="button"
          aria-selected={value === t.value}
          onClick={() => onChange(t.value)}
          className={cx(
            '-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors',
            value === t.value ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-800',
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Modal({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cx('max-h-[90vh] w-full overflow-hidden rounded-xl bg-white shadow-xl', wide ? 'max-w-3xl' : 'max-w-lg')}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
          <h2 id={titleId} className="text-base font-semibold text-slate-900">
            {title}
          </h2>
          <button type="button" onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="max-h-[65vh] overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-slate-100 bg-slate-50 px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export function Disclosure({ summary, children, defaultOpen = false }: { summary: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center gap-2 text-left">
        {open ? <ChevronDown className="h-4 w-4 text-slate-400" /> : <ChevronRight className="h-4 w-4 text-slate-400" />}
        {summary}
      </button>
      {open && <div className="mt-2">{children}</div>}
    </div>
  );
}

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx('overflow-x-auto', className)}>
      <table className="min-w-full divide-y divide-slate-200 text-sm">{children}</table>
    </div>
  );
}
export const Th = ({ children, className }: { children?: ReactNode; className?: string }) => (
  <th scope="col" className={cx('whitespace-nowrap px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500', className)}>
    {children}
  </th>
);
export const Td = ({ children, className, colSpan }: { children?: ReactNode; className?: string; colSpan?: number }) => (
  <td colSpan={colSpan} className={cx('px-3 py-2 align-top text-slate-700', className)}>
    {children}
  </td>
);

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <code className={cx('font-mono text-[12px] text-slate-600', className)}>{children}</code>;
}
