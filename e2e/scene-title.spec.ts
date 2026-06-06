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
