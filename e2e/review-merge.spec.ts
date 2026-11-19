import { expect, test, type Page } from '@playwright/test';
import { gotoReady } from './navigate';
import { pickFromLibraryMenu, startStoryInUniverse } from './library';
import { openRowMenu } from './context-menu';

// A merge or duplicate started from the review centre reads the stored text,
// so the open scene's pending save must land first. While the save keeps
// failing the action is refused; once it lands, the edit is in the result.

async function storyWithTwoScenes(page: Page, name: string) {
	await gotoReady(page, '/');
	const stamp = Date.now();
	await pickFromLibraryMenu(page, 'New universe');
	await page.getByLabel('New universe').fill(`${name} ${stamp}`);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await gotoReady(page, '/');
	await startStoryInUniverse(page, `${name} ${stamp}`);
	await page.getByLabel('New story').fill(name);
	await page.getByRole('button', { name: 'Create story' }).click();
	await page.getByRole('button', { name: 'New chapter' }).click();
	for (const [text, previous] of [
		['ALPHA opens.', null],
		['BRAVO follows.', 'ALPHA']
	] as const) {
		await page.getByRole('button', { name: 'New scene' }).click();
		if (previous) await expect(page.locator('.cm-content')).not.toContainText(previous);
		await page.locator('.cm-content').click();
		await page.keyboard.type(text);
		await expect(page.locator('.saved')).toHaveText(/Saved just now/);
		await expect(page.locator('.cm-content')).toHaveText(text);
	}
	await page.getByRole('link', { name: 'Review', exact: true }).click();
	await expect(page.locator('.scene-row')).toHaveCount(2);
}

// Scene saves fail while offline is set, as a dropped connection would.
async function failSavesWhile(page: Page) {
	const state = { offline: true, failed: 0 };
	await page.route('**/api/scenes/*', async (route) => {
		if (state.offline && route.request().method() === 'PUT') {
			state.failed++;
			return route.abort();
		}
		return route.fallback();
	});
	return state;
}

// Edits the open scene while saves fail, and waits until one has failed.
async function editOffline(page: Page, state: { failed: number }, text: string) {
	const prose = page.locator('.review-edit .cm-content');
	await prose.click();
	await prose.press('End');
	await prose.pressSequentially(text);
	await expect.poll(() => state.failed).toBeGreaterThan(0);
}

function nextDialog(page: Page) {
	return new Promise<string>((resolve) =>
		page.once('dialog', (dialog) => {
			resolve(dialog.message());
			void dialog.accept();
		})
	);
}

test('a merge in the review centre saves the open scene first', async ({ page }) => {
	await storyWithTwoScenes(page, 'Joined');
	const prose = page.locator('.review-edit .cm-content');
	await page.locator('.scene-row').nth(1).click();
	await expect(prose).toContainText('BRAVO');

	const state = await failSavesWhile(page);
	await editOffline(page, state, ' BRAVOEDIT');

	for (const n of [0, 1]) {
		await (
			await openRowMenu(page, page.locator('.scene-row').nth(n))
		)
			.getByRole('menuitem', { name: 'Select for merging' })
			.click();
	}

	// The save still fails: the merge is refused and nothing changes.
	const message = nextDialog(page);
	await (
		await openRowMenu(page, page.locator('.scene-row').nth(0))
	)
		.getByRole('menuitem', { name: 'Merge 2 scenes' })
		.click();
	expect(await message).toContain('could not be saved');
	await expect(page.locator('.scene-row')).toHaveCount(2);
	await expect(prose).toContainText('BRAVOEDIT');

	// Back online: the edit lands, then the merge carries it.
	state.offline = false;
	await (
		await openRowMenu(page, page.locator('.scene-row').nth(0))
	)
		.getByRole('menuitem', { name: 'Merge 2 scenes' })
		.click();
	await expect(page.locator('.scene-row')).toHaveCount(1);
	await expect(prose).toContainText('ALPHA opens.');
	await expect(prose).toContainText('BRAVO follows. BRAVOEDIT');

	await page.reload();
	await expect(page.locator('.review-edit .cm-content')).toContainText('BRAVOEDIT');
});

