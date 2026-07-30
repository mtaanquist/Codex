import { expect, test } from '@playwright/test';
import { gotoReady } from './navigate';
import { pickFromLibraryMenu, startStoryInUniverse } from './library';

// The Notes view: reach it from the editor's right-rail Notes panel, write a
// note that persists, pin it, and confirm a story note shows under the
// universe view's reach via the "From the universe" peek.
test('write, persist, and pin a story note', async ({ page }) => {
	page.on('dialog', (dialog) => dialog.accept());

	await gotoReady(page, '/');

	const stamp = Date.now();
	await pickFromLibraryMenu(page, 'New universe');
	await page.getByLabel('New universe').fill(`Notefall ${stamp}`);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await gotoReady(page, '/');
	await startStoryInUniverse(page, `Notefall ${stamp}`);
	await page.getByLabel('New story').fill(`Logs ${stamp}`);
	await page.getByRole('button', { name: 'Create story' }).click();
	await expect(page).toHaveURL(`/stories/logs-${stamp}`);

	// Notes lives in the right rail: the panel is the way in, and with no
	// notes yet it offers the first one, landing on the Notes page.
	await page.getByRole('tab', { name: 'Notes' }).click();
	await expect(page.locator('.panel-body:not([hidden])')).toContainText('No notes in this story');
	await page.getByRole('button', { name: 'New note', exact: true }).click();
	await expect(page).toHaveURL(new RegExp(`/stories/logs-${stamp}/notes\\?note=`));

	// The strip on the Notes page lights nothing: Notes is not a mode.
	await expect(page.locator('.mode-strip .seg-btn')).toHaveCount(3);
	await expect(page.locator('.mode-strip .seg-btn.active')).toHaveCount(0);
	await expect(page.locator('.mode-note')).toContainText('Notes sit beside every mode');

	await page.getByPlaceholder('Untitled note').fill('Table talk');
	await page.locator('.cm-content').click();
	await page.keyboard.type('The party met at the Broken Crown.');
	await expect(page.locator('.saved')).toHaveText(/Saved just now/);

	// It survives a reload.
	await page.reload();
	await expect(page.getByPlaceholder('Untitled note')).toHaveValue('Table talk');
	await expect(page.locator('.cm-content')).toContainText('The party met at the Broken Crown.');

	// Pin it; it lands under the Pinned group in the sidebar.
	await page.getByRole('button', { name: 'Pin' }).click();
	await expect(page.locator('.group-label', { hasText: 'Pinned' })).toBeVisible();

	// One panel applies to a note, so the pane wears a title instead of a strip.
	await expect(page.locator('.pane.right .panel-strip')).toHaveCount(0);
	await expect(page.locator('.pane.right .panel-head-title')).toHaveText('History');
	await expect(page.locator('.pane.right .panel-head-sub')).toHaveText('this note');

	// A universe note shows in the story view under "From the universe".
	await gotoReady(page, `/universes/notefall-${stamp}/notes`);
	await page.getByRole('button', { name: 'New note' }).click();
	await page.getByPlaceholder('Untitled note').fill('World fact');
	await expect(page.locator('.saved')).toHaveText(/Saved just now/);

	await gotoReady(page, `/stories/logs-${stamp}/notes`);
	await expect(page.locator('.group-label', { hasText: 'From the universe' })).toBeVisible();
	await expect(page.locator('.note-row', { hasText: 'World fact' })).toBeVisible();
});

// The Notes panel beside the prose: the notes attached to the open scene, and
// one action that makes another.
test('a note on the open scene, from the Notes panel in Write', async ({ page }) => {
	await gotoReady(page, '/');

	const stamp = Date.now();
	await pickFromLibraryMenu(page, 'New universe');
	await page.getByLabel('New universe').fill(`Scenenote ${stamp}`);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await gotoReady(page, '/');
	await startStoryInUniverse(page, `Scenenote ${stamp}`);
	await page.getByLabel('New story').fill(`Attached ${stamp}`);
	await page.getByRole('button', { name: 'Create story' }).click();
	await expect(page).toHaveURL(`/stories/attached-${stamp}`);

	await page.getByRole('button', { name: 'New chapter' }).click();
	await expect(page.locator('.chapter-name')).toHaveText('Chapter 1');
	await page.getByRole('button', { name: 'New scene' }).click();
	await expect(page).toHaveURL(/scene=/);

	// The Notes panel is always on the strip, and starts empty.
	await expect(page.getByRole('tab', { name: 'Reference' })).toBeVisible();
	await page.getByRole('tab', { name: 'Notes' }).click();
	await expect(page.locator('.panel-body:not([hidden])')).toContainText('No notes in this story');

	// The action makes the note and opens it in Notes mode, where notes live.
	await page.getByRole('button', { name: 'New note on this scene' }).click();
	await expect(page).toHaveURL(new RegExp(`/stories/attached-${stamp}/notes\\?note=`));
	await page.getByPlaceholder('Untitled note').fill('Check the ledger count');
	await expect(page.locator('.saved')).toHaveText(/Saved just now/);

	// Back in Write, the scene's Notes panel lists it with a count on the tab.
	await gotoReady(page, `/stories/attached-${stamp}`);
	const notesTab = page.getByRole('tab', { name: 'Notes' });
	await expect(notesTab.locator('.seg-count')).toHaveText('1');
	await notesTab.click();
	await expect(page.locator('.panel-body:not([hidden])')).toContainText('Check the ledger count');

	// Arrow keys walk the strip, and the selected tab carries the state the
	// screen reader hears as well as the skin.
	await notesTab.press('Home');
	await expect(page.getByRole('tab', { name: 'Reference' })).toHaveAttribute(
		'aria-selected',
		'true'
	);
	await expect(notesTab).toHaveAttribute('aria-selected', 'false');

	// The quick-note jot: Ctrl+Alt+N over the editor, Ctrl+Enter to save. The
	// note attaches to the open scene and the panel picks it up.
	await page.keyboard.press('ControlOrMeta+Alt+KeyN');
	const jot = page.locator('.quick-note');
	await expect(jot).toBeVisible();
	await expect(jot).toContainText('on this scene');
	await page.keyboard.type('Ledger follow-up');
	await page.keyboard.press('ControlOrMeta+Enter');
	await expect(page.locator('.qn-saved')).toContainText('Saved.');
	await expect(notesTab.locator('.seg-count')).toHaveText('2');
	await notesTab.click();
	await expect(page.locator('.panel-body:not([hidden])')).toContainText('Ledger follow-up');
});
