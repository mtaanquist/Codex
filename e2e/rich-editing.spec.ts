import { expect, test } from '@playwright/test';

// The live markdown surface: formatting renders styled in the default mode,
// the toolbar writes markdown, and switching the story to rich text hides
// the syntax marks away from the cursor while the stored prose stays
// markdown.
test('rich editing: toolbar formats, story override hides the marks', async ({ page }) => {
	await page.goto('/login');
	await page.getByLabel('Email').fill('e2e@example.com');
	await page.getByLabel('Password').fill('e2e-password');
	await page.getByRole('button', { name: 'Sign in', exact: true }).click();
	await expect(page).toHaveURL('/');

	const universeName = `Rich Test ${Date.now()}`;
	await page.getByLabel('New universe').fill(universeName);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText(universeName);
	await page.getByLabel('New story').fill('Soft Surface');
	await page.getByRole('button', { name: 'Create story' }).click();
	await expect(page.locator('.story-title')).toHaveText('Soft Surface');
	await page.getByRole('button', { name: 'New chapter' }).click();
	await expect(page.locator('.chapter-name')).toHaveText('Chapter 1');
	await page.getByRole('button', { name: 'New scene' }).click();
	await expect(page).toHaveURL(/scene=/);
	const storyId = page.url().match(/stories\/([0-9a-f-]{36})/)![1];
	const editorUrl = page.url();

	// Markdown mode: the toolbar wraps the selection in bold marks, which
	// stay visible as typed.
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

	// Switch this story to rich text through its settings override.
	await page.goto(`/stories/${storyId}/settings`);
	await page.getByLabel('Editing mode').selectOption('rich');
	await page.getByRole('button', { name: 'Save editor settings' }).click();
	await expect(page.getByRole('status')).toHaveText('Saved.');

	// Back in the editor, unfocused, the marks are hidden...
	await page.goto(editorUrl);
	await expect(page.locator('.cm-content')).toBeVisible();
	await expect(page.locator('.cm-content')).not.toContainText('**');
	await expect(page.locator('.cm-content')).toContainText('The gate held fast.');

	// ...and reappear on the line being edited.
	await page.locator('.cm-content').click();
	await expect(page.locator('.cm-content')).toContainText('**The gate held fast.**');
});
