import { expect, test } from '@playwright/test';

/**
 * The audit trail, as somebody arrives at it.
 *
 * Nobody opens an audit trail to browse. They open it with a question — what happened to that
 * environment, who approved that — and the previous version answered by showing two hundred rows
 * in one list.
 */
test('the audit trail can be narrowed to the question being asked', async ({ page }) => {
  const problems: string[] = [];
  page.on('console', (msg) => msg.type() === 'error' && problems.push(msg.text()));
  page.on('pageerror', (err) => problems.push(err.message));

  await page.goto('/login');
  await page.getByRole('button', { name: 'Continue with demo account' }).click();
  await expect(page.getByRole('heading', { name: /Welcome, Demo/ })).toBeVisible();
  // Some activity to look at.
  await page.goto('/environments');
  await expect(page.getByTestId('env-card-DeepTrics QA')).toBeVisible({ timeout: 60_000 });

  await page.goto('/settings');
  const trail = page.getByTestId('audit-trail');
  await expect(trail).toBeVisible();

  // Events are grouped by day rather than run together.
  await expect(trail.getByText(/\d+ events?$/).first()).toBeVisible();

  // Narrowing to one kind of activity really narrows it. Asserted by what is on the page rather
  // than by counting rows: against a trail with months of history in it, both the filtered and
  // unfiltered lists hit the page limit and the counts say nothing.
  const categories = trail.getByTestId('audit-category');
  await expect(categories.filter({ hasText: 'Connections' }).first()).toBeVisible();
  await trail.getByLabel('Filter by activity').selectOption('ACCESS');
  await expect(categories.first()).toBeVisible();
  // Every row on the page is now the kind that was asked for, and nothing else.
  expect(await categories.filter({ hasText: 'Connections' }).count()).toBe(0);
  expect(await categories.filter({ hasText: 'Migration runs' }).count()).toBe(0);

  // However much it holds, the footer says how much of it is on screen.
  await expect(trail.getByText(/Showing .* of .* matching event/)).toBeVisible();

  // A filter that matches nothing says so, and offers a way back.
  await trail.getByLabel('Filter by user').selectOption({ index: 0 });
  await trail.getByPlaceholder('Search actions and details').fill('zzz-nothing-matches-this');
  await expect(trail.getByText('Nothing matches')).toBeVisible();
  await trail.getByRole('button', { name: 'Clear filters' }).click();
  await expect(trail.getByText('Nothing matches')).toHaveCount(0);

  expect(problems, `\n${problems.join('\n')}\n`).toEqual([]);
});
