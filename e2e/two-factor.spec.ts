import { expect, test } from '@playwright/test';
import { totpCode } from '../src/lib/server/totp';

// Enrols in two-factor through the account page using a code computed from the
// setup key the page shows, confirms the recovery codes appear, then turns it
// off so the dedicated seed user is left as it started. The sign-in challenge
// itself is covered by the two-factor integration tests.
test('two-factor: enrol from the account page and turn it back off', async ({ page }) => {
	await page.goto('/login');
	await page.getByLabel('Email').fill('tfa-e2e@example.com');
	await page.getByLabel('Password').fill('e2e-password');
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL('/');

	await page.getByRole('link', { name: 'Account', exact: true }).click();
	await page.getByRole('button', { name: 'Security' }).click();

	// Begin setup and read the secret the page shows for manual entry.
	await page.getByRole('button', { name: 'Set up' }).click();
	const secret = await page.locator('#totp-secret').inputValue();
	expect(secret.length).toBeGreaterThan(0);

	// Confirm with a freshly computed code, entered across the segmented boxes;
	// recovery codes appear once.
	const code = totpCode(secret);
	for (let i = 0; i < 6; i++) {
		await page.getByLabel(`Digit ${i + 1}`).fill(code[i]);
	}
	await page.getByRole('button', { name: 'Verify and turn on' }).click();
	await expect(page.getByText('Treat these like passwords')).toBeVisible();
	await expect(page.getByText(/you'll be asked for a code/)).toBeVisible();

	// Turn it off again so repeated local runs start clean.
	await page.getByRole('button', { name: 'Turn off' }).click();
	await expect(page.getByRole('button', { name: 'Set up' })).toBeVisible();
});
