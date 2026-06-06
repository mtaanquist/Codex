import { expect, test } from '@playwright/test';

// Chapter management and the scene trash: rename and reorder chapters from
// the sidebar, delete a scene into the trash, restore it, delete it forever,
// and drop a chapter's scenes to the unfiled list.
test('scene trash and chapter tools', async ({ page }) => {
	page.on('dialog', (dialog) => dialog.accept());

	await page.goto('/');

	const stamp = Date.now();
	await page.getByRole('button', { name: 'New universe' }).click();
	await page.getByLabel('New universe').fill(`Trashfall ${stamp}`);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await page.goto('/');
	await page
		.locator('.universe-section', { hasText: `Trashfall ${stamp}` })
		.getByRole('button', { name: 'New story in this universe' })
		.click();
	await page.getByLabel('New story').fill(`Bins ${stamp}`);
	await page.getByRole('button', { name: 'Create story' }).click();
	await expect(page).toHaveURL(`/stories/bins-${stamp}`);

	// An untitled chapter, renamed through the right-click menu.
	await page.getByRole('button', { name: 'New chapter' }).click();
	await expect(page.locator('.chapter-name')).toHaveText('Chapter 1');
	await page.locator('.chapter-row').click({ button: 'right' });
	await page.getByRole('menuitem', { name: 'Rename chapter' }).click();
	await page.locator('.chapter-rename-input').fill('Act One');
	await page.getByTitle('Save chapter name').click();
	await expect(page.locator('.chapter-name')).toHaveText('Act One');

	// A scene, deleted into the trash. Deleting the open scene closes it.
	await page.getByRole('button', { name: 'New scene' }).click();
	await expect(page.locator('.scene-row')).toHaveCount(1);
	await page.locator('.scene-row').click({ button: 'right' });
	await page.getByRole('menuitem', { name: 'Delete scene' }).click();
	await expect(page).toHaveURL(`/stories/bins-${stamp}`);
	await expect(page.locator('.scene-row')).toHaveCount(0);

	// Restore brings it back into its chapter and opens it.
	await page.getByRole('button', { name: 'Deleted scenes' }).click();
	await page.getByTitle('Restore scene').click();
	await expect(page).toHaveURL(/scene=/);
	await expect(page.locator('.scene-row')).toHaveCount(1);
	await expect(page.locator('.trash')).toHaveCount(0);

	// Delete forever empties the trash for good.
	await page.locator('.scene-row').click({ button: 'right' });
	await page.getByRole('menuitem', { name: 'Delete scene' }).click();
	await page.getByRole('button', { name: 'Deleted scenes' }).click();
	await page.getByTitle('Delete forever').click();
	await expect(page.locator('.trash')).toHaveCount(0);
	await expect(page.locator('.scene-row')).toHaveCount(0);

	// Deleting a chapter drops its scenes to the unfiled list.
	await page.getByRole('button', { name: 'New scene' }).click();
	await page.locator('.chapter-row').first().click({ button: 'right' });
	await page.getByRole('menuitem', { name: 'Delete chapter' }).click();
	await expect(page.locator('.chapter-name', { hasText: 'Act One' })).toHaveCount(0);
	await expect(page.locator('.unfiled-head .chapter-name')).toHaveText('Unfiled scenes');
	await expect(page.locator('.scene-row')).toHaveCount(1);
});
