import { expect, test } from '@playwright/test';
import pg from 'pg';
import { e2eDatabaseUrl } from './database';
import { gotoReady } from './navigate';
import { pickFromLibraryMenu, startStoryInUniverse } from './library';

// Runs as the default account, which has the Assistant off.

// #1168: a draft written while the Assistant was on is not stranded when the
// account turns it off. The Assistant tab stays for the drafts that wait,
// shows only them, and goes with the last one.
test('with the Assistant off, a waiting draft can still be kept and nothing can be asked for', async ({
	page
}) => {
	await gotoReady(page, '/');
	const stamp = Date.now();
	await pickFromLibraryMenu(page, 'New universe');
	await page.getByLabel('New universe').fill(`Lockmen ${stamp}`);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await gotoReady(page, '/');
	await startStoryInUniverse(page, `Lockmen ${stamp}`);
	await page.getByLabel('New story').fill(`Sluice ${stamp}`);
	await page.getByRole('button', { name: 'Create story' }).click();
	await expect(page).toHaveURL(/\/stories\//);
	await page.getByRole('button', { name: 'New chapter' }).click();
	await expect(page.locator('.chapter-name')).toHaveText('Chapter 1');
	await page.getByRole('button', { name: 'New scene' }).click();
	await expect(page).toHaveURL(/scene=/);
	const sceneId = new URL(page.url()).searchParams.get('scene')!;

	// No Assistant tab while there is nothing of the Assistant's here.
	const tab = page.getByRole('tab', { name: 'Assistant' });
	await expect(page.getByRole('tab', { name: 'Reference' })).toBeVisible();
	await expect(tab).toHaveCount(0);

	const pool = new pg.Pool({ connectionString: e2eDatabaseUrl() });
	try {
		await pool.query(
			`insert into assistant_drafts
			   (user_id, story_id, scene_id, brief, target_words, text_md, status, job_id)
			 select st.owner_id, sc.story_id, sc.id, 'The sluice.', 800,
			        'The gate held. Then it did not.', 'ready', gen_random_uuid()
			 from scenes sc join stories st on st.id = sc.story_id where sc.id = $1`,
			[sceneId]
		);
	} finally {
		await pool.end();
	}

	await gotoReady(page, `/stories/sluice-${stamp}?scene=${sceneId}&draft=show`);
	await expect(page.getByText('The Assistant is off for your account.')).toBeVisible();
	const card = page.getByRole('group', { name: 'Scene draft' });
	await expect(
		card.getByLabel('Read it, and change anything you like before keeping it')
	).toHaveValue('The gate held. Then it did not.');
	// Only the draft is here: no chat box, no form, no way to ask for more.
	await expect(page.getByPlaceholder('Ask about your story', { exact: false })).toHaveCount(0);
	await expect(page.getByLabel('What happens in this scene')).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Turn on for this story' })).toHaveCount(0);

	// A link that would open the form on an Assistant that is on opens none.
	await gotoReady(page, `/stories/sluice-${stamp}?scene=${sceneId}&draft=1`);
	await expect(card).toBeVisible();
	await expect(page.getByLabel('What happens in this scene')).toHaveCount(0);

	await card.getByRole('button', { name: 'Fill this scene' }).click();
	await expect(page.locator('.cm-content')).toContainText('The gate held.');
	// The last draft is decided, so the tab goes.
	await expect(tab).toHaveCount(0);
});
