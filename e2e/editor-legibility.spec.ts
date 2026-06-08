import { expect, test } from '@playwright/test';

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

	// The view toggles live in the overflow ("View options") menu and are off
	// by default. Turning non-printing on shows the pilcrow glyphs (end of
	// "Alpha" and on the blank line between the paragraphs).
	await page.getByRole('button', { name: 'View options' }).click();
	const nonPrinting = page.getByRole('menuitemcheckbox', { name: /non-printing characters/ });
	await expect(nonPrinting).toHaveAttribute('aria-checked', 'false');
	await nonPrinting.click();
	await expect(nonPrinting).toHaveAttribute('aria-checked', 'true');
	await expect(page.locator('.cm-np-para')).toHaveCount(2);

	// Command markers are also off by default (click to show), in the same menu.
	const commandMarkers = page.getByRole('menuitemcheckbox', { name: /command markers/ });
	await expect(commandMarkers).toHaveAttribute('aria-checked', 'false');
	await commandMarkers.click();
	await expect(commandMarkers).toHaveAttribute('aria-checked', 'true');

	// Both settings are remembered across a reload.
	await page.reload();
	await page.getByRole('button', { name: 'View options' }).click();
	await expect(
		page.getByRole('menuitemcheckbox', { name: /non-printing characters/ })
	).toHaveAttribute('aria-checked', 'true');
	await expect(page.getByRole('menuitemcheckbox', { name: /command markers/ })).toHaveAttribute(
		'aria-checked',
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
