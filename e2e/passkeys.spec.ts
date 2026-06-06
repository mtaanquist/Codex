import { expect, test } from '@playwright/test';

// These journeys start signed out; skip the shared session.
test.use({ storageState: { cookies: [], origins: [] } });

// The full passkey journey against a CDP virtual authenticator: register a
// passkey from the account page, sign out, sign back in with it (no email or
// password typed), then remove it so repeated runs start clean. Chromium
// only, since the virtual authenticator is a CDP feature.
test('passkeys: register, sign in with one, remove it', async ({ page }) => {
	const client = await page.context().newCDPSession(page);
	await client.send('WebAuthn.enable');
	await client.send('WebAuthn.addVirtualAuthenticator', {
		options: {
			protocol: 'ctap2',
			transport: 'internal',
			hasResidentKey: true,
			hasUserVerification: true,
			isUserVerified: true,
			automaticPresenceSimulation: true
		}
	});

	await page.goto('/login');
	await page.getByLabel('Email').fill('passkey-e2e@example.com');
	await page.getByLabel('Password').fill('e2e-password');
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL('/');

	await page.getByLabel('Account menu').click();
	await page.getByRole('menuitem', { name: 'Account settings' }).click();
	await page.getByRole('button', { name: 'Security' }).click();

	await page.getByLabel('Passkey name').fill('e2e device');
	await page.getByRole('button', { name: 'Add passkey' }).click();
	await expect(page.getByText('Passkey added.')).toBeVisible();
	await expect(page.getByText('e2e device')).toBeVisible();

	// Sign out, then back in with the passkey alone.
	await page.getByRole('button', { name: 'Sign out', exact: true }).click();
	await expect(page).toHaveURL('/login');
	await page.getByRole('button', { name: 'Use a passkey instead' }).click();
	await expect(page).toHaveURL('/');

	// Remove it so the next run registers cleanly; removal re-confirms the
	// password.
	await page.getByLabel('Account menu').click();
	await page.getByRole('menuitem', { name: 'Account settings' }).click();
	await page.getByRole('button', { name: 'Security' }).click();
	const row = page.locator('.user-row', { hasText: 'e2e device' });
	await row.getByLabel('Current password').fill('e2e-password');
	await row.getByRole('button', { name: 'Remove' }).click();
	await expect(page.getByText('Passkey removed.')).toBeVisible();
});
