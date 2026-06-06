import { expect, test } from '@playwright/test';

// The story import round trip: write a story, download its export zip, and
// import the zip back through the universe settings preview flow.
test('story import: preview and import a story export zip', async ({ page }) => {
	await page.goto('/');

	const stamp = Date.now();
	const universeName = `Importland ${stamp}`;
	await page.getByRole('button', { name: 'New universe' }).click();
	await page.getByLabel('New universe').fill(universeName);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText(`${universeName} - settings`);
	await page.goto('/');
	await page
		.locator('.universe-section', { hasText: universeName })
		.getByRole('button', { name: 'New story in this universe' })
		.click();
	await page.getByLabel('New story').fill('Roundtrip');
	await page.getByRole('button', { name: 'Create story' }).click();
	await expect(page.locator('.story-title')).toHaveText('Roundtrip');
	const storySlug = page.url().match(/stories\/([^/?]+)/)![1];

	// One chapter, one scene with prose, and a story note on a character.
	await page.getByRole('button', { name: 'New chapter' }).click();
	await page.getByRole('button', { name: 'New scene' }).click();
	await expect(page).toHaveURL(/scene=/);
	await page.getByPlaceholder('Untitled scene').fill('Tollgate');
	await page.locator('.cm-content').click();
	const save = page.waitForResponse(
		(response) =>
			response.url().includes('/api/scenes/') &&
			response.request().method() === 'PUT' &&
			response.ok() &&
			(response.request().postData() ?? '').includes('They paid in silver.')
	);
	await page.keyboard.type('They paid in silver.');
	await save;

	await page.goto(`/stories/${storySlug}/plan`);
	await page.getByPlaceholder('New character name').fill('Bram');
	await page.getByRole('button', { name: 'Add character' }).click();
	const noteSave = page.waitForResponse(
		(response) =>
			response.url().includes('/api/characters/') &&
			response.request().method() === 'PUT' &&
			response.ok()
	);
	await page.getByPlaceholder('Notes that apply only to this story.').fill('Keeps the gate.');
	await noteSave;

	// Download the export and feed it back through the import form.
	const archive = await page.request.get(`/stories/${storySlug}/export`);
	expect(archive.status()).toBe(200);
	const zipBytes = await archive.body();

	await page.goto(`/universes/importland-${stamp}`);
	await page.getByRole('button', { name: 'Import and export' }).click();
	await page.locator('input[name="archive"]').setInputFiles({
		name: 'roundtrip.zip',
		mimeType: 'application/zip',
		buffer: zipBytes
	});
	await page.getByRole('button', { name: 'Preview' }).click();

	const report = page.locator('.import-report');
	await expect(report).toContainText('"Roundtrip": 1 chapter, 1 scene');
	await expect(report).toContainText('A story named "Roundtrip" already exists');
	await expect(report).toContainText('Bram');
	await expect(report).toContainText('matches an existing entry');

	await page.getByRole('button', { name: 'Import story' }).click();
	await expect(report).toContainText('Imported 1 scene and 1 story note');
	await page.getByRole('link', { name: 'Open the story' }).click();

	// The imported copy carries the chapter, scene, and prose.
	await expect(page.locator('.story-title')).toHaveText('Roundtrip');
	await expect(page.locator('.chapter-name')).toHaveText('Chapter 1');
	await page.locator('.scene-row', { hasText: 'Tollgate' }).click();
	await expect(page.locator('.cm-content')).toContainText('They paid in silver.');
});
