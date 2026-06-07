import { expect, test } from '@playwright/test';

// Leaving the editor (say, to look up an entity on the Plan view) and
// pressing the browser back button returns to the same scroll position,
// not the top of the scene.
test('back button returns to the editor spot it left', async ({ page }) => {
	await page.goto('/');

	const stamp = Date.now();
	await page.getByRole('button', { name: 'New universe' }).click();
	await page.getByLabel('New universe').fill(`Spotfall ${stamp}`);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await page.goto('/');
	await page
		.locator('.universe-section', { hasText: `Spotfall ${stamp}` })
		.getByRole('button', { name: 'New story in this universe' })
		.click();
	await page.getByLabel('New story').fill(`Spots ${stamp}`);
	await page.getByRole('button', { name: 'Create story' }).click();
	await expect(page).toHaveURL(`/stories/spots-${stamp}`);

	await page.getByRole('button', { name: 'New chapter' }).click();
	await page.getByRole('button', { name: 'New scene' }).click();
	await expect(page).toHaveURL(/scene=/);

	// Long enough prose that the pane actually scrolls, written through the
	// save API rather than typed out line by line.
	const sceneId = new URL(page.url()).searchParams.get('scene');
	const body = Array.from({ length: 120 }, (_, i) => `Paragraph ${i + 1} of the night.`).join(
		'\n\n'
	);
	const saved = await page.evaluate(
		async ({ id, bodyMd }) => {
			const response = await fetch(`/api/scenes/${id}`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ title: 'The long night', bodyMd, markers: [] })
			});
			return response.ok;
		},
		{ id: sceneId, bodyMd: body }
	);
	expect(saved).toBe(true);
	await page.reload();
	await expect(page.locator('.cm-content')).toContainText('Paragraph 1 of the night.');

	// Scroll deep into the scene, then leave for the Plan view.
	await page.locator('.editor-scroll').evaluate((pane) => (pane.scrollTop = 600));
	await expect
		.poll(() => page.locator('.editor-scroll').evaluate((pane) => pane.scrollTop))
		.toBe(600);
	await page.getByRole('link', { name: 'Plan' }).click();
	await expect(page).toHaveURL(/\/plan$/);

	// Back lands where the writer was, give or take a settled layout.
	await page.goBack();
	await expect(page.locator('.cm-content')).toContainText('Paragraph 1 of the night.');
	await expect
		.poll(() => page.locator('.editor-scroll').evaluate((pane) => pane.scrollTop))
		.toBeGreaterThan(400);
});
