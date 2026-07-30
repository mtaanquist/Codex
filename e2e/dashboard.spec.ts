import { expect, test } from '@playwright/test';
import { gotoReady } from './navigate';
import { pickFromLibraryMenu, startStoryInUniverse } from './library';

// The library dashboard: universe sections with story cards, the per-universe
// New story menu, the Recent row, and the status pill.
test('dashboard: universe sections, story cards, and the New story menu', async ({ page }) => {
	await gotoReady(page, '/');

	const stamp = Date.now();
	await pickFromLibraryMenu(page, 'New universe');
	await page.getByLabel('New universe').fill(`Shelffall ${stamp}`);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await expect(page).toHaveURL(`/universes/shelffall-${stamp}`);

	// The new universe has its own section, and an empty one offers the same
	// menu in the space its stories will fill.
	await gotoReady(page, '/');
	const section = page.locator('.universe-section', { hasText: `Shelffall ${stamp}` });
	await expect(section.locator('.universe-mark')).toHaveAttribute('title', 'Universe');
	await expect(section.locator('.collection-empty')).toHaveCount(1);
	await startStoryInUniverse(page, `Shelffall ${stamp}`);
	await page.getByLabel('New story').fill(`Shelved ${stamp}`);
	await page.getByRole('button', { name: 'Create story' }).click();
	await expect(page).toHaveURL(`/stories/shelved-${stamp}`);

	// Its card shows up in the section and in Recent, outlining with no prose.
	await gotoReady(page, '/');
	const card = section.locator('.story-card', { hasText: `Shelved ${stamp}` });
	await expect(card).toHaveCount(1);
	await expect(card.locator('.story-card-status')).toHaveText(/Outlining/);
	await expect(card.locator('.story-card-meta')).toContainText('edited just now');
	await expect(
		page.locator('.recent-row .story-card', { hasText: `Shelved ${stamp}` })
	).toHaveCount(1);

	// One creation pattern: nothing says "import" until a New menu is open, and a
	// populated grid has no dashed add tile.
	await expect(section.locator('.collection-empty')).toHaveCount(0);
	await expect(section.locator('.card-add')).toHaveCount(0);
	await expect(page.getByText('Import a story from a file')).toHaveCount(0);
	await section.getByRole('button', { name: 'New story', exact: true }).click();
	await expect(
		page.getByRole('menuitem', { name: 'Import a story into this universe...' })
	).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(page.getByRole('menuitem', { name: 'New story in Shelffall' })).toHaveCount(0);

	// The library header makes both kinds of thing, and imports, from one menu.
	await page.getByRole('button', { name: 'New', exact: true }).click();
	for (const item of ['New universe', 'New standalone story', 'Import a story from a file...']) {
		await expect(page.getByRole('menuitem', { name: item })).toBeVisible();
	}
	await page.keyboard.press('Escape');

	// The card opens the story.
	await card.click();
	await expect(page).toHaveURL(`/stories/shelved-${stamp}`);
});
