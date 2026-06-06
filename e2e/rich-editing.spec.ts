import { expect, test } from '@playwright/test';

// The live markdown surface: rich is the default, so syntax marks hide
// away from the cursor while the stored prose stays markdown; switching
// the story to the raw markdown override keeps the marks visible.
test('rich editing: toolbar formats, marks hide by default, override shows them', async ({
	page
}) => {
	await page.goto('/');

	const universeName = `Rich Test ${Date.now()}`;
	await page.getByRole('button', { name: 'New universe' }).click();
	await page.getByLabel('New universe').fill(universeName);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText(`${universeName} - settings`);
	await page.goto('/');
	await page
		.locator('.universe-section', { hasText: universeName })
		.getByRole('button', { name: 'New story in this universe' })
		.click();
	await page.getByLabel('New story').fill('Soft Surface');
	await page.getByRole('button', { name: 'Create story' }).click();
	await expect(page.locator('.story-title')).toHaveText('Soft Surface');
	await page.getByRole('button', { name: 'New chapter' }).click();
	await expect(page.locator('.chapter-name')).toHaveText('Chapter 1');
	await page.getByRole('button', { name: 'New scene' }).click();
	await expect(page).toHaveURL(/scene=/);
	const storyId = page.url().match(/stories\/([^/?]+)/)![1];
	const editorUrl = page.url();

	// Spell-check is on by default, following the browser's language.
	await expect(page.locator('.cm-content')).toHaveAttribute('spellcheck', 'true');

	// Rich is the default: the toolbar wraps the selection in bold marks,
	// which stay visible on the line being edited.
	await page.locator('.cm-content').click();
	await page.keyboard.type('The gate held fast.');
	await expect(page.locator('.saved')).toHaveText(/Saved just now/);
	await page.keyboard.press('ControlOrMeta+a');
	// The bold edit must reach the server before navigating away: the status
	// text still reads "Saved just now" from the first save, so wait for the
	// debounced PUT itself.
	const boldSave = page.waitForResponse(
		(response) =>
			response.url().includes('/api/scenes/') &&
			response.request().method() === 'PUT' &&
			response.ok()
	);
	await page.getByRole('button', { name: 'Bold (Ctrl+B)' }).click();
	await expect(page.locator('.cm-content')).toContainText('**The gate held fast.**');
	await boldSave;

	// Unfocused, the marks hide and the text reads formatted.
	await page.locator('.editor-title-input').click();
	await expect(page.locator('.cm-content')).not.toContainText('**');
	await expect(page.locator('.cm-content')).toContainText('The gate held fast.');

	// Switch this story to raw markdown, written in Danish, through its
	// settings overrides.
	await page.goto(`/stories/${storyId}/settings`);
	await page.getByLabel('Editing mode').selectOption('markdown');
	await page.getByLabel('Writing language').selectOption('Dansk');
	await page.getByRole('button', { name: 'Save editor settings' }).click();
	await expect(page.getByRole('status')).toHaveText('Saved.');

	// Back in the editor the marks stay visible as typed, and the language
	// override reached the spell-checker.
	await page.goto(editorUrl);
	await expect(page.locator('.cm-content')).toBeVisible();
	await expect(page.locator('.cm-content')).toHaveAttribute('lang', 'da');
	await expect(page.locator('.cm-content')).toContainText('**The gate held fast.**');
});
