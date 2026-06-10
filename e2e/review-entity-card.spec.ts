import { expect, test } from '@playwright/test';

// In the author's review mode an entity mention is a hover card in the live
// editor: the same summary a reviewer sees, plus the full-details link.
test('review: hovering an entity mention opens its quick card', async ({ page }) => {
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

	// Enter review mode; the name renders as an underlined mention in the editor.
	await page.getByRole('link', { name: 'Review', exact: true }).click();
	await expect(page).toHaveURL(`${storyPath}/review`);
	const mention = page.locator('.review-edit .cm-content .ref-word', { hasText: 'Veylan' });
	await expect(mention).toBeVisible();

	// Hovering it opens the quick card with the entity's name; the author's card
	// offers the full-details link (a reviewer's would not).
	await mention.hover();
	const card = page.locator('.entity-card');
	await expect(card).toBeVisible();
	await expect(card.locator('.pop-name')).toHaveText('Veylan');
	await expect(card.locator('.pop-open')).toBeVisible();

	// Moving the pointer away dismisses it.
	await page.mouse.move(2, 2);
	await expect(card).toHaveCount(0);
});
