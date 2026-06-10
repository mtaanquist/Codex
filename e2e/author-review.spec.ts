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

	// Enter the author's review mode via the new Review tab. The author's centre
	// is the real editor (CodeMirror), so the manuscript is editable in place.
	await page.getByRole('link', { name: 'Review', exact: true }).click();
	await expect(page).toHaveURL(`${storyPath}/review`);
	const prose = page.locator('.review-edit .cm-content');
	await expect(prose).toContainText('The original sentence.');

	// A real drag across the line selects it and raises the floating toolbar
	// (the editor positions it from CodeMirror's selection).
	async function selectProse() {
		const line = prose.locator('.cm-line').first();
		const box = (await line.boundingBox())!;
		await page.mouse.move(box.x + 3, box.y + box.height / 2);
		await page.mouse.down();
		await page.mouse.move(box.x + box.width - 3, box.y + box.height / 2, { steps: 10 });
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

	// A pending suggestion's card takes replies: the discussion thread is
	// created on the first one and renders on the card.
	const suggCard = page.locator('.rv-card.sugg');
	await suggCard.getByLabel('Reply', { exact: true }).fill('Thinking about this one.');
	await suggCard.getByRole('button', { name: 'Send reply' }).click();
	await expect(suggCard.locator('.rv-reply-body')).toHaveText('Thinking about this one.');

	// Accept all pending edits in the scene; the editable prose updates in place.
	// Wait for the accept's data refresh before reading the text: the pending
	// suggestion's ghost widget also renders the replacement, so the text
	// check alone passes before the document itself has it - and typing into
	// the stale document would win over the accepted text (local edits win).
	// The Accept all button leaves with the last pending suggestion, which
	// only happens once the refresh has landed.
	await page.getByRole('button', { name: /^Accept all/ }).click();
	await expect(page.getByRole('button', { name: /^Accept all/ })).toHaveCount(0);
	await expect(prose).toContainText('The revised sentence.');

	// The author can now build on the accepted text: type into the manuscript
	// and it persists across a reload (the review save omits markers but keeps
	// the prose). Locator-based key presses focus the editor themselves, so a
	// lost click cannot send the typing elsewhere (a CI flake); and the reload
	// waits for the save request that actually carries the clause, since the
	// accept's own doc sync schedules an earlier, clause-less save.
	const clauseSaved = page.waitForResponse(
		(response) =>
			response.url().includes('/api/scenes/') &&
			response.request().method() === 'PUT' &&
			response.ok() &&
			(response.request().postData() ?? '').includes('A new clause.')
	);
	await prose.press('End');
	await prose.pressSequentially(' A new clause.');
	await expect(prose).toContainText('A new clause.');
	await clauseSaved;
	await page.reload();
	await expect(page.locator('.review-edit .cm-content')).toContainText(
		'The revised sentence. A new clause.'
	);
});

// Accepting the last note in a scene must not yank the view to the next active
// scene: the author should stay on the change to keep editing it.
test('accepting the last suggestion in a scene keeps the view on that scene', async ({ page }) => {
	page.on('dialog', (dialog) => dialog.accept());
	await page.goto('/');
	const stamp = Date.now();
	await page.getByRole('button', { name: 'New universe' }).click();
	await page.getByLabel('New universe').fill(`Stay ${stamp}`);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await page.goto('/');
	await page
		.locator('.universe-section', { hasText: `Stay ${stamp}` })
		.getByRole('button', { name: 'New story in this universe' })
		.click();
	await page.getByLabel('New story').fill('Stay');
	await page.getByRole('button', { name: 'Create story' }).click();
	await page.getByRole('button', { name: 'New chapter' }).click();

	// Two scenes, each with a unique tail token the edit never touches.
	await page.getByRole('button', { name: 'New scene' }).click();
	await page.locator('.cm-content').click();
	await page.keyboard.type('Sceneword ONETAIL closing.');
	await expect(page.locator('.saved')).toHaveText(/Saved just now/);
	await page.getByRole('button', { name: 'New scene' }).click();
	await page.locator('.cm-content').click();
	await page.keyboard.type('Sceneword TWOTAIL closing.');
	await expect(page.locator('.saved')).toHaveText(/Saved just now/);

	await page.getByRole('link', { name: 'Review', exact: true }).click();
	const prose = page.locator('.review-edit .cm-content');
	await prose.waitFor();

	async function suggestHere(replacement: string) {
		const line = prose.locator('.cm-line').first();
		const box = (await line.boundingBox())!;
		await page.mouse.move(box.x + 3, box.y + box.height / 2);
		await page.mouse.down();
		await page.mouse.move(box.x + 60, box.y + box.height / 2, { steps: 8 });
		await page.mouse.up();
		await page.locator('.rv-seltool').getByRole('button', { name: 'Suggest edit' }).click();
		await page.getByLabel('Suggested text').fill(replacement);
		await page.getByRole('button', { name: 'Save suggestion' }).click();
		await expect(page.locator('.rv-diff-ins').filter({ hasText: replacement })).toBeVisible();
	}

	// A pending suggestion in each scene; scene two reached through the outline.
	await suggestHere('EDITONE');
	await page.locator('.scene-row').nth(1).click();
	await expect(prose).toContainText('TWOTAIL');
	await suggestHere('EDITTWO');

	// Reload so the workspace defaults to the first active scene (scene one).
	await page.reload();
	await expect(prose).toContainText('ONETAIL');

	// Accept scene one's only suggestion; the centre stays on scene one.
	await page
		.locator('.rv-card')
		.filter({ hasText: 'EDITONE' })
		.getByRole('button', { name: 'Accept suggestion' })
		.click();
	await expect(prose).toContainText('ONETAIL');
	await expect(prose).not.toContainText('TWOTAIL');
});
