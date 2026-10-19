import { expect, test } from '@playwright/test';
import { gotoReady } from './navigate';
import { totpCode } from '../src/lib/server/totp';

// These journeys start signed out; skip the shared session.
test.use({ storageState: { cookies: [], origins: [] } });

// Enrols in two-factor through the account page using a code computed from the
// setup key the page shows, confirms the recovery codes appear, signs out and
// back in with a code, then turns it off so the dedicated seed user is left as
// it started. The limits and recovery-code paths of the code step are covered
// by the login-route integration tests.
test('two-factor: enrol, sign in with a code, and turn it back off', async ({ page }) => {
	await gotoReady(page, '/login');
	await page.getByLabel('Email').fill('tfa-e2e@example.com');
	await page.getByLabel('Password').fill('e2e-password');
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL('/');

	await page.getByLabel('Account menu').click();
	await page.getByRole('menuitem', { name: 'Account settings' }).click();
	await page.getByRole('link', { name: 'Security' }).click();

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
	// The page has other "Confirm your password" fields, so target this one.
	await page.locator('#totp-password').fill('e2e-password');
	await page.getByRole('button', { name: 'Verify and turn on' }).click();
	await expect(page.getByText('Treat these like passwords')).toBeVisible();
	await expect(page.getByText(/you'll be asked for a code/)).toBeVisible();

	// Sign out and back in: the password alone now leads to the code prompt.
	// The enrolment code's step is spent, so sign in with the next step's code
	// (still inside the one-step drift window).
	await page.getByRole('button', { name: 'Sign out', exact: true }).click();
	await expect(page).toHaveURL('/login');
	await page.getByLabel('Email').fill('tfa-e2e@example.com');
	await page.getByLabel('Password').fill('e2e-password');
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL('/login/totp');
	await page.getByLabel('Authentication code').fill(totpCode(secret, Date.now() + 30_000));
	await page.getByRole('button', { name: 'Verify' }).click();
	await expect(page).toHaveURL('/');

	await page.getByLabel('Account menu').click();
	await page.getByRole('menuitem', { name: 'Account settings' }).click();
	await page.getByRole('link', { name: 'Security' }).click();

	// Turn it off again so repeated local runs start clean. Turning off now
	// re-confirms the password, so fill the field on that form first.
	const turnOff = page.locator('form', { has: page.getByRole('button', { name: 'Turn off' }) });
	await turnOff.getByLabel('Current password').fill('e2e-password');
	await turnOff.getByRole('button', { name: 'Turn off' }).click();
	await expect(page.getByRole('button', { name: 'Set up' })).toBeVisible();
});
