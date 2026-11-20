import { expect, test } from '@playwright/test';
import { gotoReady } from './navigate';

// These journeys start signed out; skip the shared session.
test.use({ storageState: { cookies: [], origins: [] } });

// The emailed link carries a token only ever stored hashed, so an end-to-end
// click-through cannot reconstruct it; using a link is covered by the
// integration tests. These cover the paths that need no token.

test('the sign-in page offers a link by email, which always reports the same thing', async ({
	page
}) => {
	await gotoReady(page, '/login');
	await page.getByRole('link', { name: 'Email me a sign-in link instead' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sign in with a link');
	await page.getByLabel('Email').fill('whoever@example.com');
	await page.getByRole('button', { name: 'Send sign-in link' }).click();
	await expect(page.getByRole('status')).toContainText('If an account uses that email');
});

test('a dead sign-in link says so and offers a new one', async ({ page }) => {
	await gotoReady(page, '/login/link?token=not-a-real-token');
	await expect(page.getByRole('alert')).toContainText('not valid');
	await expect(page.getByRole('button', { name: 'Send sign-in link' })).toBeVisible();
});
