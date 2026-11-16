import { expect, test } from '@playwright/test';
import { gotoReady, waitForHydration } from './navigate';
import { pickFromLibraryMenu, startStoryInUniverse } from './library';
import { confirmPrompt } from './confirm';

// A saved draft keeps the story as it was: save one, keep writing, open the
// draft from the editor's path and from the library cover, compare a scene,
// and restore it without losing the newer text from History.
test('save a draft, switch to it, and restore a scene', async ({ page }) => {
	test.slow();
	const stamp = Date.now();
	await gotoReady(page, '/');
	await pickFromLibraryMenu(page, 'New universe');
	await page.getByLabel('New universe').fill(`Draftworld ${stamp}`);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await gotoReady(page, '/');
	await startStoryInUniverse(page, `Draftworld ${stamp}`);
	await page.getByLabel('New story').fill(`Tides ${stamp}`);
	await page.getByRole('button', { name: 'Create story' }).click();
	await expect(page).toHaveURL(`/stories/tides-${stamp}`);
	const path = page.getByRole('navigation', { name: 'Where you are' });
	// No drafts yet, so the path stops at the story.
	await expect(path.getByRole('button', { name: 'Working draft' })).toHaveCount(0);

	await page.getByRole('button', { name: 'New chapter' }).click();
	await expect(page.locator('.chapter-name')).toHaveText('Chapter 1');
	await page.getByRole('button', { name: 'New scene' }).click();
	await expect(page).toHaveURL(/scene=/);
	await page.getByRole('textbox', { name: 'Scene text' }).click();
	await page.keyboard.type('The tide came in at dusk.');
	await expect(page.locator('.saved')).toHaveText(/Saved just now/);

	// Save a draft from the story's settings.
	await gotoReady(page, `/stories/tides-${stamp}/settings/drafts`);
	await page.locator('#draft-label').fill('First draft');
	await page.getByRole('button', { name: 'Save draft' }).click();
	await expect(page.getByRole('status')).toContainText('Draft saved.');

	// Keep writing in the working draft.
	await gotoReady(page, `/stories/tides-${stamp}`);
	await page.getByRole('textbox', { name: 'Scene text' }).click();
	await page.keyboard.press('ControlOrMeta+a');
	await page.keyboard.type('The tide never came.');
	await expect(page.locator('.saved')).toHaveText(/Saved just now/);

	// The path now names the working draft, and its menu opens the saved one.
	await waitForHydration(page);
	const draftCrumb = path.getByRole('button', { name: 'Working draft' });
	await draftCrumb.click();
	const menu = page.getByRole('menu');
	await expect(menu.getByRole('menuitem', { name: 'Working draft' })).toHaveAttribute(
		'aria-current',
		'page'
	);
	await menu.getByRole('menuitem', { name: 'First draft' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('First draft');
	await expect(path.getByRole('button', { name: 'First draft' })).toBeVisible();
	await expect(page.locator('.reader-prose')).toContainText('The tide came in at dusk.');
	await expect(page.getByText('Changed since')).toBeVisible();

	// Compare shows both versions; restoring asks first.
	await waitForHydration(page);
	await page.getByRole('button', { name: 'Compare with working draft' }).click();
	await expect(page.locator('.diff-add')).toContainText('The tide never came.');
	await expect(page.locator('.diff-del')).toContainText('The tide came in at dusk.');
	await page.getByRole('button', { name: 'Restore this scene' }).click();
	await confirmPrompt(page, 'Restore scene');
	await expect(page.getByRole('status')).toContainText('The text it replaced is in its History');
	await expect(page.getByText('Same as the working draft')).toBeVisible();

	// The working draft has the saved text back.
	await page.getByRole('link', { name: 'Open the scene' }).click();
	await expect(page.locator('.cm-content')).toContainText('The tide came in at dusk.');

	// The library cover offers the same drafts.
	await gotoReady(page, '/');
	await page.getByRole('button', { name: `Drafts of Tides ${stamp}` }).click();
	await page.getByRole('menuitem', { name: 'First draft' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('First draft');
});
