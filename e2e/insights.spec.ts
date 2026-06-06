import { expect, test } from '@playwright/test';

// The universe Insights view: progress stats and the world heatmap render
// from a fresh universe's first words.
test('insights: words written show up in progress and the heatmap', async ({ page }) => {
	await page.goto('/');

	const universeName = `Insights Test ${Date.now()}`;
	await page.getByRole('button', { name: 'New universe' }).click();
	await page.getByLabel('New universe').fill(universeName);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText(`${universeName} - settings`);
	const universeId = page.url().match(/universes\/([^/?]+)/)![1];
	await page.goto('/');
	await page
		.locator('.universe-section', { hasText: universeName })
		.getByRole('button', { name: 'New story in this universe' })
		.click();
	await page.getByLabel('New story').fill('First Light');
	await page.getByRole('button', { name: 'Create story' }).click();
	await expect(page.locator('.story-title')).toHaveText('First Light');
	const storyRef = page.url().match(/stories\/([^/?]+)/)![1];

	// Write a few words so there is something to count.
	await page.getByRole('button', { name: 'New chapter' }).click();
	await expect(page.locator('.chapter-name')).toHaveText('Chapter 1');
	await page.getByRole('button', { name: 'New scene' }).click();
	await expect(page).toHaveURL(/scene=/);
	await page.locator('.cm-content').click();
	const save = page.waitForResponse(
		(response) =>
			response.url().includes('/api/scenes/') &&
			response.request().method() === 'PUT' &&
			response.ok()
	);
	await page.keyboard.type('Five words went down today.');
	await save;

	// A character no scene mentions, for the cold end of the heatmap.
	await page.goto(`/universes/${universeId}/plan`);
	await page.getByPlaceholder('New character name').fill('Heimdall');
	await page.getByRole('button', { name: 'Add character' }).click();
	await expect(page.locator('.ent-row', { hasText: 'Heimdall' })).toBeVisible();

	// A sibling pair, for the relationship web.
	await page.getByPlaceholder('New character name').fill('Freya');
	await page.getByRole('button', { name: 'Add character' }).click();
	await page.locator('.ent-row', { hasText: 'Heimdall' }).click();
	await page.getByRole('button', { name: '+ Add relationship' }).click();
	await page.getByLabel('Relation').selectOption({ label: 'sibling of' });
	await page.getByLabel('Related entity').selectOption({ label: 'Freya' });
	await page.getByRole('button', { name: 'Add', exact: true }).click();
	await expect(page.locator('.rel-row', { hasText: 'Freya' })).toBeVisible();

	// The right pane's Session tab carries the short version, and links to
	// the full view.
	await page.getByRole('button', { name: 'Session' }).click();
	await expect(page.locator('.sess-n').first()).not.toHaveText('0');
	await expect(page.locator('.streak-day.today')).toBeVisible();
	await page.getByRole('link', { name: 'All insights' }).click();
	await expect(page.getByRole('heading', { name: 'Insights' })).toBeVisible();

	// Progress counts the words; the story row carries them too.
	await expect(page.locator('.admin-stat', { hasText: 'Total words' })).toContainText('5');
	await expect(page.getByRole('link', { name: 'First Light' })).toBeVisible();
	await expect(page.locator('.story-row', { hasText: 'First Light' })).toContainText('5 words');

	// The unmentioned character sits cold on the heatmap.
	const tile = page.locator('.heat-tile', { hasText: 'Heimdall' });
	await expect(tile).toContainText('Not mentioned yet');

	// The relationship web draws the sibling pair.
	const web = page.locator('svg.web');
	await expect(web.locator('.web-name', { hasText: 'Heimdall' })).toBeVisible();
	await expect(web.locator('.web-name', { hasText: 'Freya' })).toBeVisible();

	// The heat tile links to the plan entry.
	await tile.click();
	await expect(page.getByPlaceholder('Name', { exact: true })).toHaveValue('Heimdall');

	// The story plan lists the universe's other entities behind a fold.
	await page.goto(`/stories/${storyRef}/plan`);
	await page.getByRole('button', { name: 'In the universe' }).first().click();
	await page.locator('.uni-row', { hasText: 'Heimdall' }).click();
	await expect(page.getByPlaceholder('Name', { exact: true })).toHaveValue('Heimdall');
});
