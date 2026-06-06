import { expect, test } from '@playwright/test';

// A scene rename must survive a browser reload, even one inside the
// autosave debounce window: the pending edit is flushed on the way out.
// The flush races the reloading page's own load, so the assertion allows
// a second reload rather than demanding the very first paint win.
test('scene title survives a reload', async ({ page }) => {
	await page.goto('/');

	const stamp = Date.now();
	await page.getByRole('button', { name: 'New universe' }).click();
	await page.getByLabel('New universe').fill(`Titlefall ${stamp}`);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await page.goto('/');
	await page
		.locator('.universe-section', { hasText: `Titlefall ${stamp}` })
		.getByRole('button', { name: 'New story in this universe' })
		.click();
	await page.getByLabel('New story').fill(`Names ${stamp}`);
	await page.getByRole('button', { name: 'Create story' }).click();
	await expect(page).toHaveURL(`/stories/names-${stamp}`);

	await page.getByRole('button', { name: 'New chapter' }).click();
	await page.getByRole('button', { name: 'New scene' }).click();
	await expect(page).toHaveURL(/scene=/);

	// Reload before the debounced autosave fires; the rename must not be lost.
	await page.locator('.editor-title-input').fill('The Hook');
	await page.reload();
	await expect(async () => {
		await page.reload();
		await expect(page.locator('.editor-title-input')).toHaveValue('The Hook');
	}).toPass({ timeout: 15_000 });
});

// Opening a story without naming a scene resumes the one edited last.
test('opening a story resumes the last-edited scene', async ({ page }) => {
	await page.goto('/');

	const stamp = Date.now();
	await page.getByRole('button', { name: 'New universe' }).click();
	await page.getByLabel('New universe').fill(`Resumefall ${stamp}`);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await page.goto('/');
	await page
		.locator('.universe-section', { hasText: `Resumefall ${stamp}` })
		.getByRole('button', { name: 'New story in this universe' })
		.click();
	await page.getByLabel('New story').fill(`Bookmarks ${stamp}`);
	await page.getByRole('button', { name: 'Create story' }).click();
	await expect(page).toHaveURL(`/stories/bookmarks-${stamp}`);

	// Two scenes; the second one gets the most recent edit.
	await page.getByRole('button', { name: 'New chapter' }).click();
	await page.getByRole('button', { name: 'New scene' }).click();
	await expect(page).toHaveURL(/scene=/);
	await page.getByRole('button', { name: 'New scene' }).click();
	await expect(page.locator('.scene-row')).toHaveCount(2);
	const saved = page.waitForResponse(
		(response) => response.url().includes('/api/scenes/') && response.request().method() === 'PUT'
	);
	await page.locator('.editor-title-input').fill('Second thoughts');
	await saved;

	// Landing on the bare story URL opens that scene again.
	await page.goto(`/stories/bookmarks-${stamp}`);
	await expect(page.locator('.editor-title-input')).toHaveValue('Second thoughts');

	// The sidebar filter narrows the tree by name; clearing restores it.
	await page.getByLabel('Filter chapters and scenes...').fill('second');
	await expect(page.locator('.scene-row')).toHaveCount(1);
	await expect(page.locator('.scene-row .scene-name')).toHaveText('Second thoughts');
	await page.getByLabel('Filter chapters and scenes...').fill('zzz-no-such-scene');
	await expect(page.locator('.search-empty')).toBeVisible();
	await page.getByRole('button', { name: 'Clear' }).click();
	await expect(page.locator('.scene-row')).toHaveCount(2);
});
