import { expect, test } from '@playwright/test';

// #301: the author opens their own story in review mode and leaves their own
// comment and a suggested edit, then accepts the suggestion - the same surface
// guests use, now driven by the logged-in author on the three-column workspace.
test('the author can comment and suggest in their own review mode', async ({ page }) => {
	// Retracting a comment and Accept all both ask for confirmation.
	page.on('dialog', (dialog) => dialog.accept());
	await page.goto('/');
	const stamp = Date.now();
	await page.getByRole('button', { name: 'New universe' }).click();
	await page.getByLabel('New universe').fill(`Selfreview ${stamp}`);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await page.goto('/');
	await page
		.locator('.universe-section', { hasText: `Selfreview ${stamp}` })
		.getByRole('button', { name: 'New story in this universe' })
		.click();
	await page.getByLabel('New story').fill('Solo');
	await page.getByRole('button', { name: 'Create story' }).click();
	await expect(page.locator('.story-title')).toHaveText('Solo');
	await page.getByRole('button', { name: 'New chapter' }).click();
	await page.getByRole('button', { name: 'New scene' }).click();
	await expect(page).toHaveURL(/scene=/);
	const storyPath = new URL(page.url()).pathname;

	await page.locator('.cm-content').click();
	await page.keyboard.type('The original sentence.');
	await expect(page.locator('.saved')).toHaveText(/Saved just now/);

	// Enter the author's review mode via the new Review tab.
	await page.getByRole('link', { name: 'Review', exact: true }).click();
	await expect(page).toHaveURL(`${storyPath}/review`);
	const prose = page.locator('.review-prose');
	await expect(prose).toContainText('The original sentence.');

	// A real drag across the line selects it and fires the mouseup the surface
	// listens for, raising the floating toolbar.
	async function selectProse() {
		const box = (await prose.boundingBox())!;
		await page.mouse.move(box.x + 3, box.y + 10);
		await page.mouse.down();
		await page.mouse.move(box.x + box.width - 3, box.y + 10, { steps: 10 });
		await page.mouse.up();
	}

	// Select the passage and leave a comment from the draft card.
	await selectProse();
	await page.locator('.rv-seltool').getByRole('button', { name: 'Comment' }).click();
	await page.getByLabel('Your comment').fill('Tighten this line.');
	await page
		.locator('.rv-card.is-draft')
		.getByRole('button', { name: 'Comment', exact: true })
		.click();
	const card = page.locator('.rv-card').filter({ hasText: 'Tighten this line.' });
	await expect(card).toBeVisible();
	// Attributed to the author.
	await expect(card.locator('.rv-role')).toHaveText('Author');

	// The author retracts their own comment from its card.
	await card.getByRole('button', { name: 'Delete your comment' }).click();
	await expect(card).toHaveCount(0);

	// Select again and suggest a replacement.
	await selectProse();
	await page.locator('.rv-seltool').getByRole('button', { name: 'Suggest edit' }).click();
	await page.getByLabel('Suggested text').fill('The revised sentence.');
	await page.getByRole('button', { name: 'Save suggestion' }).click();
	await expect(page.locator('.rv-diff-ins')).toHaveText('The revised sentence.');

	// Accept all pending edits in the scene; it applies to the scene text.
	await page.getByRole('button', { name: /^Accept all/ }).click();
	await expect(page.locator('.review-prose')).toContainText('The revised sentence.');
});
