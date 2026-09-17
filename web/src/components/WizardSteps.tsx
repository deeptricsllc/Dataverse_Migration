import { Check } from 'lucide-react';
import { Link } from 'react-router-dom';
import { cx } from './ui';

export const WIZARD_STEPS = [
  'Select environments',
  'Analyze',
  'Select tables',
  'Review dependencies',
  'Map fields',
  'Review plan',
  'Execute',
  'Validate',
  'Results',
] as const;

/**
 * Guided migration workflow indicator. `current` is 1-based; `links` optionally maps step
 * numbers to routes the user can jump to.
 */
export function WizardSteps({
  current,
  links = {},
}: {
  current: number;
  links?: Partial<Record<number, string>>;
}) {
  return (
    <nav aria-label="Migration workflow" className="mb-6 overflow-x-auto">
      <ol className="flex min-w-max items-center gap-1">
        {WIZARD_STEPS.map((label, i) => {
          const step = i + 1;
          const done = step < current;
          const active = step === current;
          const content = (
            <span
              className={cx(
                'flex items-center gap-2 rounded-full px-2.5 py-1 text-xs font-medium',
                active && 'bg-brand-700 text-white',
                done && 'text-brand-800 hover:bg-brand-50',
                !done && !active && 'text-slate-400',
              )}
            >
              <span
                className={cx(
                  'flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold',
                  active
                    ? 'bg-white text-brand-700'
                    : done
                      ? 'bg-brand-100 text-brand-700'
                      : 'bg-slate-200 text-slate-500',
                )}
              >
                {done ? <Check className="h-3 w-3" /> : step}
              </span>
              {label}
            </span>
          );
          return (
            <li key={label} className="flex items-center gap-1" aria-current={active ? 'step' : undefined}>
              {links[step] && !active ? <Link to={links[step]!}>{content}</Link> : content}
              {step < WIZARD_STEPS.length && <span className="h-px w-3 bg-slate-300" aria-hidden />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
