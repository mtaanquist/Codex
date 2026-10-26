import { expect, test } from '@playwright/test';
import { gotoReady } from './navigate';
import { pickFromLibraryMenu, startStoryInUniverse } from './library';

// A scene that mentions nothing yet tells the writer what fills the
// Reference panel.
test('an empty Reference panel says how to fill it', async ({ page }) => {
	await gotoReady(page, '/');
	const universeName = `Reference ${Date.now()}`;
	await pickFromLibraryMenu(page, 'New universe');
	await page.getByLabel('New universe').fill(universeName);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText(`${universeName} - settings`);
	await gotoReady(page, '/');
	await startStoryInUniverse(page, universeName);
	await page.getByLabel('New story').fill('Empty');
	await page.getByRole('button', { name: 'Create story' }).click();
	await expect(page.locator('.story-title')).toHaveText('Empty');
	await page.getByRole('button', { name: 'New chapter' }).click();
	await page.getByRole('button', { name: 'New scene' }).click();
	await expect(page).toHaveURL(/scene=/);

	await page.getByRole('tab', { name: 'Reference' }).click();
	await expect(page.getByRole('tabpanel')).toContainText(
		'Name a character, place, or other Plan entry in this scene and it shows up here.'
	);
});
