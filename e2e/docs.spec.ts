import { expect, test } from '@playwright/test';

test('help: browse the index and open an article', async ({ page }) => {
	await page.goto('/login');
	await page.getByLabel('Email').fill('e2e@example.com');
	await page.getByLabel('Password').fill('e2e-password');
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL('/');

	await page.goto('/docs');
	await expect(page.getByRole('heading', { name: 'Help', level: 1 })).toBeVisible();

	await page.getByRole('link', { name: /Writing in the editor/ }).click();
	await expect(page).toHaveURL('/docs/editor');
	await expect(
		page.getByRole('heading', { name: 'Writing in the editor', level: 1 })
	).toBeVisible();
});
