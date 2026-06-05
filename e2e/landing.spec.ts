import { expect, test } from '@playwright/test';

// The public face: signed-out visitors get the landing page, its calls to
// action lead into the styled auth screens, and signing in lands in the
// library as before.
test('landing page greets signed-out visitors and leads to sign-in', async ({ page }) => {
	await page.goto('/');
	await expect(page.getByRole('heading', { name: /Plan the world/ })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Request access' })).toHaveAttribute(
		'href',
		'/signup'
	);

	// Into the styled sign-in card.
	await page.getByRole('link', { name: 'Sign in' }).first().click();
	await expect(page).toHaveURL('/login');
	await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
	await page.getByLabel('Email').fill('e2e@example.com');
	await page.getByLabel('Password').fill('e2e-password');
	await page.getByRole('button', { name: 'Sign in', exact: true }).click();

	// Signed in, the root is the library again.
	await expect(page).toHaveURL('/');
	await expect(page.getByRole('heading', { name: 'Library' })).toBeVisible();
});
