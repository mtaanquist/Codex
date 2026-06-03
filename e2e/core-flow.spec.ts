import { expect, test } from '@playwright/test';

test('sign in, create a universe and a story, and open it', async ({ page }) => {
	await page.goto('/login');
	await page.getByLabel('Email').fill('e2e@example.com');
	await page.getByLabel('Password').fill('e2e-password');
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL('/');

	// Unique name so repeated local runs do not collide.
	const universeName = `Testverse ${Date.now()}`;
	await page.getByLabel('New universe').fill(universeName);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText(universeName);

	await page.getByLabel('New story').fill('Book of Ash');
	await page.getByRole('button', { name: 'Create story' }).click();

	// Opening a story lands in the editor shell: breadcrumb and sidebar both
	// carry the story title.
	await expect(page.locator('.crumb.current')).toHaveText('Book of Ash');
	await expect(page.locator('.story-title')).toHaveText('Book of Ash');

	// Focus mode hides the chrome; Esc brings it back.
	await page.getByRole('button', { name: 'Focus mode' }).click();
	await expect(page.locator('.topbar')).toBeHidden();
	await page.keyboard.press('Escape');
	await expect(page.locator('.topbar')).toBeVisible();

	// The breadcrumb leads back to the universe, which lists the story.
	await page.getByRole('link', { name: universeName }).click();
	await expect(page.getByRole('link', { name: 'Book of Ash' })).toBeVisible();
});

test('wrong password is rejected', async ({ page }) => {
	await page.goto('/login');
	await page.getByLabel('Email').fill('e2e@example.com');
	await page.getByLabel('Password').fill('not-the-password');
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page.getByRole('alert')).toHaveText('Wrong email or password.');
});
