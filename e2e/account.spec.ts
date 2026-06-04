import { expect, test } from '@playwright/test';

test('account settings: rename and see the current session', async ({ page }) => {
	await page.goto('/login');
	await page.getByLabel('Email').fill('e2e@example.com');
	await page.getByLabel('Password').fill('e2e-password');
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL('/');

	await page.getByRole('link', { name: 'Account', exact: true }).click();
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

	// Sessions live under Security; the signed-in device shows as current.
	await page.getByRole('button', { name: 'Security' }).click();
	await expect(page.getByText('Current', { exact: true })).toBeVisible();

	// Display: a saved theme applies app-wide via the data-theme attribute.
	await page.getByRole('button', { name: 'Display' }).click();
	await page.getByLabel('Theme').selectOption('dark');
	await page.getByRole('button', { name: 'Save display' }).click();
	await expect(page.getByRole('status')).toContainText('Saved');
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

	// Reset so repeated runs start from a known theme.
	await page.getByLabel('Theme').selectOption('system');
	await page.getByRole('button', { name: 'Save display' }).click();
	await expect(page.getByRole('status')).toContainText('Saved');
});
