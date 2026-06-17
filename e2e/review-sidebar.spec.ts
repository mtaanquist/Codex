import { expect, test } from '@playwright/test';

// The Review sidebar is the same outline as Write (StoryOutline), so the author
// gets the right-click row menu - rename, duplicate, merge, delete - while
// working through comments, and the guest reviewer gets the same tree read-only
// with no menu at all.

test('the author manages chapters and scenes from the Review sidebar', async ({ page }) => {
	await page.goto('/');
	const stamp = Date.now();
	await page.getByRole('button', { name: 'New universe' }).click();
	await page.getByLabel('New universe').fill(`Sidebar ${stamp}`);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await page.goto('/');
	await page
		.locator('.universe-section', { hasText: `Sidebar ${stamp}` })
		.getByRole('button', { name: 'New story in this universe' })
		.click();
	await page.getByLabel('New story').fill('Outline');
	await page.getByRole('button', { name: 'Create story' }).click();
	await expect(page.locator('.story-title')).toHaveText('Outline');
	await page.getByRole('button', { name: 'New chapter' }).click();
	await page.getByRole('button', { name: 'New scene' }).click();
	await expect(page).toHaveURL(/scene=/);
	const storyPath = new URL(page.url()).pathname;
	await page.locator('.cm-content').click();
	await page.keyboard.type('A line to review.');
	await expect(page.locator('.saved')).toHaveText(/Saved just now/);

	// Into the author's review mode; the sidebar is the shared outline.
	await page.getByRole('link', { name: 'Review', exact: true }).click();
	await expect(page).toHaveURL(`${storyPath}/review`);
	await expect(page.locator('.scene-row')).toHaveCount(1);

	// Right-click a scene row raises the same menu Write uses.
	await page.locator('.scene-row').first().click({ button: 'right' });
	const menu = page.locator('.row-menu');
	await expect(menu).toBeVisible();
	await expect(menu.getByRole('menuitem', { name: 'Duplicate scene' })).toBeVisible();

	// Duplicate adds a second scene in place, no full reload.
	await menu.getByRole('menuitem', { name: 'Duplicate scene' }).click();
	await expect(page.locator('.scene-row')).toHaveCount(2);

	// Right-click the chapter row, rename it from the menu, and see it update.
	await page.locator('.chapter-row').first().click({ button: 'right' });
	await page.locator('.row-menu').getByRole('menuitem', { name: 'Rename chapter' }).click();
	await page.locator('.chapter-rename-input').fill('Act One');
	await page.locator('.chapter-rename').getByRole('button', { name: 'Save' }).click();
	await expect(page.locator('.chapter-name').first()).toHaveText('Act One');
});

test('the guest reviewer gets the outline read-only, with no row menu', async ({
	page,
	browser
}) => {
	await page.goto('/');
	const stamp = Date.now();
	await page.getByRole('button', { name: 'New universe' }).click();
	await page.getByLabel('New universe').fill(`Guestbar ${stamp}`);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await page.goto('/');
	await page
		.locator('.universe-section', { hasText: `Guestbar ${stamp}` })
		.getByRole('button', { name: 'New story in this universe' })
		.click();
	await page.getByLabel('New story').fill('Locked');
	await page.getByRole('button', { name: 'Create story' }).click();
	await page.getByRole('button', { name: 'New chapter' }).click();
	await page.getByRole('button', { name: 'New scene' }).click();
	await expect(page).toHaveURL(/scene=/);
	await page.locator('.cm-content').click();
	await page.keyboard.type('Nothing the guest may restructure.');
	await expect(page.locator('.saved')).toHaveText(/Saved just now/);
	const storyId = page.url().match(/stories\/([^/?]+)/)![1];

	// A review link for an anonymous guest.
	await page.goto(`/stories/${storyId}/settings/review`);
	await page.getByLabel('Who is this link for? (optional)').fill('e2e guest');
	await page.getByRole('button', { name: 'Create review link' }).click();
	const link = await page.locator('.review-link code').textContent();

	const guestContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
	const guest = await guestContext.newPage();
	await guest.goto(link!);
	await guest.getByLabel('Your name').fill('Onlooker');
	await guest.getByRole('button', { name: 'Start reviewing' }).click();
	await expect(guest.locator('.scene-row')).toHaveCount(1);

	// The guest sees the tree but cannot manage it: a right-click raises nothing,
	// and there is no create affordance.
	await guest.locator('.scene-row').first().click({ button: 'right' });
	await expect(guest.locator('.row-menu')).toHaveCount(0);
	await expect(guest.getByRole('button', { name: 'New scene' })).toHaveCount(0);
	await expect(guest.getByRole('button', { name: 'New chapter' })).toHaveCount(0);

	await guestContext.close();
});
