import { expect, test } from '@playwright/test';
import { clickTool } from './toolbar';

// The whole-story view is the editor (it carries the formatting toolbar);
// Preview beside it is the read-only, export-faithful render: alignment is
// applied and the \center marker is gone, the way an export looks.
test('whole-story view has the toolbar; preview hides the markers', async ({ page }) => {
	await page.goto('/');

	const universeName = `Preview Test ${Date.now()}`;
	await page.getByRole('button', { name: 'New universe' }).click();
	await page.getByLabel('New universe').fill(universeName);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText(`${universeName} - settings`);
	await page.goto('/');
	await page
		.locator('.universe-section', { hasText: universeName })
		.getByRole('button', { name: 'New story in this universe' })
		.click();
	await page.getByLabel('New story').fill('The Quiet Coast');
	await page.getByRole('button', { name: 'Create story' }).click();
	await expect(page.locator('.story-title')).toHaveText('The Quiet Coast');
	await page.getByRole('button', { name: 'New chapter' }).click();
	await expect(page.locator('.chapter-name')).toHaveText('Chapter 1');
	await page.getByRole('button', { name: 'New scene' }).click();
	await expect(page).toHaveURL(/scene=/);

	// Write a line and centre it; the marker is written into the text.
	await page.locator('.cm-content').click();
	await page.keyboard.type('Centered line.');
	await expect(page.locator('.saved')).toHaveText(/Saved just now/);
	await page.keyboard.press('ControlOrMeta+a');
	const alignSave = page.waitForResponse(
		(response) =>
			response.url().includes('/api/scenes/') &&
			response.request().method() === 'PUT' &&
			response.ok()
	);
	await clickTool(page, 'Align center');
	await expect(page.locator('.cm-content')).toContainText('\\center Centered line.');
	await alignSave;

	// The scene editor's own toolbar offers Preview from the View menu, without
	// first opening the whole-story view (#308). It opens the export render;
	// return to the scene to carry on with the whole-story checks below.
	const sceneUrl = page.url();
	await page.getByTitle('Switch view').click();
	await page.getByRole('menuitem', { name: 'Preview' }).click();
	await expect(page).toHaveURL(/view=preview/);
	await expect(page.locator('.story-preview')).toContainText('Centered line.');
	await page.goto(sceneUrl);
	await expect(page.locator('.cm-content')).toContainText('Centered line.');

	// Read the whole story: still the editor, so the formatting toolbar is
	// there alongside the View menu.
	await page.getByTitle('Read the whole story').click();
	await expect(page).toHaveURL(/view=story/);
	await expect(page.locator('.md-toolbar')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Bold (Ctrl+B)' })).toBeVisible();

	// Preview from the View menu: read-only, export-faithful. The text shows,
	// the \center marker does not, and the paragraph is actually centered.
	await page.getByTitle('Switch view').click();
	await page.getByRole('menuitem', { name: 'Preview' }).click();
	await expect(page).toHaveURL(/view=preview/);
	const preview = page.locator('.story-preview');
	await expect(preview).toContainText('Centered line.');
	await expect(preview).not.toContainText('\\center');
	await expect(preview.locator('p.align-center')).toHaveText('Centered line.');
	// No formatting tools in preview; an Edit button returns to writing.
	await expect(page.getByRole('button', { name: 'Bold (Ctrl+B)' })).toHaveCount(0);
	await page.locator('.md-toolbar a.md-preview-edit').click();
	await expect(page).toHaveURL(/view=story/);
});
