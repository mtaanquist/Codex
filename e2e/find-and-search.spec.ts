import { expect, test } from '@playwright/test';

// Item 2 of the capability review: find/replace inside the editor, and
// body-text search from the command palette.
test('find in the editor and search the prose from the palette', async ({ page }) => {
	await page.goto('/login');
	await page.getByLabel('Email').fill('e2e@example.com');
	await page.getByLabel('Password').fill('e2e-password');
	await page.getByRole('button', { name: 'Sign in', exact: true }).click();
	await expect(page).toHaveURL('/');

	const stamp = Date.now();
	await page.getByLabel('New universe').fill(`Findfall ${stamp}`);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await page.getByLabel('New story').fill(`Needles ${stamp}`);
	await page.getByRole('button', { name: 'Create story' }).click();

	// A scene with something to find. The word carries the stamp so the
	// palette search cannot hit older test runs.
	await page.getByRole('button', { name: 'New chapter' }).click();
	await page.getByRole('button', { name: 'New scene' }).click();
	await expect(page).toHaveURL(/scene=/);
	await page.locator('.cm-content').click();
	const save = page.waitForResponse(
		(response) =>
			response.url().includes('/api/scenes/') &&
			response.request().method() === 'PUT' &&
			response.ok()
	);
	await page.keyboard.type(`The haystack hid a needle${stamp} near the well.`);
	await save;

	// Find and replace: Ctrl+F opens the panel, replace rewrites the word.
	// The replacement is a document change, so it autosaves on its own.
	await page.keyboard.press('Control+f');
	const panel = page.locator('.cm-panel.cm-search');
	await expect(panel).toBeVisible();
	const resave = page.waitForResponse(
		(response) =>
			response.url().includes('/api/scenes/') &&
			response.request().method() === 'PUT' &&
			response.ok()
	);
	await panel.getByRole('textbox', { name: 'Find', exact: true }).fill(`needle${stamp}`);
	await panel.getByRole('textbox', { name: 'Replace', exact: true }).fill(`pin${stamp}`);
	await panel.getByText('replace all', { exact: true }).click();
	await expect(page.locator('.cm-content')).toContainText(`pin${stamp}`);
	await page.keyboard.press('Escape');
	await expect(panel).toHaveCount(0);
	await resave;

	// The palette finds the prose and lands on the scene.
	await page.keyboard.press('Control+k');
	await page.getByPlaceholder('Search, or type a command...').fill(`pin${stamp}`);
	const passage = page.locator('.palette-item', { hasText: 'In the text' });
	await expect(passage).toHaveCount(1);
	await expect(passage).toContainText(`pin${stamp} near the well`);
	await passage.click();
	await expect(page).toHaveURL(/scene=/);
	await expect(page.locator('.cm-content')).toContainText(`pin${stamp}`);
});
