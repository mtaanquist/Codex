import { expect, test } from '@playwright/test';
import { gotoReady } from './navigate';
import { pickFromLibraryMenu, startStoryInUniverse } from './library';

// The continuous story view mounts a scene's editor only as the scene nears
// the visible part of the document (#605); further down, the scene's text
// shows as plain lines until the writer scrolls to it.
test('whole-story view mounts scene editors as they scroll into view', async ({ page }) => {
	await gotoReady(page, '/');

	const stamp = Date.now();
	await pickFromLibraryMenu(page, 'New universe');
	await page.getByLabel('New universe').fill(`Longreach ${stamp}`);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await gotoReady(page, '/');
	await startStoryInUniverse(page, `Longreach ${stamp}`);
	await page.getByLabel('New story').fill(`Long Book ${stamp}`);
	await page.getByRole('button', { name: 'Create story' }).click();
	await expect(page).toHaveURL(`/stories/long-book-${stamp}`);
	const storyUrl = page.url();

	await page.getByRole('button', { name: 'New chapter' }).click();
	await expect(page.locator('.chapter-name')).toHaveText('Chapter 1');

	// Four scenes, each many screens long, written straight through the API.
	const paragraph = 'The road ran on past the toll gate and into the hills. '.repeat(6);
	const sceneIds: string[] = [];
	for (let n = 1; n <= 4; n++) {
		await page.getByRole('button', { name: 'New scene' }).click();
		await expect(page.locator('.scene-row')).toHaveCount(n);
		await expect(page).toHaveURL(/scene=/);
		const sceneId = new URL(page.url()).searchParams.get('scene')!;
		sceneIds.push(sceneId);
		const body = `Opening of part ${n}.\n\n` + Array(80).fill(paragraph).join('\n\n');
		const response = await page.request.put(`/api/scenes/${sceneId}`, {
			data: { title: `Part ${n}`, bodyMd: body }
		});
		expect(response.ok()).toBe(true);
	}

	await gotoReady(page, `${storyUrl}?view=story&scene=${sceneIds[0]}`);
	await expect(page.locator('.doc-scene')).toHaveCount(4);
	const first = page.locator(`#scene-${sceneIds[0]}`);
	const last = page.locator(`#scene-${sceneIds[3]}`);
	await expect(first.locator('.cm-editor')).toHaveCount(1);
	// Far below the fold: text only, no editor yet.
	await expect(last.locator('.cm-editor')).toHaveCount(0);
	await expect(last.locator('.prose-static')).toContainText('Opening of part 4.');

	// Scrolling to it mounts its editor, which then edits in place.
	await last.scrollIntoViewIfNeeded();
	await expect(last.locator('.cm-editor')).toHaveCount(1);
	await expect(last.locator('.prose-static')).toHaveCount(0);
	await expect(last.locator('.cm-content')).toContainText('Opening of part 4.');

	// Leaving the view and coming back starts lazy again.
	await page.getByRole('link', { name: 'Back to the scene editor' }).click();
	await expect(page).not.toHaveURL(/view=story/);
	await page.getByTitle('Read the whole story').click();
	await expect(page).toHaveURL(/view=story/);
	await expect(first.locator('.cm-editor')).toHaveCount(1);
	await expect(last.locator('.cm-editor')).toHaveCount(0);

	// Tabbing or clicking onto a scene that has not mounted yet puts the
	// caret in its editor.
	await last.getByRole('textbox', { name: 'Part 4' }).focus();
	await expect(last.locator('.cm-content')).toBeFocused();
});
