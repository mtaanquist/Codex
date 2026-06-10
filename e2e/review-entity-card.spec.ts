import { expect, test } from '@playwright/test';

// In review mode an entity mention is a click-to-open quick card: the same
// summary a reviewer sees. Here the author opens it from their own review,
// where the card also offers the full-details link.
test('review: clicking an entity mention opens its quick card', async ({ page }) => {
	await page.goto('/');
	const stamp = Date.now();
	await page.getByRole('button', { name: 'New universe' }).click();
	await page.getByLabel('New universe').fill(`Review cards ${stamp}`);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await page.goto('/');
	await page
		.locator('.universe-section', { hasText: `Review cards ${stamp}` })
		.getByRole('button', { name: 'New story in this universe' })
		.click();
	await page.getByLabel('New story').fill('Cast');
	await page.getByRole('button', { name: 'Create story' }).click();
	await expect(page.locator('.story-title')).toHaveText('Cast');
	await page.getByRole('button', { name: 'New chapter' }).click();
	await page.getByRole('button', { name: 'New scene' }).click();
	await expect(page).toHaveURL(/scene=/);
	const storyPath = new URL(page.url()).pathname;

	// Write a name and turn it into a character; it underlines in place.
	await page.locator('.cm-content').click();
	await page.keyboard.type('Veylan');
	await expect(page.locator('.saved')).toHaveText(/Saved just now/);
	await page.keyboard.press('ControlOrMeta+a');
	await page.locator('.cm-content').click({ button: 'right' });
	await expect(page.locator('.sel-menu')).toBeVisible();
	await page.getByRole('menuitem', { name: 'New character' }).click();
	await expect(page.locator('.cm-content .ref-word', { hasText: 'Veylan' })).toBeVisible();

	// Enter review mode; the name renders as a clickable mention.
	await page.getByRole('link', { name: 'Review', exact: true }).click();
	await expect(page).toHaveURL(`${storyPath}/review`);
	const mention = page.locator('.review-prose .ref-word', { hasText: 'Veylan' });
	await expect(mention).toBeVisible();

	// Clicking it opens the quick card with the entity's name; the author's card
	// offers the full-details link (a reviewer's would not).
	await mention.click();
	const card = page.locator('.rv-cardpop');
	await expect(card).toBeVisible();
	await expect(card.locator('.pop-name')).toHaveText('Veylan');
	await expect(card.locator('.pop-open')).toBeVisible();

	// Escape dismisses it.
	await page.keyboard.press('Escape');
	await expect(card).toHaveCount(0);
});
