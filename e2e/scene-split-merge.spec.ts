import { expect, test } from '@playwright/test';

// Splitting a scene at the cursor and merging scenes back together from
// the sidebar's right-click menu.
test('split a scene at the cursor, then merge the halves back', async ({ page }) => {
	await page.goto('/');

	const stamp = Date.now();
	await page.getByRole('button', { name: 'New universe' }).click();
	await page.getByLabel('New universe').fill(`Cutfall ${stamp}`);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await page.goto('/');
	await page
		.locator('.universe-section', { hasText: `Cutfall ${stamp}` })
		.getByRole('button', { name: 'New story in this universe' })
		.click();
	await page.getByLabel('New story').fill(`Cuts ${stamp}`);
	await page.getByRole('button', { name: 'Create story' }).click();
	await expect(page).toHaveURL(`/stories/cuts-${stamp}`);

	await page.getByRole('button', { name: 'New chapter' }).click();
	await page.getByRole('button', { name: 'New scene' }).click();
	await expect(page).toHaveURL(/scene=/);

	// Two paragraphs; the cursor lands at the start of the second.
	await page.locator('.cm-content').click();
	await page.keyboard.type('First part stays here.');
	await page.keyboard.press('Enter');
	await page.keyboard.press('Enter');
	await page.keyboard.type('Second part moves out.');
	await expect(page.locator('.saved')).toHaveText(/Saved just now/);
	await page.keyboard.press('Home');

	await page.getByRole('button', { name: 'Split scene at cursor' }).click();

	// The split lands in the new untitled scene holding the second half.
	await expect(page.locator('.scene-row')).toHaveCount(2);
	await expect(page.locator('.cm-content')).toContainText('Second part moves out.');
	await expect(page.locator('.cm-content')).not.toContainText('First part stays here.');

	// Merge them back: select both rows for merging, then merge.
	await page.locator('.scene-row').nth(0).click({ button: 'right' });
	await page.getByRole('menuitem', { name: 'Select for merging' }).click();
	await page.locator('.scene-row').nth(1).click({ button: 'right' });
	await page.getByRole('menuitem', { name: 'Select for merging' }).click();
	await page.locator('.scene-row').nth(0).click({ button: 'right' });
	await page.getByRole('menuitem', { name: 'Merge 2 scenes' }).click();

	// One live scene again, with both halves and a blank line between.
	await expect(page.locator('.scene-row')).toHaveCount(1);
	await expect(page.locator('.cm-content')).toContainText('First part stays here.');
	await expect(page.locator('.cm-content')).toContainText('Second part moves out.');

	// The merged-away scene sits in the trash, restorable.
	await page.getByRole('button', { name: /Deleted scenes/ }).click();
	await expect(page.locator('.trash-row')).toHaveCount(1);
});

// Duplicating a scene from the sidebar's right-click menu, the building
// block for keeping a scene as a reusable template.
test('duplicate a scene from the row menu', async ({ page }) => {
	await page.goto('/');

	const stamp = Date.now();
	await page.getByRole('button', { name: 'New universe' }).click();
	await page.getByLabel('New universe').fill(`Dupes ${stamp}`);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await page.goto('/');
	await page
		.locator('.universe-section', { hasText: `Dupes ${stamp}` })
		.getByRole('button', { name: 'New story in this universe' })
		.click();
	await page.getByLabel('New story').fill(`Copies ${stamp}`);
	await page.getByRole('button', { name: 'Create story' }).click();
	await expect(page).toHaveURL(`/stories/copies-${stamp}`);

	await page.getByRole('button', { name: 'New chapter' }).click();
	await page.getByRole('button', { name: 'New scene' }).click();
	await expect(page).toHaveURL(/scene=/);

	await page.locator('.cm-content').click();
	await page.keyboard.type('Reusable template body.');
	await expect(page.locator('.saved')).toHaveText(/Saved just now/);

	await page.locator('.scene-row').nth(0).click({ button: 'right' });
	await page.getByRole('menuitem', { name: 'Duplicate scene' }).click();

	// Two scenes now, and the editor is on the copy with the same prose.
	await expect(page.locator('.scene-row')).toHaveCount(2);
	await expect(page.locator('.cm-content')).toContainText('Reusable template body.');
});
