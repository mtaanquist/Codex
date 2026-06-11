import { expect, test } from '@playwright/test';
import { clickTool } from './toolbar';

// Increase/decrease indent: a toolbar button steps a paragraph's block indent,
// stored as a \indent marker that renders as a left margin in the editor and
// the export-faithful preview.
test('a paragraph can be indented from the toolbar, in the editor and preview', async ({
	page
}) => {
	await page.goto('/');
	const stamp = Date.now();
	await page.getByRole('button', { name: 'New universe' }).click();
	await page.getByLabel('New universe').fill(`Indent ${stamp}`);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await page.goto('/');
	await page
		.locator('.universe-section', { hasText: `Indent ${stamp}` })
		.getByRole('button', { name: 'New story in this universe' })
		.click();
	await page.getByLabel('New story').fill('Indents');
	await page.getByRole('button', { name: 'Create story' }).click();
	await expect(page.locator('.story-title')).toHaveText('Indents');
	await page.getByRole('button', { name: 'New chapter' }).click();
	await page.getByRole('button', { name: 'New scene' }).click();
	await expect(page).toHaveURL(/scene=/);

	await page.locator('.cm-content').click();
	await page.keyboard.type('A paragraph.');

	// Increase the indent twice.
	await clickTool(page, 'Increase indent (Ctrl+])');
	await clickTool(page, 'Increase indent (Ctrl+])');
	// The marker is stored in the text, and the line is shifted right.
	await expect(page.locator('.cm-content')).toContainText('\\indent2');
	const lineMargin = await page
		.locator('.cm-line', { hasText: 'A paragraph.' })
		.first()
		.evaluate((el) => getComputedStyle(el).marginLeft);
	expect(parseFloat(lineMargin)).toBeGreaterThan(0);
	await expect(page.locator('.saved')).toHaveText(/Saved just now/);

	// Decrease once: the marker drops to a single level. Wait for the save so
	// the preview reads the updated body, not the stale one.
	const saved = page.waitForResponse(
		(r) => r.url().includes('/api/scenes/') && r.request().method() === 'PUT' && r.ok()
	);
	await clickTool(page, 'Decrease indent (Ctrl+[)');
	await expect(page.locator('.cm-content')).toContainText('\\indent ');
	await expect(page.locator('.cm-content')).not.toContainText('\\indent2');
	await saved;

	// The preview renders the indent as a left margin, marker gone.
	await page.getByTitle('Switch view').click();
	await page.getByRole('menuitem', { name: 'Preview' }).click();
	await expect(page).toHaveURL(/view=preview/);
	const para = page.locator('.story-preview p', { hasText: 'A paragraph.' });
	await expect(para).toHaveAttribute('style', /margin-left: calc\(1 \* 1\.5em\)/);
	await expect(page.locator('.story-preview')).not.toContainText('\\indent');
});
