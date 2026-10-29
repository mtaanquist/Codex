import { expect, test } from '@playwright/test';
import { gotoReady } from './navigate';

// A dead link lands on a page inside the app's own shell, with a title and a
// way back, instead of the framework's bare "404".
test.describe('signed in', () => {
	test('an unknown address shows the not-found page in the app shell', async ({ page }) => {
		const response = await gotoReady(page, '/does-not-exist');
		expect(response?.status()).toBe(404);
		await expect(page).toHaveTitle('Page not found - Codex');
		await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toHaveText(
			'Page not found'
		);
		await expect(page.getByRole('banner')).toBeVisible();

		await page.getByRole('link', { name: 'Go to your library' }).click();
		await expect(page).toHaveURL('/');
		await expect(page.getByRole('heading', { name: 'Your library' })).toBeVisible();
	});

	test('an unknown story id shows the same page', async ({ page }) => {
		const response = await gotoReady(page, '/stories/00000000-0000-4000-8000-000000000000');
		expect(response?.status()).toBe(404);
		await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
	});
});

test.describe('signed out', () => {
	test.use({ storageState: { cookies: [], origins: [] } });

	// Signed-out visitors are sent to sign-in from private addresses, so a dead
	// link to a public reading page is where they meet this page.
	test('an unknown public page offers sign-in', async ({ page }) => {
		const response = await gotoReady(page, '/@nobody-here/no-such-story');
		expect(response?.status()).toBe(404);
		await expect(page).toHaveTitle('Page not found - Codex');
		await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
		await page.getByRole('main').getByRole('link', { name: 'Sign in' }).click();
		await expect(page).toHaveURL('/login');
	});
});
