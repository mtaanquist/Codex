import { expect, test } from '@playwright/test';
import { toggleView, viewChecked } from './toolbar';

const DEFAULTS = { nonPrintingMarks: 'hidden', commandMarkers: 'hidden' };

// The editor legibility batch: Enter makes a paragraph (one Enter, not two),
// and the formatting bar's view toggles show non-printing marks and remember
// their setting.
test('Enter makes a paragraph; the view toggles show marks and persist', async ({ page }) => {
	await page.goto('/');
	// The toggles are remembered per user, so start from a known baseline
	// regardless of earlier runs against the shared e2e account.
	await page.request.post('/api/editor-view', { data: DEFAULTS });

	const universeName = `Legible ${Date.now()}`;
	await page.getByRole('button', { name: 'New universe' }).click();
	await page.getByLabel('New universe').fill(universeName);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await page.goto('/');
	await page
		.locator('.universe-section', { hasText: universeName })
		.getByRole('button', { name: 'New story in this universe' })
		.click();
	await page.getByLabel('New story').fill('Breaks');
	await page.getByRole('button', { name: 'Create story' }).click();
	await expect(page.locator('.story-title')).toHaveText('Breaks');
	await page.getByRole('button', { name: 'New chapter' }).click();
	await expect(page.locator('.chapter-name')).toHaveText('Chapter 1');
	await page.getByRole('button', { name: 'New scene' }).click();
	await expect(page).toHaveURL(/scene=/);

	// One Enter between two lines should make two paragraphs.
	await page.locator('.cm-content').click();
	await page.keyboard.type('Alpha');
	await page.keyboard.press('Enter');
	await page.keyboard.type('Beta');
	await expect(page.locator('.saved')).toHaveText(/Saved just now/);

	// The view toggles are off by default (inline on a wide bar, or in the "More
	// tools" overflow menu when it is narrow). Turning non-printing on shows the
	// pilcrow glyphs (end of "Alpha" and on the blank line between paragraphs).
	expect(await viewChecked(page, /non-printing characters/)).toBe(false);
	await expect(page.locator('.cm-np-para')).toHaveCount(0);
	await toggleView(page, /non-printing characters/);
	await expect(page.locator('.cm-np-para')).toHaveCount(2);

	// Command markers are also off by default; click to show.
	expect(await viewChecked(page, /command markers/)).toBe(false);
	await toggleView(page, /command markers/);

	// Both settings are remembered across a reload: the marks still show, and
	// the toggles read as on.
	await page.reload();
	await expect(page.locator('.cm-np-para')).toHaveCount(2);
	expect(await viewChecked(page, /non-printing characters/)).toBe(true);
	expect(await viewChecked(page, /command markers/)).toBe(true);

	// The Preview confirms two separate paragraphs, not one merged block.
	await page.getByTitle('Switch view').click();
	await page.getByRole('menuitem', { name: 'Preview' }).click();
	await expect(page).toHaveURL(/view=preview/);
	const paras = page.locator('.story-preview p');
	await expect(paras).toHaveCount(2);
	await expect(paras.nth(0)).toHaveText('Alpha');
	await expect(paras.nth(1)).toHaveText('Beta');

	// Leave the shared account's editor view at its defaults for other specs.
	await page.request.post('/api/editor-view', { data: DEFAULTS });
});
