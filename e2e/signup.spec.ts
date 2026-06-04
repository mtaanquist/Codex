import { expect, test } from '@playwright/test';

// A fixed address keeps repeated local runs idempotent: a second sign-up with
// the same email is treated as success (no enumeration), and the account stays
// unverified, so the sign-in gate below still holds.
const EMAIL = 'signup-e2e@example.com';

test('sign up, then get held at the email-verification gate', async ({ page }) => {
	await page.goto('/signup');
	await page.getByLabel('Display name').fill('Signup Tester');
	await page.getByLabel('Email').fill(EMAIL);
	await page.getByLabel('Password').fill('a-good-password');
	await page.getByRole('button', { name: 'Create account' }).click();

	// The page never says whether the address was new; it always points at the
	// inbox.
	await expect(page.getByRole('status')).toContainText('Check your email');

	// The account exists but is unverified, so sign-in is blocked with the
	// verification message rather than a wrong-password error.
	await page.goto('/login');
	await page.getByLabel('Email').fill(EMAIL);
	await page.getByLabel('Password').fill('a-good-password');
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page.getByRole('alert')).toContainText('Confirm your email');
});
