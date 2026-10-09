import { expect, test } from '@playwright/test';

/**
 * The public front door.
 *
 * Until now the first thing anybody saw was a sign-in box, which tells a visitor nothing about what
 * they would be signing in to. These tests cover the two things that would be most embarrassing to
 * get wrong: a landing page that quietly breaks the app's routing for everyone who is signed in, and
 * a "request access" form that looks like it worked and posts nowhere.
 */

test('an anonymous visitor gets the product, not a sign-in box', async ({ page }) => {
  const problems: string[] = [];
  page.on('console', (msg) => msg.type() === 'error' && problems.push(`console — ${msg.text()}`));
  page.on('pageerror', (err) => problems.push(`page error — ${err.message}`));

  await page.goto('/');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: /Plan migrations with confidence/ })).toBeVisible();

  // The things an evaluator scrolls for.
  await expect(page.getByRole('heading', { name: 'Why the numbers can be trusted.' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'The gaps, before you find them.' })).toBeVisible();
  await expect(page.getByText('Not yet run against a real tenant').first()).toBeVisible();

  // An anchor in the navigation goes where it says.
  await page.getByRole('link', { name: 'Security' }).first().click();
  await expect(page).toHaveURL(/#security$/);
  await expect(page.getByRole('heading', { name: /production data/ })).toBeVisible();

  // The FAQ answers are behind a disclosure, so the page is scannable.
  const faq = page.getByRole('button', { name: /How do accounts work\?/ });
  await faq.click();
  await expect(page.getByText(/Members plan, analyse, preflight and migrate/)).toBeVisible();

  expect(problems, `\n${problems.join('\n')}\n`).toEqual([]);
});

test('the privacy notice and terms are public and reachable', async ({ page }) => {
  // A privacy notice behind a sign-in is no notice, and the form that collects names links to it.
  await page.goto('/');
  await page.getByRole('link', { name: 'Privacy', exact: true }).click();
  await expect(page).toHaveURL(/\/privacy$/);
  await expect(page.getByRole('heading', { name: 'Privacy notice' })).toBeVisible();
  // The claim the whole governance section rests on.
  await expect(page.getByText(/not sent to any AI model/)).toBeVisible();

  await page.getByRole('link', { name: 'Terms of use' }).click();
  await expect(page).toHaveURL(/\/terms$/);
  await expect(page.getByRole('heading', { name: 'Terms of use' })).toBeVisible();
});

test('requesting access reaches the server and says so', async ({ page }) => {
  await page.goto('/');
  const form = page.getByTestId('access-request-form');
  await form.scrollIntoViewIfNeeded();
  await form.getByLabel('Your name').fill('Dana Whitfield');
  await form.getByLabel('Work email').fill('dana.whitfield@contoso.test');
  await form.getByLabel('Company').fill('Contoso');
  await form.getByLabel('What are you moving?').fill('A legacy CRM into Dataverse, roughly 2M rows.');

  const submitted = page.waitForResponse(
    (r) => r.url().includes('/api/access-requests') && r.request().method() === 'POST',
  );
  await form.getByRole('button', { name: 'Request access' }).click();
  expect((await submitted).status()).toBe(202);

  // The confirmation names the address we will reply to, so a typo is visible while it can be fixed.
  const sent = page.getByTestId('access-request-sent');
  await expect(sent).toBeVisible();
  await expect(sent).toContainText('dana.whitfield@contoso.test');
});

test('sign-in explains what signing up actually means here', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Sign in' }).first().click();
  await expect(page).toHaveURL(/\/login$/);

  // There is no password account to create. The page has to say so rather than offering a
  // "Sign up" button that leads nowhere.
  await expect(page.getByRole('heading', { name: 'New here?' })).toBeVisible();
  await expect(page.getByRole('link', { name: /Back to the product overview/ })).toBeVisible();
});

test('the demo still starts from the landing page, and deep links still ask for sign-in', async ({
  page,
}) => {
  // A signed-out visitor to a deep link is sent to sign in and carried back afterwards — the
  // routing change put the landing page at the root, and this is what it must not have broken.
  await page.goto('/runs');
  await expect(page).toHaveURL(/\/login\?returnTo=%2Fruns/);

  await page.goto('/');
  await page.getByTestId('try-demo-primary').first().click();
  await expect(page.getByRole('heading', { name: /Welcome, Demo/ })).toBeVisible({ timeout: 60_000 });

  // And once signed in, the root is the product again rather than the marketing page.
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Welcome, Demo/ })).toBeVisible();
});

// 390 is an iPhone, 360 is most Android phones, and 320 is the narrowest anyone still uses. Testing
// the margin rather than one device is the point: the layout that failed a hosted run by 45 pixels
// at 390 was also 30 pixels too wide at 360 and 70 at 320, and only the first was being checked.
for (const width of [390, 360, 320]) {
  test(`the landing page works on a phone (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: /Plan migrations with confidence/ })).toBeVisible();
    // A horizontal scrollbar on a marketing page is the first thing anyone notices on a phone.
    // Evaluated as an expression string: this file is typechecked without the DOM library.
    const overflow = Number(
      await page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth'),
    );
    // Naming the culprit, because "45 pixels too wide" sends whoever sees this failure hunting
    // through the whole page, and the element that sticks out is already known to the browser.
    const culprits = (await page.evaluate(`(() => {
    const limit = document.documentElement.clientWidth;
    return Array.from(document.querySelectorAll('*'))
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { right: Math.round(r.right), width: Math.round(r.width), tag: el.tagName.toLowerCase(), cls: String(el.className || '').slice(0, 120) };
      })
      .filter((c) => c.right > limit + 1)
      .sort((a, b) => b.right - a.right)
      .slice(0, 5);
  })()`)) as { right: number; width: number; tag: string; cls: string }[];
    expect(overflow, `widest elements past the viewport: ${JSON.stringify(culprits)}`).toBeLessThanOrEqual(1);
    await expect(page.getByTestId('try-demo-quiet')).toBeVisible();
    // Signing in must still be reachable; the brand mark is what gives way, not an action.
    await expect(page.getByRole('link', { name: 'Sign in' }).first()).toBeVisible();
  });
}
