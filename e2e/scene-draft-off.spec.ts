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
	// A second scene, with no draft of its own.
	await page.getByRole('button', { name: 'New scene' }).click();
	await expect(page).not.toHaveURL(new RegExp(`scene=${sceneId}`));
	const otherId = new URL(page.url()).searchParams.get('scene')!;
	// And a third, whose draft is still being written.
	await page.getByRole('button', { name: 'New scene' }).click();
	await expect(page).not.toHaveURL(new RegExp(`scene=${otherId}`));
	const writingId = new URL(page.url()).searchParams.get('scene')!;

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
		await pool.query(
			`insert into assistant_drafts
			   (user_id, story_id, scene_id, brief, target_words, status, job_id)
			 select st.owner_id, sc.story_id, sc.id, 'The weir.', 800, 'running', gen_random_uuid()
			 from scenes sc join stories st on st.id = sc.story_id where sc.id = $1`,
			[writingId]
		);
	} finally {
		await pool.end();
	}
	// The job that writes it is the test's to answer for.
	let state = 'running';
	await page.route('**/api/assistant/job-status*', (route) => route.fulfill({ json: { state } }));
	await page.route('**/api/assistant/job-stop', async (route) => {
		const stopping = new pg.Pool({ connectionString: e2eDatabaseUrl() });
		try {
			await stopping.query(
				`update assistant_drafts set status = 'discarded',
				   note = 'You stopped this draft before it finished.' where scene_id = $1`,
				[writingId]
			);
		} finally {
			await stopping.end();
		}
		state = 'stopped';
		await route.fulfill({ json: { ok: true } });
	});

	// On a scene without the draft, the tab lists where the draft is.
	await gotoReady(page, `/stories/sluice-${stamp}?scene=${otherId}`);
	await tab.click();
	await expect(page.getByText('The Assistant is off for your account.')).toBeVisible();
	const card = page.getByRole('group', { name: 'Scene draft' });
	await expect(card).toHaveCount(0);
	const elsewhere = page.getByRole('list', { name: 'Drafts on other scenes' });
	await expect(elsewhere.getByRole('listitem')).toHaveCount(2);
	await expect(elsewhere.getByRole('listitem').nth(0)).toContainText('Ready');
	await expect(elsewhere.getByRole('listitem').nth(1)).toContainText('Being written');
	// The one being written can be seen and stopped though the Assistant is off.
	await elsewhere.getByRole('link').nth(1).click();
	await expect(page).toHaveURL(new RegExp(`scene=${writingId}`));
	await expect(card).toContainText('Drafting this scene');
	await card.getByRole('button', { name: 'Stop' }).click();
	await expect(card).toHaveCount(0);
	await gotoReady(page, `/stories/sluice-${stamp}?scene=${otherId}`);
	await tab.click();
	await expect(elsewhere.getByRole('listitem')).toHaveCount(1);
	await elsewhere.getByRole('link').click();
	await expect(page).toHaveURL(new RegExp(`scene=${sceneId}`));
	await expect(card).toBeVisible();
	// The open scene's draft is the card, not a line in the list.
	await expect(elsewhere).toHaveCount(0);

	await gotoReady(page, `/stories/sluice-${stamp}?scene=${sceneId}&draft=show`);
	await expect(page.getByText('The Assistant is off for your account.')).toBeVisible();
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
	// The last draft is decided, so the tab goes, and the keyboard is in the
	// scene, not lost with the card.
	await expect(tab).toHaveCount(0);
	await expect(page.locator('.cm-content')).toBeFocused();
});
