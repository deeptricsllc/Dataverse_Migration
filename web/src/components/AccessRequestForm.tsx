import type { AccessRequestInput } from '@shared/domain';
import { useMutation } from '@tanstack/react-query';
import { CheckCircle2, Send } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { ApiError, post } from '../lib/api';

/**
 * The public sign-up path.
 *
 * There is no password account to create: a workspace appears the first time somebody from a
 * Microsoft tenant signs in. So "sign up" here means asking a human, which is what an evaluator who
 * cannot yet get their IT team to consent to an application actually needs.
 */

const field =
  'w-full rounded-lg border border-white/15 bg-white/5 px-3.5 py-2.5 text-sm text-white placeholder:text-slate-500 focus:border-brand-500 focus:bg-white/10 focus:outline-none';
const label = 'mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400';

export function AccessRequestForm({ compact = false }: { compact?: boolean }) {
  const [sentTo, setSentTo] = useState<string | null>(null);
  const submit = useMutation({
    mutationFn: (input: AccessRequestInput) => post<{ received: true }>('/api/access-requests', input),
  });

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const value = (k: string) => String(data.get(k) ?? '').trim();
    const email = value('email');
    submit.mutate(
      {
        name: value('name'),
        email,
        company: value('company') || undefined,
        useCase: value('useCase') || undefined,
        website: value('website') || undefined,
      },
      { onSuccess: () => setSentTo(email) },
    );
  };

  if (sentTo) {
    return (
      <div
        className="flex items-start gap-3 rounded-xl border border-emerald-400/30 bg-emerald-400/10 p-5"
        data-testid="access-request-sent"
      >
        <CheckCircle2 className="mt-0.5 h-5 w-5 flex-none text-emerald-300" aria-hidden />
        <div className="text-sm text-emerald-50">
          <p className="font-semibold">Thank you — that has reached us.</p>
          <p className="mt-1 text-emerald-100/80">
            We will reply to <span className="font-medium text-white">{sentTo}</span>. In the meantime the
            demo below is the whole product, running on simulated data.
          </p>
        </div>
      </div>
    );
  }

  const rateLimited = submit.error instanceof ApiError && submit.error.status === 429;

  return (
    <form onSubmit={onSubmit} className="space-y-4" data-testid="access-request-form">
      <div className={compact ? 'space-y-4' : 'grid gap-4 sm:grid-cols-2'}>
        <div>
          <label className={label} htmlFor="ar-name">
            Your name
          </label>
          <input
            id="ar-name"
            name="name"
            required
            maxLength={120}
            className={field}
            placeholder="Jane Okafor"
          />
        </div>
        <div>
          <label className={label} htmlFor="ar-email">
            Work email
          </label>
          <input
            id="ar-email"
            name="email"
            type="email"
            required
            maxLength={200}
            className={field}
            placeholder="jane@company.com"
          />
        </div>
      </div>
      <div>
        <label className={label} htmlFor="ar-company">
          Company <span className="font-normal normal-case tracking-normal text-slate-500">(optional)</span>
        </label>
        <input id="ar-company" name="company" maxLength={160} className={field} placeholder="Company Ltd" />
      </div>
      <div>
        <label className={label} htmlFor="ar-usecase">
          What are you moving?{' '}
          <span className="font-normal normal-case tracking-normal text-slate-500">(optional)</span>
        </label>
        <textarea
          id="ar-usecase"
          name="useCase"
          rows={3}
          maxLength={2000}
          className={field}
          placeholder="e.g. a legacy SQL Server CRM into Dataverse — roughly 2 million rows across 40 tables."
        />
      </div>
      {/* Honeypot: hidden from people, irresistible to scripts. A filled one is dropped server-side. */}
      <div aria-hidden className="hidden">
        <label htmlFor="ar-website">Website</label>
        <input id="ar-website" name="website" tabIndex={-1} autoComplete="off" />
      </div>
      {submit.error && (
        <p className="text-sm text-rose-300" role="alert">
          {rateLimited
            ? 'That is several requests in a short time. Please try again in a few minutes.'
            : submit.error instanceof Error
              ? submit.error.message
              : 'Something went wrong. Please try again.'}
        </p>
      )}
      <button
        type="submit"
        disabled={submit.isPending}
        className="inline-flex items-center justify-center gap-2 rounded-lg bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-brand-900/40 transition-colors hover:bg-brand-500 disabled:opacity-60"
      >
        <Send className="h-4 w-4" aria-hidden />
        {submit.isPending ? 'Sending…' : 'Request access'}
      </button>
      <p className="text-xs text-slate-500">
        We use this only to reply to you. No newsletter, and nothing is shared with anyone else.
      </p>
    </form>
  );
}
