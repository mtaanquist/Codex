import { expect, test } from '@playwright/test';

const DEFAULTS = { nonPrintingMarks: 'hidden', commandMarkers: 'shown' };

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

	// Non-printing characters: off by default, toggling on shows the pilcrow
	// glyphs (end of "Alpha" and on the blank line between the paragraphs).
	const nonPrinting = page.getByRole('button', { name: 'Non-printing characters' });
	await expect(nonPrinting).toHaveAttribute('aria-pressed', 'false');
	await nonPrinting.click();
	await expect(nonPrinting).toHaveAttribute('aria-pressed', 'true');
	await expect(page.locator('.cm-np-para')).toHaveCount(2);

	// The setting is remembered: after a reload the toggle is still on.
	await page.reload();
	await expect(page.getByRole('button', { name: 'Non-printing characters' })).toHaveAttribute(
		'aria-pressed',
		'true'
	);

	// Command markers: shown by default (button not pressed), toggling hides
	// them, and that persists too.
	const commandMarkers = page.getByRole('button', { name: 'Command markers' });
	await expect(commandMarkers).toHaveAttribute('aria-pressed', 'false');
	await commandMarkers.click();
	await expect(commandMarkers).toHaveAttribute('aria-pressed', 'true');
	await page.reload();
	await expect(page.getByRole('button', { name: 'Command markers' })).toHaveAttribute(
		'aria-pressed',
		'true'
	);

	// The Preview confirms two separate paragraphs, not one merged block.
	await page.locator('.md-toolbar a.md-preview').click();
	await expect(page).toHaveURL(/view=preview/);
	const paras = page.locator('.story-preview p');
	await expect(paras).toHaveCount(2);
	await expect(paras.nth(0)).toHaveText('Alpha');
	await expect(paras.nth(1)).toHaveText('Beta');

	// Leave the shared account's editor view at its defaults for other specs.
	await page.request.post('/api/editor-view', { data: DEFAULTS });
});
