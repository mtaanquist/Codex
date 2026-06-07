import { expect, test } from '@playwright/test';

// The Notes view: reach it from the editor's Notes toggle, write a note that
// persists, pin it, and confirm a story note shows under the universe view's
// reach via the "From the universe" peek.
test('write, persist, and pin a story note', async ({ page }) => {
	page.on('dialog', (dialog) => dialog.accept());

	await page.goto('/');

	const stamp = Date.now();
	await page.getByRole('button', { name: 'New universe' }).click();
	await page.getByLabel('New universe').fill(`Notefall ${stamp}`);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await page.goto('/');
	await page
		.locator('.universe-section', { hasText: `Notefall ${stamp}` })
		.getByRole('button', { name: 'New story in this universe' })
		.click();
	await page.getByLabel('New story').fill(`Logs ${stamp}`);
	await page.getByRole('button', { name: 'Create story' }).click();
	await expect(page).toHaveURL(`/stories/logs-${stamp}`);

	// The Notes toggle now works (it used to be disabled).
	await page.getByRole('link', { name: 'Notes' }).click();
	await expect(page).toHaveURL(`/stories/logs-${stamp}/notes`);

	await page.getByRole('button', { name: 'New note' }).click();
	await expect(page).toHaveURL(/note=/);

	await page.getByPlaceholder('Untitled note').fill('Session 1');
	await page.locator('.cm-content').click();
	await page.keyboard.type('The party met at the Broken Crown.');
	await expect(page.locator('.saved')).toHaveText(/Saved just now/);

	// It survives a reload.
	await page.reload();
	await expect(page.getByPlaceholder('Untitled note')).toHaveValue('Session 1');
	await expect(page.locator('.cm-content')).toContainText('The party met at the Broken Crown.');

	// Pin it; it lands under the Pinned group in the sidebar.
	await page.getByRole('button', { name: 'Pin' }).click();
	await expect(page.locator('.group-label', { hasText: 'Pinned' })).toBeVisible();

	// A universe note shows in the story view under "From the universe".
	await page.goto(`/universes/notefall-${stamp}/notes`);
	await page.getByRole('button', { name: 'New note' }).click();
	await page.getByPlaceholder('Untitled note').fill('World fact');
	await expect(page.locator('.saved')).toHaveText(/Saved just now/);

	await page.goto(`/stories/logs-${stamp}/notes`);
	await expect(page.locator('.group-label', { hasText: 'From the universe' })).toBeVisible();
	await expect(page.locator('.note-row', { hasText: 'World fact' })).toBeVisible();
});
