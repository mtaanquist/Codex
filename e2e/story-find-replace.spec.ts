import { expect, test, type Page } from '@playwright/test';
import { gotoReady } from './navigate';
import { pickFromLibraryMenu, startStoryInUniverse } from './library';

// Find and replace across a chapter (#1302): every match is listed before
// anything changes, an unticked match stays, and the change survives a reload
// with a History entry on the scene.

async function typeScene(page: Page, text: string) {
	await page.locator('.cm-content').click();
	const save = page.waitForResponse(
		(response) =>
			response.url().includes('/api/scenes/') &&
			response.request().method() === 'PUT' &&
			response.ok()
	);
	await page.keyboard.type(text);
	await save;
}

test('find and replace across a chapter, with a per-match choice', async ({ page }) => {
	await gotoReady(page, '/');
	const stamp = Date.now();
	await pickFromLibraryMenu(page, 'New universe');
	await page.getByLabel('New universe').fill(`Replacefall ${stamp}`);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await gotoReady(page, '/');
	await startStoryInUniverse(page, `Replacefall ${stamp}`);
	await page.getByLabel('New story').fill(`Villages ${stamp}`);
	await page.getByRole('button', { name: 'Create story' }).click();

	await page.getByRole('button', { name: 'New chapter' }).click();
	await page.getByRole('button', { name: 'New scene' }).click();
	await expect(page).toHaveURL(/scene=/);
	await typeScene(page, 'The city slept. A city woke.');
	await page.getByRole('button', { name: 'New scene' }).click();
	await expect(page.locator('.cm-content')).not.toContainText('slept');
	await typeScene(page, 'The city burned.');

	// The find panel widens the search to the chapter.
	await page.keyboard.press('ControlOrMeta+f');
	const panel = page.locator('.cm-panel.cm-search');
	await panel.getByRole('textbox', { name: 'Find', exact: true }).fill('city');
	await page
		.getByRole('group', { name: 'Search in' })
		.getByRole('button', { name: 'This chapter' })
		.click();

	const dialog = page.getByRole('dialog', { name: 'Find and replace' });
	await expect(dialog.getByRole('status').first()).toContainText('3 matches in 2 scenes');
	await dialog.getByLabel('Replace with').fill('village');
	// Untick the second match of the first scene.
	const firstScene = dialog.locator('.fr-scene').first();
	await firstScene.locator('.fr-match').nth(1).getByRole('checkbox').uncheck();
	await dialog.getByRole('button', { name: 'Replace 2 matches' }).click();
	await expect(dialog).toContainText('Replaced 2 matches in 2 scenes');
	await dialog.getByRole('button', { name: 'Done' }).click();
	await expect(dialog).toHaveCount(0);

	// The open scene shows the new text at once, and it is stored.
	await expect(page.locator('.cm-content')).toContainText('The village burned.');
	await page.reload();
	await expect(page.locator('.cm-content')).toContainText('The village burned.');
	await page.getByRole('tab', { name: 'History' }).click();
	await expect(page.getByText('Replaced "city" with "village"')).toBeVisible();

	// The first scene kept the unticked match.
	await page.locator('.scene-row', { hasText: 'Untitled scene' }).first().click();
	await expect(page.locator('.cm-content')).toContainText('The village slept. A city woke.');
});
