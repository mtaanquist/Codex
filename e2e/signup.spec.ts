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

// The invite code is seeded by global-setup. The first run creates an approved
// account; later runs hit the duplicate-email path, which shows the same
// invited message, so the assertions hold either way.
test('an invite link prefills the code and skips the approval wording', async ({ page }) => {
	await page.goto('/signup?code=E2EI-NVIT-CODE');
	await expect(page.getByLabel('Invite code (optional)')).toHaveValue('E2EI-NVIT-CODE');

	await page.getByLabel('Display name').fill('Invited Tester');
	await page.getByLabel('Email').fill('invite-e2e@example.com');
	await page.getByLabel('Password').fill('a-good-password');
	await page.getByRole('button', { name: 'Create account' }).click();

	const status = page.getByRole('status');
	await expect(status).toContainText('you can sign in');
	await expect(status).not.toContainText('administrator');
});

test('a wrong invite code blocks the sign-up with a clear error', async ({ page }) => {
	await page.goto('/signup');
	await page.getByLabel('Display name').fill('Mistyped Tester');
	await page.getByLabel('Email').fill('mistyped-e2e@example.com');
	await page.getByLabel('Password').fill('a-good-password');
	await page.getByLabel('Invite code (optional)').fill('WRON-GCOD-E999');
	await page.getByRole('button', { name: 'Create account' }).click();

	await expect(page.getByRole('alert')).toContainText('invite code is not valid');
	// The form keeps what was typed so it can be corrected.
	await expect(page.getByLabel('Invite code (optional)')).toHaveValue('WRON-GCOD-E999');
});
