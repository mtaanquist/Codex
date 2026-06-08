import { expect, test } from '@playwright/test';

// The read-only entity card: hovering a mention and choosing "Open full
// details" replaces the right column with the entity's card; Back returns
// to the tabs.
test('entity card: open from a mention, then back to the tabs', async ({ page }) => {
	await page.goto('/');

	const universeName = `Card Test ${Date.now()}`;
	await page.getByRole('button', { name: 'New universe' }).click();
	await page.getByLabel('New universe').fill(universeName);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText(`${universeName} - settings`);
	await page.goto('/');
	await page
		.locator('.universe-section', { hasText: universeName })
		.getByRole('button', { name: 'New story in this universe' })
		.click();
	await page.getByLabel('New story').fill('Cards');
	await page.getByRole('button', { name: 'Create story' }).click();
	await expect(page.locator('.story-title')).toHaveText('Cards');
	await page.getByRole('button', { name: 'New chapter' }).click();
	await expect(page.locator('.chapter-name')).toHaveText('Chapter 1');
	await page.getByRole('button', { name: 'New scene' }).click();
	await expect(page).toHaveURL(/scene=/);

	// Write a name and make it a character; it underlines in place.
	await page.locator('.cm-content').click();
	await page.keyboard.type('Veylan');
	await expect(page.locator('.saved')).toHaveText(/Saved just now/);
	await page.keyboard.press('ControlOrMeta+a');
	await page.locator('.cm-content').click({ button: 'right' });
	await expect(page.locator('.sel-menu')).toBeVisible();
	await page.getByRole('menuitem', { name: 'New character' }).click();
	const mention = page.locator('.cm-content .ref-word', { hasText: 'Veylan' });
	await expect(mention).toBeVisible();

	// Hover the mention and open its full details: the card takes over the
	// right column.
	await mention.hover();
	const openLink = page.getByText('Open full details');
	await expect(openLink).toBeVisible();
	await openLink.click();

	const card = page.locator('.inspector');
	await expect(card).toBeVisible();
	await expect(card.locator('.insp-name')).toHaveText('Veylan');
	await expect(card.locator('.insp-open')).toBeVisible();
	// The tabs are replaced while the card is open.
	await expect(page.locator('.rtabs')).toHaveCount(0);

	// Back returns to the tabbed panel.
	await card.locator('.back-btn').click();
	await expect(card).toHaveCount(0);
	await expect(page.locator('.rtabs')).toBeVisible();
});
