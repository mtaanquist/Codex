import { expect, test } from '@playwright/test';

test('account settings: rename and see the current session', async ({ page }) => {
	await page.goto('/login');
	await page.getByLabel('Email').fill('e2e@example.com');
	await page.getByLabel('Password').fill('e2e-password');
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL('/');

	await page.getByRole('link', { name: 'Account' }).click();
	await expect(page).toHaveURL('/account');
	await expect(page.getByText('e2e@example.com')).toBeVisible();

	// The device used to sign in shows up as the current session.
	await expect(page.getByText('This device')).toBeVisible();

	// A fixed name keeps repeated runs idempotent.
	await page.getByLabel('Display name').fill('E2E Tester');
	await page.getByRole('button', { name: 'Save' }).click();
	await expect(page.getByRole('status')).toContainText('Saved');
});
