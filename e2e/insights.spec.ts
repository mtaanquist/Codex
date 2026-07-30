import { expect, test } from '@playwright/test';
import { gotoReady } from './navigate';
import { pickFromLibraryMenu, startStoryInUniverse } from './library';

// The universe Insights view: progress stats and the world heatmap render
// from a fresh universe's first words.
test('insights: words written show up in progress and the heatmap', async ({ page }) => {
	await gotoReady(page, '/');

	const universeName = `Insights Test ${Date.now()}`;
	await pickFromLibraryMenu(page, 'New universe');
	await page.getByLabel('New universe').fill(universeName);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText(`${universeName} - settings`);
	const universeId = page.url().match(/universes\/([^/?]+)/)![1];
	await gotoReady(page, '/');
	await startStoryInUniverse(page, universeName);
	await page.getByLabel('New story').fill('First Light');
	await page.getByRole('button', { name: 'Create story' }).click();
	await expect(page.locator('.story-title')).toHaveText('First Light');
	const storyRef = page.url().match(/stories\/([^/?]+)/)![1];

	// Write a few words so there is something to count.
	await page.getByRole('button', { name: 'New chapter' }).click();
	await expect(page.locator('.chapter-name')).toHaveText('Chapter 1');
	await page.getByRole('button', { name: 'New scene' }).click();
	await expect(page).toHaveURL(/scene=/);
	await page.locator('.cm-content').click();
	const save = page.waitForResponse(
		(response) =>
			response.url().includes('/api/scenes/') &&
			response.request().method() === 'PUT' &&
			response.ok()
	);
	await page.keyboard.type('Five words went down today.');
	await save;

	// A character no scene mentions, for the cold end of the heatmap.
	await gotoReady(page, `/universes/${universeId}/plan`);
	await page.getByPlaceholder('New character name').fill('Heimdall');
	await page.getByRole('button', { name: 'Add character' }).click();
	await expect(page.locator('.ent-row', { hasText: 'Heimdall' })).toBeVisible();

	// A sibling pair, for the relationship web. Wait for Freya to land before
	// opening the relationship form: its entity list is built from what the page
	// knows, so getting there first leaves a dropdown with no Freya in it.
	await page.getByPlaceholder('New character name').fill('Freya');
	await page.getByRole('button', { name: 'Add character' }).click();
	await expect(page.locator('.ent-row', { hasText: 'Freya' })).toBeVisible();
	await page.locator('.ent-row', { hasText: 'Heimdall' }).click();
	// The editor is keyed on the selected entity, so it remounts when the
	// selection lands. Opening the relationship form before that happens gets it
	// torn down mid-fill. Wait for Heimdall's own editor first.
	await expect(page.locator('.detail-title-input')).toHaveValue('Heimdall');
	await page.getByRole('button', { name: '+ Add relationship' }).click();
	await page.getByLabel('Relation').selectOption({ label: 'sibling of' });
	await page.getByLabel('Related entity').selectOption({ label: 'Freya' });
	await page.getByRole('button', { name: 'Add', exact: true }).click();
	await expect(page.locator('.rel-row', { hasText: 'Freya' })).toBeVisible();

	// Insights is a workspace view now: the ordinary three-pane shell, with the
	// mode strip at the top of the left pane and no mode current, the page's own
	// sections listed under it, and the Assistant alone in the right pane.
	await gotoReady(page, `/universes/${universeId}/insights`);
	await expect(page.getByRole('heading', { name: 'Insights', level: 1 })).toBeVisible();
	await expect(page.locator('.mode-strip .seg-btn.active')).toHaveCount(0);
	await expect(page.locator('.mode-note')).toContainText('no mode is current');
	const contents = page.getByRole('navigation', { name: 'Sections of this page' });
	await expect(contents.getByRole('link', { name: 'Writing sessions' })).toBeVisible();
	// The mode strip goes back to the work.
	await expect(page.locator('.mode-strip').getByRole('link', { name: 'Plan' })).toBeVisible();

	// Progress counts the words; the story row carries them too.
	await expect(page.locator('.admin-stat', { hasText: 'Total words' })).toContainText('5');
	await expect(page.getByRole('link', { name: 'First Light' })).toBeVisible();
	await expect(page.locator('.story-row', { hasText: 'First Light' })).toContainText('5 words');

	// The unmentioned character sits cold on the heatmap.
	const tile = page.locator('.heat-tile', { hasText: 'Heimdall' });
	await expect(tile).toContainText('Not mentioned yet');

	// The relationship web draws the sibling pair.
	const web = page.locator('svg.web');
	await expect(web.locator('.web-name', { hasText: 'Heimdall' })).toBeVisible();
	await expect(web.locator('.web-name', { hasText: 'Freya' })).toBeVisible();

	// The heat tile links to the plan entry.
	await tile.click();
	await expect(page.getByPlaceholder('Name', { exact: true })).toHaveValue('Heimdall');

	// The story plan lists the universe's other entities behind a fold.
	await gotoReady(page, `/stories/${storyRef}/plan`);
	// The "In the universe" list starts open; the row is right there.
	await page.locator('.uni-row', { hasText: 'Heimdall' }).click();
	await expect(page.getByPlaceholder('Name', { exact: true })).toHaveValue('Heimdall');

	// Writing sessions carries what the story pane's Session tab used to: today's
	// words and the days written lately.
	await gotoReady(page, `/universes/${universeId}/insights`);
	const sessions = page.locator('#sessions');
	await expect(sessions.getByRole('heading', { name: 'Writing sessions' })).toBeVisible();
	await expect(sessions.locator('.week-row .week-day.today')).toBeVisible();

	// Hiding the streak on the account page drops the week strip; the word
	// counts stay. Restore it for the other specs.
	await gotoReady(page, '/account');
	await page.getByRole('link', { name: 'Editor' }).click();
	await page.getByLabel('Writing streak').selectOption('hidden');
	await expect(page.getByRole('status')).toHaveText('Saved.');
	await gotoReady(page, `/universes/${universeId}/insights`);
	await expect(page.locator('#sessions .admin-stat').first()).toBeVisible();
	await expect(page.locator('.week-row')).toHaveCount(0);
	await gotoReady(page, '/account');
	await page.getByRole('link', { name: 'Editor' }).click();
	await page.getByLabel('Writing streak').selectOption('shown');
	await expect(page.getByRole('status')).toHaveText('Saved.');
});
