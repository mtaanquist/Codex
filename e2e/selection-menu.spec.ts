import { expect, test } from '@playwright/test';

// The editor's right-click selection menu: create an entity from the
// selected text without leaving the page, and quick-format the selection.
test('selection menu: create a character from a selection, then bold it', async ({ page }) => {
	await page.goto('/');

	const universeName = `Selection Test ${Date.now()}`;
	await page.getByRole('button', { name: 'New universe' }).click();
	await page.getByLabel('New universe').fill(universeName);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText(universeName);
	const universeId = page.url().match(/universes\/([^/?]+)/)![1];
	await page.getByLabel('New story').fill('Selections');
	await page.getByRole('button', { name: 'Create story' }).click();
	await expect(page.locator('.story-title')).toHaveText('Selections');

	await page.getByRole('button', { name: 'New chapter' }).click();
	await expect(page.locator('.chapter-name')).toHaveText('Chapter 1');
	await page.getByRole('button', { name: 'New scene' }).click();
	await expect(page).toHaveURL(/scene=/);
	await page.locator('.cm-content').click();
	await page.keyboard.type('Veylan');
	await expect(page.locator('.saved')).toHaveText(/Saved just now/);

	// Select the name and create a character from it. The menu closes, the
	// page stays put, and the new name underlines in place.
	await page.keyboard.press('ControlOrMeta+a');
	await page.locator('.cm-content').click({ button: 'right' });
	await expect(page.locator('.sel-menu')).toBeVisible();
	await page.getByRole('menuitem', { name: 'New character' }).click();
	await expect(page.locator('.sel-menu')).not.toBeVisible();
	await expect(page).toHaveURL(/scene=/);
	await expect(page.locator('.cm-content .ref-word', { hasText: 'Veylan' })).toBeVisible();

	// Quick formatting from the same menu: bold the selection.
	await page.keyboard.press('ControlOrMeta+a');
	const boldSave = page.waitForResponse(
		(response) =>
			response.url().includes('/api/scenes/') &&
			response.request().method() === 'PUT' &&
			response.ok()
	);
	await page.locator('.cm-content').click({ button: 'right' });
	await page.getByRole('menuitem', { name: 'Bold (Ctrl+B)' }).click();
	await expect(page.locator('.cm-content')).toContainText('**Veylan**');
	await boldSave;

	// Without a selection the menu stays away (the browser's own menu, with
	// its spelling suggestions, is not hijacked).
	await page.keyboard.press('ArrowRight');
	await page.locator('.cm-content').click({ button: 'right' });
	await expect(page.locator('.sel-menu')).not.toBeVisible();

	// The character landed in the story plan as a member.
	await page.goto(`/universes/${universeId}/plan`);
	await expect(page.locator('.ent-row', { hasText: 'Veylan' })).toBeVisible();
});
