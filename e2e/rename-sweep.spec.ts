import { expect, test } from '@playwright/test';

// Renaming an entity offers to sweep the old name out of the prose: the
// banner counts what it will touch, Replace rewrites the scenes, and the
// editor shows the new name.
test('a rename offers to replace the old name in the prose', async ({ page }) => {
	await page.goto('/');

	const stamp = Date.now();
	await page.getByRole('button', { name: 'New universe' }).click();
	await page.getByLabel('New universe').fill(`Renamefall ${stamp}`);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await page.goto('/');
	await page
		.locator('.universe-section', { hasText: `Renamefall ${stamp}` })
		.getByRole('button', { name: 'New story in this universe' })
		.click();
	await page.getByLabel('New story').fill(`Sweeps ${stamp}`);
	await page.getByRole('button', { name: 'Create story' }).click();
	await expect(page).toHaveURL(`/stories/sweeps-${stamp}`);

	// Prose that names the character twice, plus a lookalike that must stay.
	await page.getByRole('button', { name: 'New chapter' }).click();
	await page.getByRole('button', { name: 'New scene' }).click();
	await expect(page).toHaveURL(/scene=/);
	await page.locator('.cm-content').click();
	const save = page.waitForResponse(
		(response) =>
			response.url().includes('/api/scenes/') &&
			response.request().method() === 'PUT' &&
			response.ok() &&
			(response.request().postData() ?? '').includes('Veyrafall')
	);
	await page.keyboard.type('Veyra rode out. Veyra never reached Veyrafall.');
	await save;

	// Create the character, then rename it; the banner offers the sweep.
	await page.getByRole('link', { name: 'Plan' }).click();
	await page.getByPlaceholder('New character name').fill('Veyra');
	await page.getByRole('button', { name: 'Add character' }).click();
	await expect(page).toHaveURL(/entity=/);
	await page.getByPlaceholder('Name', { exact: true }).fill('Maren');
	const offer = page.locator('.rename-offer');
	await expect(offer).toContainText('Renamed from "Veyra"');
	await expect(offer).toContainText('2 places in 1 scene');

	// Replace rewrites the prose; the lookalike word survives.
	await offer.getByRole('button', { name: 'Replace' }).click();
	await expect(offer).toHaveCount(0);
	await page.getByRole('link', { name: 'Write' }).click();
	await expect(page.locator('.cm-content')).toContainText(
		'Maren rode out. Maren never reached Veyrafall.'
	);
});
