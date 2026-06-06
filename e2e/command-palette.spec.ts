import { expect, test } from '@playwright/test';

// The command palette: Ctrl+K opens it anywhere, search jumps to what it
// finds, and the contextual commands act on the open story.
test('command palette: search jumps to a story, commands create a scene', async ({ page }) => {
	await page.goto('/');

	const universeName = `Palette Test ${Date.now()}`;
	await page.getByRole('button', { name: 'New universe' }).click();
	await page.getByLabel('New universe').fill(universeName);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText(universeName);
	const storyTitle = `Needle ${Date.now()}`;
	await page.getByLabel('New story').fill(storyTitle);
	await page.getByRole('button', { name: 'Create story' }).click();
	await expect(page.locator('.story-title')).toHaveText(storyTitle);

	// From the library, the topbar button opens the palette; search finds
	// the story and opens it.
	await page.goto('/');
	await page.getByRole('button', { name: /Search and commands/ }).click();
	await page.getByLabel('Search everything').fill(storyTitle);
	await expect(page.getByRole('option', { name: new RegExp(`Story ${storyTitle}`) })).toBeVisible();
	await page.getByRole('option', { name: new RegExp(`Story ${storyTitle}`) }).click();
	await expect(page.locator('.story-title')).toHaveText(storyTitle);

	// On the story, the palette's commands act on it: a new scene appears.
	await page.getByRole('button', { name: /Search and commands/ }).click();
	await page.getByLabel('Search everything').fill('new scene');
	await page.getByRole('option', { name: 'Command New scene' }).click();
	await expect(page).toHaveURL(/scene=/);

	// Escape closes the palette without acting.
	await page.keyboard.press('ControlOrMeta+k');
	await expect(page.getByLabel('Search everything')).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(page.getByLabel('Search everything')).not.toBeVisible();
});
