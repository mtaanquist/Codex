import { expect, test } from '@playwright/test';
import { gotoReady } from './navigate';
import { pickFromLibraryMenu, startStoryInUniverse } from './library';

// Runs as the account with the Assistant switched on.
test.use({ storageState: 'e2e/.auth/assistant.json' });

// #1266: a universe chooses its own Assistant models, and a story in it
// starts from them. The model list is stubbed, so no endpoint is needed.
test('a model chosen for a universe is the default in its stories', async ({ page }) => {
	await page.route('**/api/assistant/models*', (route) =>
		route.fulfill({ json: { models: ['big-model', 'small-model'], complete: true } })
	);

	await gotoReady(page, '/');
	const name = `Models ${Date.now()}`;
	await pickFromLibraryMenu(page, 'New universe');
	await page.getByLabel('New universe').fill(name);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText(`${name} - settings`);

	await page
		.getByRole('navigation', { name: 'Universe settings' })
		.getByRole('link', { name: 'Assistant' })
		.click();
	await expect(page.getByRole('heading', { name: 'Assistant models' })).toBeVisible();
	const background = page.getByLabel('Background work');
	await expect(background.locator('option', { hasText: 'big-model' })).toHaveCount(1);
	await background.selectOption('big-model');
	await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();

	// The choice is still there after a reload.
	await page.reload();
	await expect(page.getByLabel('Background work')).toHaveValue('big-model');

	// A story in the universe starts from it, and can choose its own.
	await gotoReady(page, '/');
	await startStoryInUniverse(page, name);
	await page.getByLabel('New story').fill('Tides');
	await page.getByRole('button', { name: 'Create story' }).click();
	await expect(page.locator('.story-title')).toHaveText('Tides');
	const storyUrl = new URL(page.url());
	const slug = storyUrl.pathname.split('/')[2];
	await gotoReady(page, `/stories/${slug}/settings/assistant`);
	const storyBackground = page.getByLabel('Background work');
	await expect(storyBackground).toHaveValue('');
	await expect(storyBackground.locator('option').first()).toHaveText('Default: big-model');
	await storyBackground.selectOption('small-model');
	await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
	await page.reload();
	await expect(page.getByLabel('Background work')).toHaveValue('small-model');
});
