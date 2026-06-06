import { expect, test as setup } from '@playwright/test';

// Signs in once and saves the session for every authenticated spec. One
// login per run keeps the suite clear of the per-email login rate limit,
// which the specs were spending sixteen attempts against.
setup('sign in as the e2e user', async ({ page }) => {
	await page.goto('/login');
	await page.getByLabel('Email').fill('e2e@example.com');
	await page.getByLabel('Password').fill('e2e-password');
	await page.getByRole('button', { name: 'Sign in', exact: true }).click();
	await expect(page).toHaveURL('/');
	await page.context().storageState({ path: 'e2e/.auth/e2e.json' });
});