test('a duplicate in the review centre copies the unsaved edit', async ({ page }) => {
	await storyWithTwoScenes(page, 'Copied');
	const prose = page.locator('.review-edit .cm-content');
	await page.locator('.scene-row').nth(0).click();
	await expect(prose).toContainText('ALPHA');

	const state = await failSavesWhile(page);
	await editOffline(page, state, ' ALPHAEDIT');

	const message = nextDialog(page);
	await (
		await openRowMenu(page, page.locator('.scene-row').nth(0))
	)
		.getByRole('menuitem', { name: 'Duplicate scene' })
		.click();
	expect(await message).toContain('could not be saved');
	await expect(page.locator('.scene-row')).toHaveCount(2);

	state.offline = false;
	// Counts the editors created from here on: the copy opens in one go, not
	// by way of another scene.
	await page.evaluate(() => {
		const w = window as unknown as { mounted: number };
		w.mounted = 0;
		new MutationObserver((records) => {
			for (const record of records)
				for (const node of record.addedNodes)
					if (node instanceof HTMLElement && node.matches('.cm-editor')) w.mounted++;
		}).observe(document.body, { childList: true, subtree: true });
	});
	await (
		await openRowMenu(page, page.locator('.scene-row').nth(0))
	)
		.getByRole('menuitem', { name: 'Duplicate scene' })
		.click();
	await expect(page.locator('.scene-row')).toHaveCount(3);
	// The copy is the open scene now, and holds the edit.
	await expect(prose).toContainText('ALPHA opens. ALPHAEDIT');
	expect(await page.evaluate(() => (window as unknown as { mounted: number }).mounted)).toBe(1);
	await page.locator('.scene-row').nth(0).click();
	await expect(prose).toContainText('ALPHA opens. ALPHAEDIT');
});

// A suggestion accepted while a merge is under way lands in the editor even
// though typing is paused. When the merge then fails, typing on must keep the
// accepted text rather than save over it.
test('an accept during a merge that fails survives the next edit', async ({ page }) => {
	await storyWithTwoScenes(page, 'Accepted');
	const prose = page.locator('.review-edit .cm-content');
	await page.locator('.scene-row').nth(0).click();
	await expect(prose).toContainText('ALPHA');

	// Suggest a replacement for the opening word.
	const line = prose.locator('.cm-line').first();
	const box = (await line.boundingBox())!;
	await page.mouse.move(box.x + 1, box.y + box.height / 2);
	await page.mouse.down();
	await page.mouse.move(box.x + 40, box.y + box.height / 2, { steps: 8 });
	await page.mouse.up();
	await page.locator('.rv-seltool').getByRole('button', { name: 'Suggest edit' }).click();
	await page.getByLabel('Suggested text').fill('REPLACED');
	await page.getByRole('button', { name: 'Save suggestion' }).click();
	await expect(page.locator('.rv-diff-ins')).toHaveText('REPLACED');

	for (const n of [0, 1]) {
		await (
			await openRowMenu(page, page.locator('.scene-row').nth(n))
		)
			.getByRole('menuitem', { name: 'Select for merging' })
			.click();
	}

	// Hold the merge until the accept has landed, then refuse it.
	let release!: () => void;
	const held = new Promise<void>((resolve) => (release = resolve));
	let arrived!: () => void;
	const merging = new Promise<void>((resolve) => (arrived = resolve));
	await page.route('**/merge-scenes', async (route) => {
		arrived();
		await held;
		await route.fulfill({
			status: 409,
			contentType: 'application/json',
			body: JSON.stringify({ message: 'Merge refused for the test.' })
		});
	});
	const message = nextDialog(page);
	await (
		await openRowMenu(page, page.locator('.scene-row').nth(0))
	)
		.getByRole('menuitem', { name: 'Merge 2 scenes' })
		.click();
	await merging;
	const accepted = page.waitForResponse(
		(response) => response.url().includes('/accept') && response.ok()
	);
	await page.getByRole('button', { name: 'Accept suggestion' }).click();
	await accepted;
	await expect(page.getByRole('button', { name: 'Accept suggestion' })).toHaveCount(0);
	release();
	await message;
	await expect(page.locator('.scene-row')).toHaveCount(2);
	await expect(prose).toContainText('REPLACED');

	const saved = page.waitForResponse(
		(response) =>
			response.url().includes('/api/scenes/') &&
			response.request().method() === 'PUT' &&
			(response.request().postData() ?? '').includes('TYPEDTAIL')
	);
	await prose.click();
	await prose.press('End');
	await prose.pressSequentially(' TYPEDTAIL');
	expect((await saved).ok()).toBe(true);
	await page.reload();
	await expect(page.locator('.review-edit .cm-content')).toContainText('REPLACED');
	await expect(page.locator('.review-edit .cm-content')).toContainText('TYPEDTAIL');
});
