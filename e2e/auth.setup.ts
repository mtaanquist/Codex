import { expect, test as setup } from '@playwright/test';

// Signs in once per account and saves the session for the specs. One login
// per run keeps the suite clear of the per-email login rate limit, which the
// specs were spending sixteen attempts against.
for (const [email, path] of [
	['e2e@example.com', 'e2e/.auth/e2e.json'],
	['assistant-e2e@example.com', 'e2e/.auth/assistant.json']
]) {
	setup(`sign in as ${email}`, async ({ page }) => {
		await page.goto('/login');
		await page.getByLabel('Email').fill(email);
		await page.getByLabel('Password').fill('e2e-password');
		await page.getByRole('button', { name: 'Sign in', exact: true }).click();
		await expect(page).toHaveURL('/');
		await page.context().storageState({ path });
	});
}
