import { expect, test } from '@playwright/test';

// The universe settings page: contents tiles, the category manager, the
// history panel, the export download, and the trash round trip.
test('universe settings: contents, categories, history, export, and the trash', async ({
	page
}) => {
	page.on('dialog', (dialog) => dialog.accept());
	await page.goto('/');

	const stamp = Date.now();
	const name = `Settle ${stamp}`;
	await page.getByRole('button', { name: 'New universe' }).click();
	await page.getByLabel('New universe').fill(name);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await expect(page).toHaveURL(`/universes/settle-${stamp}`);
	await expect(page.getByRole('heading', { level: 1 })).toHaveText(`${name} - settings`);

	// Contents: the five tiles, all empty so far except the seeded category.
	await expect(page.locator('.stat-tile')).toHaveCount(5);
	await expect(page.locator('.stat-tile').first()).toContainText('stories');

	// Categories: rename a seeded one, add a third, save, all persist.
	// New universes seed "Lore" and "Faction".
	await page.getByRole('button', { name: 'Entity categories' }).click();
	await expect(page.locator('.category-name-input')).toHaveCount(2);
	await expect(page.locator('.category-name-input').nth(0)).toHaveValue('Lore');
	await expect(page.locator('.category-name-input').nth(1)).toHaveValue('Faction');
	await page.locator('.category-name-input').first().fill('Mythos');
	await page.getByRole('button', { name: 'Add category' }).click();
	await page.locator('.category-name-input').nth(2).fill('Spells');
	await page.getByRole('button', { name: 'Save categories' }).click();
	await expect(page.locator('.category-name-input')).toHaveCount(3);
	await expect(page.locator('.category-name-input').nth(0)).toHaveValue('Mythos');
	await expect(page.locator('.category-name-input').nth(1)).toHaveValue('Faction');
	await expect(page.locator('.category-name-input').nth(2)).toHaveValue('Spells');

	// History: a worldbuilding change shows up with its kind chip. Creating
	// alone records nothing; the first edit does.
	await page.goto(`/universes/settle-${stamp}/plan`);
	await page.getByPlaceholder('New character name').fill('Histor');
	await page.getByRole('button', { name: 'Add character' }).click();
	await expect(page.locator('.ent-row', { hasText: 'Histor' })).toBeVisible();
	const entitySave = page.waitForResponse(
		(response) =>
			response.url().includes('/api/characters/') &&
			response.request().method() === 'PUT' &&
			response.ok()
	);
	await page
		.getByPlaceholder('One or two lines. Shown when a mention is hovered.')
		.fill('Keeper of the record.');
	await entitySave;
	await page.goto(`/universes/settle-${stamp}`);
	await page.getByRole('button', { name: 'History' }).click();
	const entry = page.locator('.revision-entry', { hasText: 'Histor' }).first();
	await expect(entry).toBeVisible();
	await expect(entry.locator('.revision-source-kind')).toHaveText('Character');
	await page.getByRole('button', { name: 'Checkpoints only' }).click();
	await expect(page.locator('.revision-entry', { hasText: 'Histor' })).toHaveCount(0);
	await page.getByRole('button', { name: 'All', exact: true }).click();

	// Export: the archive downloads.
	const archive = await page.request.get(`/universes/settle-${stamp}/export`);
	expect(archive.status()).toBe(200);
	expect(archive.headers()['content-type']).toBe('application/zip');

	// The trash round trip: delete, restore from the library, delete forever.
	await page.getByRole('button', { name: 'Export and deletion' }).click();
	await page.getByRole('button', { name: 'Delete universe' }).click();
	await expect(page).toHaveURL('/');
	const trashRow = page.locator('.trash-uni', { hasText: name });
	await expect(trashRow).toBeVisible();
	await expect(page.locator('.universe-name', { hasText: name })).toHaveCount(0);
	await trashRow.getByRole('button', { name: 'Restore' }).click();
	await expect(page.locator('.universe-name', { hasText: name })).toHaveCount(1);
	await expect(page.locator('.trash-uni', { hasText: name })).toHaveCount(0);

	// Gone for good.
	await page.goto(`/universes/settle-${stamp}`);
	await page.getByRole('button', { name: 'Export and deletion' }).click();
	await page.getByRole('button', { name: 'Delete universe' }).click();
	await expect(page).toHaveURL('/');
	await page
		.locator('.trash-uni', { hasText: name })
		.getByRole('button', { name: 'Delete forever' })
		.click();
	await expect(page.locator('.trash-uni', { hasText: name })).toHaveCount(0);
	const gone = await page.goto(`/universes/settle-${stamp}`);
	expect(gone!.status()).toBe(404);
});
