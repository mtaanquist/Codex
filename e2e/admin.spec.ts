import { expect, test } from '@playwright/test';

// The seeded e2e account is a regular user, so it must not reach the admin
// area. The approve/reject behaviour itself is covered by integration tests.
test('the admin area is hidden from non-admins', async ({ page }) => {
	await page.goto('/login');
	await page.getByLabel('Email').fill('e2e@example.com');
	await page.getByLabel('Password').fill('e2e-password');
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL('/');

	const response = await page.goto('/admin');
	expect(response?.status()).toBe(404);
});
