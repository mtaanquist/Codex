import { expect, test } from '@playwright/test';

// Line spacing and the binding gutter are page-setup knobs. The in-app preview
// must reflect line spacing (and the page's text-column width); the alternating
// gutter itself only shows in the paginated Print view, so here we check that
// the preview honours the spacing and width the export will use.
test('page setup line spacing reflects in the story preview', async ({ page }) => {
	await page.goto('/');
	const stamp = Date.now();
	await page.getByRole('button', { name: 'New universe' }).click();
	await page.getByLabel('New universe').fill(`Setup ${stamp}`);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await page.goto('/');
	await page
		.locator('.universe-section', { hasText: `Setup ${stamp}` })
		.getByRole('button', { name: 'New story in this universe' })
		.click();
	await page.getByLabel('New story').fill('Spacing');
	await page.getByRole('button', { name: 'Create story' }).click();
	await expect(page.locator('.story-title')).toHaveText('Spacing');
	await page.getByRole('button', { name: 'New chapter' }).click();
	await page.getByRole('button', { name: 'New scene' }).click();
	await expect(page).toHaveURL(/scene=/);
	await page.locator('.cm-content').click();
	await page.keyboard.type('First paragraph.');
	await page.keyboard.press('Enter');
	await page.keyboard.type('Second paragraph.');
	await expect(page.locator('.saved')).toHaveText(/Saved just now/);
	const storyUrl = new URL(page.url());
	const storyPath = storyUrl.pathname;

	// Set this story to double line spacing and a wide gutter.
	await page.goto(`${storyPath}/settings/pagesetup`);
	await page.locator('select[name="lineSpacing"]').selectOption('double');
	await page.locator('select[name="gutter"]').selectOption('wide');
	await page.getByRole('button', { name: 'Save page setup' }).click();

	// The preview shows the prose at double spacing and a constrained column.
	await page.goto(`${storyPath}?view=preview`);
	const preview = page.locator('.story-preview');
	await expect(preview).toContainText('First paragraph.');
	await expect(preview).toHaveAttribute('style', /line-height: 2\.1/);
	await expect(preview).toHaveAttribute('style', /max-width: calc\(/);
});
