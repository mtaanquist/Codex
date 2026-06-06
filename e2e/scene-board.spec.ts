import { expect, test } from '@playwright/test';

// The scene board: a story's plan shows its scenes in status lanes, and
// moving a card changes the scene's status for good.
test('scene board: a card moves along the status ladder and stays there', async ({ page }) => {
	await page.goto('/');

	const universeName = `Board Test ${Date.now()}`;
	await page.getByRole('button', { name: 'New universe' }).click();
	await page.getByLabel('New universe').fill(universeName);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText(`${universeName} - settings`);
	await page.goto('/');
	await page
		.locator('.universe-section', { hasText: universeName })
		.getByRole('button', { name: 'New story in this universe' })
		.click();
	await page.getByLabel('New story').fill('Lanes');
	await page.getByRole('button', { name: 'Create story' }).click();
	await expect(page.locator('.story-title')).toHaveText('Lanes');
	const storyId = page.url().match(/stories\/([^/?]+)/)![1];

	// One scene with a title and a few words.
	await page.getByRole('button', { name: 'New chapter' }).click();
	await expect(page.locator('.chapter-name')).toHaveText('Chapter 1');
	await page.getByRole('button', { name: 'New scene' }).click();
	await expect(page).toHaveURL(/scene=/);
	await page.getByPlaceholder('Untitled scene').fill('The crossing');
	await page.locator('.cm-content').click();
	// Leaving the title field flushes a title-only save, so wait for the
	// save that actually carries the prose.
	const save = page.waitForResponse(
		(response) =>
			response.url().includes('/api/scenes/') &&
			response.request().method() === 'PUT' &&
			response.ok() &&
			(response.request().postData() ?? '').includes('Across they went.')
	);
	await page.keyboard.type('Across they went.');
	await save;

	// The plan opens on the board; a new scene starts in Draft.
	await page.goto(`/stories/${storyId}/plan`);
	const draftLane = page.getByRole('region', { name: 'Draft scenes' });
	const card = page.locator('.card', { hasText: 'The crossing' });
	await expect(draftLane.locator('.card', { hasText: 'The crossing' })).toBeVisible();
	await expect(card).toContainText('3 words');

	// The card's arrow moves it to Revised, and the move sticks.
	await card.hover();
	await card.getByRole('button', { name: 'Move to Revised' }).click();
	const revisedLane = page.getByRole('region', { name: 'Revised scenes' });
	await expect(revisedLane.locator('.card', { hasText: 'The crossing' })).toBeVisible();
	await page.reload();
	await expect(revisedLane.locator('.card', { hasText: 'The crossing' })).toBeVisible();

	// The card's title opens the scene in the editor.
	await page.locator('.card-title', { hasText: 'The crossing' }).click();
	await expect(page).toHaveURL(/scene=/);
	await expect(page.getByPlaceholder('Untitled scene')).toHaveValue('The crossing');

	// Opening an entity replaces the board; the pinned sidebar row brings
	// it back. The right pane keeps the same three pills either way.
	await page.goto(`/stories/${storyId}/plan`);
	await expect(page.getByRole('button', { name: 'Reference' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'History' })).toBeVisible();
	await page.getByPlaceholder('New character name').fill('Ferry');
	await page.getByRole('button', { name: 'Add character' }).click();
	await expect(page).toHaveURL(/entity=/);
	await expect(page.locator('.board')).toHaveCount(0);
	await page.getByRole('link', { name: 'Scene board' }).click();
	await expect(revisedLane.locator('.card', { hasText: 'The crossing' })).toBeVisible();

	// The universe plan shows the story board: this story sits in the lane
	// of its derived status, and its card opens the story.
	const universeSlug = `board-test-${universeName.split(' ').pop()}`;
	await page.goto(`/universes/${universeSlug}/plan`);
	const revisingLane = page.getByRole('region', { name: 'Revising stories' });
	await expect(revisingLane.locator('.card', { hasText: 'Lanes' })).toBeVisible();
	await page.locator('.card-title', { hasText: 'Lanes' }).click();
	await expect(page.locator('.story-title')).toHaveText('Lanes');

	// The book switcher: a second story in the universe makes the sidebar
	// header a menu that jumps between them.
	await page.goto('/');
	await page
		.locator('.universe-section', { hasText: universeName })
		.getByRole('button', { name: 'New story in this universe' })
		.click();
	await page.getByLabel('New story').fill('Detours');
	await page.getByRole('button', { name: 'Create story' }).click();
	await expect(page.locator('.story-title')).toHaveText('Detours');
	await page.locator('.story-switch').click();
	await page.locator('.story-menu button', { hasText: 'Lanes' }).click();
	await expect(page.locator('.story-title')).toHaveText('Lanes');
	await expect(page).toHaveURL(/\/stories\/lanes/);
});
