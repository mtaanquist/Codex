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
	await page.getByRole('button', { name: 'Save name' }).click();
	await expect(page.getByRole('status')).toContainText('Saved');

	// Sessions live under Security; the signed-in device shows as current.
	await page.getByRole('button', { name: 'Security' }).click();
	await expect(page.getByText('Current', { exact: true })).toBeVisible();
});
