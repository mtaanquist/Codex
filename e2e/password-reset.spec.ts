import { expect, test } from '@playwright/test';

// These journeys start signed out; skip the shared session.
test.use({ storageState: { cookies: [], origins: [] } });

// The reset link carries a token only ever stored hashed, so an end-to-end
// click-through cannot reconstruct it; the token logic is covered by the
// integration tests. These cover the two user-visible paths that need no token.

test('forgot-password always reports the same thing', async ({ page }) => {
	await page.goto('/forgot-password');
	await page.getByLabel('Email').fill('whoever@example.com');
	await page.getByRole('button', { name: 'Send reset link' }).click();
	await expect(page.getByRole('status')).toContainText('If an account uses that email');
});

test('an invalid reset link is refused', async ({ page }) => {
	await page.goto('/reset-password?token=not-a-real-token');
	await page.getByLabel('New password').fill('a-good-password');
	await page.getByRole('button', { name: 'Update password' }).click();
	await expect(page.getByRole('alert')).toContainText('not valid');
});
