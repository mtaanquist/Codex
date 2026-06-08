import { expect, test } from '@playwright/test';

// #301: the author opens their own story in review mode and leaves their own
// comment and a suggested edit, then accepts the suggestion - the same surface
// guests use, now driven by the logged-in author.
test('the author can comment and suggest in their own review mode', async ({ page }) => {
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

	// Enter the author's review mode.
	await page.goto(`${storyPath}/review`);
	const manuscript = page.locator('.manuscript').first();
	await expect(manuscript).toContainText('The original sentence.');

	// A real drag across the line selects it and fires the mouseup the editor
	// listens for. (selectText alone does not trigger the handler.)
	async function selectManuscript() {
		const box = (await manuscript.boundingBox())!;
		await page.mouse.move(box.x + 3, box.y + box.height / 2);
		await page.mouse.down();
		await page.mouse.move(box.x + box.width - 3, box.y + box.height / 2, { steps: 10 });
		await page.mouse.up();
	}

	// Select the passage and leave a comment.
	await selectManuscript();
	await page.locator('.comment-box textarea[name="body"]').fill('Tighten this line.');
	await page.locator('.comment-box button[type="submit"]').click();
	const thread = page.locator('.thread').first();
	await expect(thread).toContainText('Tighten this line.');
	// Attributed to the author (owner styling).
	await expect(thread.locator('.comment.owner')).toHaveCount(1);

	// Select again and suggest a replacement.
	await selectManuscript();
	await page.getByRole('button', { name: 'Suggest a change' }).click();
	await page.locator('.comment-box textarea[name="replacement"]').fill('The revised sentence.');
	await page.locator('.comment-box button[type="submit"]').click();
	const suggestion = page.locator('.suggestion').first();
	await expect(suggestion).toContainText('The revised sentence.');

	// Accept the author's own suggestion; it applies to the scene.
	await suggestion.getByRole('button', { name: 'Accept' }).click();
	await expect(page.locator('.manuscript').first()).toContainText('The revised sentence.');
});
