import { expect, test } from '@playwright/test';

test('account settings: rename and see the current session', async ({ page }) => {
	await page.goto('/');

	await page.getByLabel('Account menu').click();
	await page.getByRole('menuitem', { name: 'Account settings' }).click();
	await expect(page).toHaveURL('/account');
	// The sidebar shows who is signed in.
	await expect(page.getByRole('complementary').getByText('e2e@example.com')).toBeVisible();

	// Profile is the default section; a fixed name keeps repeated runs idempotent.
	await page.getByLabel('Display name').fill('E2E Tester');
	await page.getByLabel('Pen name').fill('E. Tester');
	await page.getByRole('button', { name: 'Save changes' }).click();
	await expect(page.getByRole('status')).toContainText('Saved');

	// The top-right avatar opens the account menu; Esc closes it.
	const avatar = page.getByRole('button', { name: 'Account menu' });
	await expect(avatar).toHaveAttribute('aria-expanded', 'false');
	await avatar.click();
	await expect(avatar).toHaveAttribute('aria-expanded', 'true');
	await expect(page.getByRole('menuitem', { name: 'Account settings' })).toBeVisible();
	await expect(page.getByRole('menuitem', { name: 'Sign out' })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(avatar).toHaveAttribute('aria-expanded', 'false');

	// The avatar-menu theme toggle persists across a reload, not just the current
	// view (regression: it used to write only localStorage, so the next
	// server-rendered navigation reverted it).
	await avatar.click();
	const wasDark = (await page.locator('html').getAttribute('data-theme')) === 'dark';
	const toggleTo = wasDark ? 'light' : 'dark';
	const themeSave = page.waitForResponse((r) => r.url().includes('/api/appearance') && r.ok());
	await page.getByRole('menuitem', { name: `Switch to ${toggleTo}` }).click();
	await themeSave;
	await expect(page.locator('html')).toHaveAttribute('data-theme', toggleTo);
	await page.reload();
	await expect(page.locator('html')).toHaveAttribute('data-theme', toggleTo);

	// Sessions live under Security, on its own page; the signed-in device
	// shows as current.
	await page.getByRole('link', { name: 'Security' }).click();
	await expect(page).toHaveURL(/\/account\/security$/);
	await expect(page.getByText('Current', { exact: true })).toBeVisible();

	// A made-up section is a clean 404, not an empty page.
	const bogus = await page.request.get('/account/nonsense');
	expect(bogus.status()).toBe(404);

	// Display: the notification matrix saves a per-kind channel choice and
	// reads it back. The admin-only row is absent for a regular account.
	await page.getByRole('link', { name: 'Display' }).click();
	const replyEmail = page.getByLabel('Replies to your review comments by email');
	await expect(page.getByLabel('New accounts awaiting approval in app')).toHaveCount(0);
	await replyEmail.uncheck();
	await page.getByRole('button', { name: 'Save notifications' }).click();
	await expect(page.getByRole('status')).toContainText('Saved');
	await expect(replyEmail).not.toBeChecked();
	await replyEmail.check();
	await page.getByRole('button', { name: 'Save notifications' }).click();
	await expect(page.getByRole('status')).toContainText('Saved');

	// A saved theme applies app-wide via the data-theme attribute.
	await page.getByLabel('Theme').selectOption('dark');
	await page.getByRole('button', { name: 'Save display' }).click();
	await expect(page.getByRole('status')).toContainText('Saved');
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

	// Reset so repeated runs start from a known theme.
	await page.getByLabel('Theme').selectOption('system');
	await page.getByRole('button', { name: 'Save display' }).click();
	await expect(page.getByRole('status')).toContainText('Saved');
});
