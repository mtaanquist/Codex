import { expect, test } from '@playwright/test';

// The library dashboard: universe sections with story cards, the per-universe
// new-story card, the Recent row, and the status pill.
test('dashboard: universe sections, story cards, and the new-story card', async ({ page }) => {
	await page.goto('/');

	const stamp = Date.now();
	await page.getByRole('button', { name: 'New universe' }).click();
	await page.getByLabel('New universe').fill(`Shelffall ${stamp}`);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await expect(page).toHaveURL(`/universes/shelffall-${stamp}`);

	// The new universe has its own section with a new-story card.
	await page.goto('/');
	const section = page.locator('.universe-section', { hasText: `Shelffall ${stamp}` });
	await expect(section.locator('.universe-mark')).toHaveText('Universe');
	await section.getByRole('button', { name: 'New story in this universe' }).click();
	await page.getByLabel('New story').fill(`Shelved ${stamp}`);
	await page.getByRole('button', { name: 'Create story' }).click();
	await expect(page).toHaveURL(`/stories/shelved-${stamp}`);

	// Its card shows up in the section and in Recent, outlining with no prose.
	await page.goto('/');
	const card = section.locator('.story-card', { hasText: `Shelved ${stamp}` });
	await expect(card).toHaveCount(1);
	await expect(card.locator('.story-card-status')).toHaveText(/Outlining/);
	await expect(card.locator('.story-card-meta')).toContainText('edited just now');
	await expect(
		page.locator('.recent-row .story-card', { hasText: `Shelved ${stamp}` })
	).toHaveCount(1);

	// The card opens the story.
	await card.click();
	await expect(page).toHaveURL(`/stories/shelved-${stamp}`);
});
