import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';
import { e2eDatabaseUrl } from './database';
import { gotoReady } from './navigate';
import { pickFromLibraryMenu, startStoryInUniverse } from './library';
import { openRowMenu } from './context-menu';

// Runs as the account with the Assistant switched on.
test.use({ storageState: 'e2e/.auth/assistant.json' });

const DRAFT = 'Ilse stepped onto the ferry as the bell rang.\n\nThe river took them.';

// A story with one chapter and one empty scene, open in Write, with a model
// chosen for Write so a draft can be counted. Resolves to the scene's id.
async function storyWithScene(page: Page, universe: string, story: string): Promise<string> {
	await gotoReady(page, '/');
	await pickFromLibraryMenu(page, 'New universe');
	await page.getByLabel('New universe').fill(universe);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await gotoReady(page, '/');
	await startStoryInUniverse(page, universe);
	await page.getByLabel('New story').fill(story);
	await page.getByRole('button', { name: 'Create story' }).click();
	await expect(page).toHaveURL(/\/stories\//);
	await page.getByRole('button', { name: 'New chapter' }).click();
	await expect(page.locator('.chapter-name')).toHaveText('Chapter 1');
	await page.getByRole('button', { name: 'New scene' }).click();
	await expect(page).toHaveURL(/scene=/);
	const sceneId = new URL(page.url()).searchParams.get('scene')!;
	await sql(
		`update stories set llm_config = '{"models":{"coauthor":"e2e-model"}}'
		 where id = (select story_id from scenes where id = $1)`,
		[sceneId]
	);
	return sceneId;
}

async function sql<T extends pg.QueryResultRow>(text: string, values: unknown[]): Promise<T[]> {
	const pool = new pg.Pool({ connectionString: e2eDatabaseUrl() });
	try {
		return (await pool.query<T>(text, values)).rows;
	} finally {
		await pool.end();
	}
}

// #1168: the Assistant drafts a whole scene from a brief. Counting the cost
// and asking for the draft go through the real endpoints; the background job
// has no model to call, so the draft's row is then marked written as the job
// would leave it, and the job's status is stubbed. Reading the draft back,
// editing it and keeping it are real too.
test('a scene draft is costed first, waits for the writer, and fills the empty scene', async ({
	page
}) => {
	const stamp = Date.now();
	const sceneId = await storyWithScene(page, `Ferrymen ${stamp}`, `Crossing ${stamp}`);

	const asked: unknown[] = [];
	await page.route('**/api/assistant/draft', async (route) => {
		if (route.request().method() !== 'POST') return route.continue();
		const body = route.request().postDataJSON() as {
			defaults?: boolean;
			estimate?: boolean;
			brief?: string;
			targetWords?: number;
		};
		if (body.defaults || body.estimate) return route.continue();
		asked.push({ brief: body.brief, targetWords: body.targetWords });
		const response = await route.fetch();
		const { draftId } = (await response.json()) as { draftId: string };
		await sql(`update assistant_drafts set status = 'ready', text_md = $2 where id = $1`, [
			draftId,
			DRAFT
		]);
		await route.fulfill({ response });
	});
	await page.route('**/api/assistant/job-status*', async (route) => {
		await route.fulfill({ json: { state: 'done' } });
	});

	// Asked for from the scene's own menu.
	await openRowMenu(page, page.locator('.scene-row').first());
	await page.locator('.row-menu').getByRole('menuitem', { name: 'Assistant' }).hover();
	await page.locator('.row-submenu').getByRole('menuitem', { name: 'Draft this scene...' }).click();

	const card = page.getByRole('group', { name: 'Scene draft' });
	const briefBox = card.getByLabel('What happens in this scene');
	await briefBox.fill('Ilse takes the last ferry.');
	await card.getByLabel('Length in words').fill('900');

	// A form half filled in is still there after looking at another panel.
	await page.getByRole('tab', { name: 'Reference' }).click();
	await expect(card).toHaveCount(0);
	await page.getByRole('tab', { name: 'Assistant' }).click();
	await expect(briefBox).toHaveValue('Ilse takes the last ferry.');
	await expect(card.getByLabel('Length in words')).toHaveValue('900');

	await card.getByRole('button', { name: 'Check the cost' }).click();
	// The count is shown, the keyboard is on the button that starts the draft,
	// and nothing has been asked for yet.
	await expect(card).toContainText(/This sends about [\d,]+ tokens and writes up to [\d,]+\./);
	await expect(card).toContainText('This model has no price on record');
	await expect(card.getByRole('button', { name: 'Draft the scene' })).toBeFocused();
	expect(asked).toEqual([]);
	// Pressing again at once (a double press, a second click) starts nothing:
	// the cost has to have been on screen for a moment first.
	await page.keyboard.press('Enter');
	await page.waitForTimeout(100);
	await page.keyboard.press('Enter');
	await card.getByRole('button', { name: 'Draft the scene' }).dblclick();
	await page.waitForTimeout(300);
	expect(asked).toEqual([]);
	await expect(card.getByRole('button', { name: 'Draft the scene' })).toBeVisible();
	await page.waitForTimeout(800);
	// The second click of a double click starts nothing either, however long
	// the cost has been up.
	await card.getByRole('button', { name: 'Draft the scene' }).hover();
	await page.mouse.down({ clickCount: 2 });
	await page.mouse.up({ clickCount: 2 });
	await page.waitForTimeout(300);
	expect(asked).toEqual([]);
	await page.keyboard.press('Enter');

	// The finished draft waits in the panel; the scene is still empty.
	const text = card.getByLabel('Read it, and change anything you like before keeping it');
	await expect(text).toHaveValue(DRAFT);
	expect(asked).toEqual([{ brief: 'Ilse takes the last ferry.', targetWords: 900 }]);
	await expect(page.locator('.cm-content')).not.toContainText('Ilse stepped');

	// An edit is saved to the draft, so it is still there after a reload from
	// the link the draft's notice carries. The link opens the draft once: its
	// marker is then gone from the address.
	let edited = `${DRAFT}\n\nShe did not look back.`;
	const patched = () => page.waitForResponse((response) => response.request().method() === 'PATCH');
	let saved = patched();
	await text.fill(edited);
	await text.blur();
	expect((await saved).status()).toBe(200);

	// Asking again for the same scene brings the draft into view as it is. The
	// saved edit stays in the box, and the next edit saves over it.
	await openRowMenu(page, page.locator('.scene-row').first());
	await page.locator('.row-menu').getByRole('menuitem', { name: 'Assistant' }).hover();
	await page.locator('.row-submenu').getByRole('menuitem', { name: 'Draft this scene...' }).click();
	await expect(card).toBeFocused();
	await expect(text).toHaveValue(edited);
	await page.getByPlaceholder('Ask about your story', { exact: false }).fill('/draft');
	await page.keyboard.press('Enter');
	await page.keyboard.press('Enter');
	await expect(card).toBeFocused();
	await expect(text).toHaveValue(edited);
	edited = `${edited}\n\nThe bell rang on.`;
	saved = patched();
	await text.fill(edited);
	await text.blur();
	expect((await saved).status()).toBe(200);
	await expect(card).not.toContainText('changed in another window');

	// A link that also names the whole-story view opens the scene and its draft.
	await gotoReady(page, `/stories/crossing-${stamp}?view=story&scene=${sceneId}&draft=show`);
	await expect(text).toHaveValue(edited);
	await expect(page).not.toHaveURL(/view=story/);
	await expect(page.getByText('no longer in this story')).toHaveCount(0);
	await gotoReady(page, `/stories/crossing-${stamp}?scene=${sceneId}&draft=show`);
	await expect(text).toHaveValue(edited);
	await expect(page).not.toHaveURL(/draft=/);
	await expect(page).toHaveURL(new RegExp(`scene=${sceneId}`));

	// An edit is not lost to a reload that comes before the save was due.
	const hurried = `${edited}\n\nNot once.`;
	await text.fill(hurried);
	await page.reload();
	await page.getByRole('tab', { name: 'Assistant' }).click();
	await expect(text).toHaveValue(hurried);
	await text.fill(edited);
	await text.blur();

	// The writer's edit is what is kept, and it goes into the empty scene.
	await card.getByRole('button', { name: 'Fill this scene' }).click();
	await expect(page.locator('.cm-content')).toContainText('She did not look back.');
	await expect(card).toHaveCount(0);

	// It was saved to the scene itself, and no scene was added.
	await page.reload();
	await expect(page.locator('.cm-content')).toContainText('Ilse stepped onto the ferry');
	await expect(page.locator('.scene-row')).toHaveCount(1);

	// The notice's link, followed after the draft was decided, opens nothing:
	// not the draft, and not a new form.
	await gotoReady(page, `/stories/crossing-${stamp}?scene=${sceneId}&draft=show`);
	await expect(page).not.toHaveURL(/draft=/);
	await expect(page.getByPlaceholder('Ask about your story', { exact: false })).toBeVisible();
	await expect(card).toHaveCount(0);
});

test('a scene draft can be added as a new scene, and closing the form returns to the chat box', async ({
	page
}) => {
	const stamp = Date.now();
	const sceneId = await storyWithScene(page, `Bargemen ${stamp}`, `Landing ${stamp}`);

	// Closing the form puts the keyboard back in the chat box.
	const composer = page.getByPlaceholder('Ask about your story', { exact: false });
	await page.getByRole('tab', { name: 'Assistant' }).click();
	await composer.fill('/draft Ilse lands at dusk.');
	await page.keyboard.press('Enter');
	const card = page.getByRole('group', { name: 'Scene draft' });
	await expect(card.getByLabel('What happens in this scene')).toBeFocused();
	await expect(card.getByLabel('What happens in this scene')).toHaveValue('Ilse lands at dusk.');
	await card.getByRole('button', { name: 'Cancel' }).click();
	await expect(card).toHaveCount(0);
	await expect(composer).toBeFocused();

	// Asking again while a form is open keeps what is typed in it.
	const briefBox = card.getByLabel('What happens in this scene');
	// And a brief is not lost with an emptied length box when the card goes.
	await composer.fill('/draft Ilse counts the lamps.');
	await page.keyboard.press('Enter');
	await card.getByLabel('Length in words').fill('');
	await page.getByRole('tab', { name: 'Reference' }).click();
	await expect(card).toHaveCount(0);
	await page.getByRole('tab', { name: 'Assistant' }).click();
	await expect(briefBox).toHaveValue('Ilse counts the lamps.');
	await expect(card.getByLabel('Length in words')).toHaveValue('800');
	await card.getByRole('button', { name: 'Cancel' }).click();
	await expect(card).toHaveCount(0);
	await composer.fill('/draft Ilse lands at dusk.');
	await page.keyboard.press('Enter');
	await briefBox.fill('Typed by hand, half done');
	await card.getByLabel('Point of view (optional)').fill('Ilse');
	await openRowMenu(page, page.locator('.scene-row').first());
	await page.locator('.row-menu').getByRole('menuitem', { name: 'Assistant' }).hover();
	await page.locator('.row-submenu').getByRole('menuitem', { name: 'Draft this scene...' }).click();
	await expect(briefBox).toBeFocused();
	await expect(briefBox).toHaveValue('Typed by hand, half done');
	await expect(card.getByLabel('Point of view (optional)')).toHaveValue('Ilse');
	// So does a reload, until the form is cancelled.
	await page.reload();
	await page.getByRole('tab', { name: 'Assistant' }).click();
	await expect(briefBox).toHaveValue('Typed by hand, half done');
	await card.getByRole('button', { name: 'Cancel' }).click();
	await page.reload();
	await page.getByRole('tab', { name: 'Assistant' }).click();
	await expect(composer).toBeVisible();
	await expect(card).toHaveCount(0);

	// A draft that could not be written offers another try, with its brief.
	const stage = (status: string, text: string, note: string | null) =>
		sql(
			`insert into assistant_drafts
			   (user_id, story_id, scene_id, brief, target_words, text_md, status, note, job_id)
			 select st.owner_id, sc.story_id, sc.id, 'The landing.', 800, $2, $3, $4, gen_random_uuid()
			 from scenes sc join stories st on st.id = sc.story_id where sc.id = $1`,
			[sceneId, text, status, note]
		);
	await stage('failed', '', 'The model did not answer.');
	await gotoReady(page, `/stories/landing-${stamp}?scene=${sceneId}&draft=show`);
	await expect(card).toContainText('The model did not answer.');
	await card.getByRole('button', { name: 'Try again' }).click();
	await expect(briefBox).toHaveValue('The landing.');
	await card.getByRole('button', { name: 'Cancel' }).click();
	await expect(card).toContainText('The model did not answer.');

	// The story is then muted: nothing new can be asked for, but what is
	// already there can still be decided.
	await sql(
		`update stories set llm_config = '{"enabled":false}'
		 where id = (select story_id from scenes where id = $1)`,
		[sceneId]
	);
	await gotoReady(page, `/stories/landing-${stamp}?scene=${sceneId}&draft=show`);
	await expect(page.getByText('The Assistant is off for this story.')).toBeVisible();
	await expect(card).toContainText('The model did not answer.');
	await expect(card.getByRole('button', { name: 'Try again' })).toHaveCount(0);
	await expect(composer).toHaveCount(0);
	await card.getByRole('button', { name: 'Discard' }).click();
	await expect(card).toHaveCount(0);

	// A draft the job has written, waiting on the scene.
	await stage('ready', DRAFT, null);
	await gotoReady(page, `/stories/landing-${stamp}?scene=${sceneId}&draft=1`);
	await expect(page.getByText('The Assistant is off for this story.')).toBeVisible();
	await expect(
		card.getByLabel('Read it, and change anything you like before keeping it')
	).toHaveValue(DRAFT);

	await card.getByRole('button', { name: 'Add as a new scene after this one' }).click();
	// The new scene opens with the draft in it; the first scene is untouched.
	await expect(page.locator('.scene-row')).toHaveCount(2);
	await expect(page.locator('.cm-content')).toContainText('Ilse stepped onto the ferry');
	await expect(page).not.toHaveURL(new RegExp(`scene=${sceneId}`));
	await expect(card).toHaveCount(0);
	const rows = await sql<{ chars: number }>(
		`select length(body_md) as chars from scenes where id = $1`,
		[sceneId]
	);
	expect(rows[0].chars).toBe(0);
});

// A draft waiting on the scene, as the job would leave it. Resolves to its id.
async function stageDraft(sceneId: string, text: string, status = 'ready'): Promise<string> {
	const [row] = await sql<{ id: string }>(
		`insert into assistant_drafts
		   (user_id, story_id, scene_id, brief, target_words, text_md, status, job_id)
		 select st.owner_id, sc.story_id, sc.id, 'The landing.', 800, $2, $3, gen_random_uuid()
		 from scenes sc join stories st on st.id = sc.story_id where sc.id = $1
		 returning id`,
		[sceneId, text, status]
	);
	return row.id;
}

// #1168: the same draft open in two windows. The second window is played by
// the database: what it saved or decided is written there directly.
test('a draft changed or decided in another window is said so, and typing is not lost', async ({
	page
}) => {
	const stamp = Date.now();
	const sceneId = await storyWithScene(page, `Wharfmen ${stamp}`, `Mooring ${stamp}`);
	const link = `/stories/mooring-${stamp}?scene=${sceneId}&draft=show`;
	const card = page.getByRole('group', { name: 'Scene draft' });
	const text = card.getByLabel('Read it, and change anything you like before keeping it');
	const patched = () => page.waitForResponse((response) => response.request().method() === 'PATCH');

	// Changed there: the save from here is refused, and the writer chooses to
	// load the current text.
	const first = await stageDraft(sceneId, 'The rope held.');
	await gotoReady(page, link);
	await expect(text).toHaveValue('The rope held.');
	await sql(`update assistant_drafts set text_md = 'The rope held, just.' where id = $1`, [first]);
	let saved = patched();
	await text.fill('The rope held. Then the tide turned.');
	await text.blur();
	expect((await saved).status()).toBe(409);
	await expect(card).toContainText('This draft was changed in another window.');
	// Nothing is replaced until they ask.
	await expect(text).toHaveValue('The rope held. Then the tide turned.');
	await card.getByRole('button', { name: 'Load the current text' }).click();
	await expect(text).toHaveValue('The rope held, just.');
	await expect(card).not.toContainText('changed in another window');
	saved = patched();
	await text.fill('The rope held, just. Then the tide turned.');
	await text.blur();
	expect((await saved).status()).toBe(200);

	// Discarded there, with nothing unsaved here: asking again opens a form
	// for the new brief, not the card of a draft that is gone.
	await sql(`update assistant_drafts set status = 'discarded' where id = $1`, [first]);
	const composer = page.getByPlaceholder('Ask about your story', { exact: false });
	await composer.fill('/draft Ilse cuts the rope.');
	await page.keyboard.press('Enter');
	await expect(card.getByLabel('What happens in this scene')).toHaveValue('Ilse cuts the rope.');
	await card.getByRole('button', { name: 'Cancel' }).click();
	await expect(card).toHaveCount(0);

	// Kept there, with typing here that was never saved: a decision here says
	// what happened and leaves the typing to copy.
	const second = await stageDraft(sceneId, 'The barge swung out.');
	await gotoReady(page, link);
	await expect(text).toHaveValue('The barge swung out.');
	await sql(`update assistant_drafts set status = 'accepted' where id = $1`, [second]);
	await text.fill('The barge swung out. Nobody shouted.');
	await card.getByRole('button', { name: 'Add as a new scene after this one' }).click();
	await expect(card).toContainText('This draft was already kept or discarded in another window.');
	await expect(
		card.getByLabel('What you had typed here was not saved', { exact: false })
	).toHaveValue('The barge swung out. Nobody shouted.');
	await expect(card.getByRole('button', { name: 'Add as a new scene after this one' })).toHaveCount(
		0
	);
	await expect(page.locator('.scene-row')).toHaveCount(1);
	await card.getByRole('button', { name: 'Close' }).click();
	await expect(card).toHaveCount(0);
	await expect(composer).toBeFocused();

	// Discarded there, nothing typed here: Discard here closes with the reason.
	const third = await stageDraft(sceneId, 'The lamps went out.');
	await gotoReady(page, link);
	await expect(text).toHaveValue('The lamps went out.');
	await sql(`update assistant_drafts set status = 'discarded' where id = $1`, [third]);
	await card.getByRole('button', { name: 'Discard' }).click();
	await expect(card).toContainText('This draft was already kept or discarded in another window.');
	await expect(card.getByLabel('What you had typed here', { exact: false })).toHaveCount(0);
	await card.getByRole('button', { name: 'Close' }).click();
	await expect(card).toHaveCount(0);
});

// #1168: the writer types in a draft that another window has just kept or
// discarded. The refused save says what happened, with the typing to copy,
// whether or not the card was on screen when the answer came.
test('typing in a draft decided in another window is kept to copy', async ({ page }) => {
	const stamp = Date.now();
	const sceneId = await storyWithScene(page, `Bargemen ${stamp}`, `Towpath ${stamp}`);
	const link = `/stories/towpath-${stamp}?scene=${sceneId}&draft=show`;
	const card = page.getByRole('group', { name: 'Scene draft' });
	const text = card.getByLabel('Read it, and change anything you like before keeping it');
	const copy = card.getByLabel('What you had typed here was not saved', { exact: false });
	const gone = 'This draft was already kept or discarded in another window.';

	// With the card on screen: no "changed in another window", nothing to
	// load, and no choices left for a draft that is gone.
	const first = await stageDraft(sceneId, 'The horse stopped.');
	await gotoReady(page, link);
	await expect(text).toHaveValue('The horse stopped.');
	await sql(`update assistant_drafts set status = 'discarded' where id = $1`, [first]);
	await text.fill('The horse stopped. So did the boy.');
	await text.blur();
	await expect(card).toContainText(gone);
	await expect(copy).toHaveValue('The horse stopped. So did the boy.');
	await expect(card).not.toContainText('Reload the page');
	await expect(card.getByRole('button', { name: 'Load the current text' })).toHaveCount(0);
	await expect(card.getByRole('button', { name: 'Discard' })).toHaveCount(0);
	// Taken away before it is closed, the card comes back with it.
	await page.getByRole('tab', { name: 'Reference' }).click();
	await page.getByRole('tab', { name: 'Assistant' }).click();
	await expect(copy).toHaveValue('The horse stopped. So did the boy.');
	await card.getByRole('button', { name: 'Close' }).click();
	await expect(card).toHaveCount(0);
	await page.getByRole('tab', { name: 'Reference' }).click();
	await page.getByRole('tab', { name: 'Assistant' }).click();
	await expect(card).toHaveCount(0);

	// With the card gone by the time the save is answered: the writer types,
	// then switches pane, and the refusal comes back to no card.
	const second = await stageDraft(sceneId, 'The lock was full.');
	await gotoReady(page, link);
	await expect(text).toHaveValue('The lock was full.');
	await sql(`update assistant_drafts set status = 'accepted' where id = $1`, [second]);
	await page.route('**/api/assistant/draft/*', async (route) => {
		if (route.request().method() === 'PATCH') await new Promise((r) => setTimeout(r, 500));
		await route.continue();
	});
	const refused = page.waitForResponse((response) => response.request().method() === 'PATCH');
	await text.fill('The lock was full. The gates would not move.');
	await page.getByRole('tab', { name: 'Reference' }).click();
	expect((await refused).status()).toBe(409);
	await page.getByRole('tab', { name: 'Assistant' }).click();
	await expect(card).toContainText(gone);
	await expect(copy).toHaveValue('The lock was full. The gates would not move.');
	await card.getByRole('button', { name: 'Close' }).click();
	await expect(card).toHaveCount(0);
	await page.unroute('**/api/assistant/draft/*');

	// A brief left half typed is still there after a draft that reached the
	// scene another way has been dealt with.
	const composer = page.getByPlaceholder('Ask about your story', { exact: false });
	await composer.fill('/draft The boy.');
	await page.keyboard.press('Enter');
	const brief = card.getByLabel('What happens in this scene');
	await brief.fill('The boy leads the horse back.');
	const pov = card.getByLabel('Point of view (optional)');
	await pov.fill('the boy');
	await stageDraft(sceneId, 'From a chapter run.');
	await gotoReady(page, link);
	await expect(text).toHaveValue('From a chapter run.');
	await card.getByRole('button', { name: 'Discard' }).click();
	await expect(card).toHaveCount(0);
	// Asked for again with no reload, from the scene's menu: the form comes
	// back as it was left, not with the scene's suggested brief.
	await openRowMenu(page, page.locator('.scene-row').first());
	await page.locator('.row-menu').getByRole('menuitem', { name: 'Assistant' }).hover();
	await page.locator('.row-submenu').getByRole('menuitem', { name: 'Draft this scene...' }).click();
	await expect(brief).toHaveValue('The boy leads the horse back.');
	await expect(pov).toHaveValue('the boy');
	// The same after a second draft, asked for with words: they replace the
	// brief and nothing else.
	await stageDraft(sceneId, 'From another run.');
	await gotoReady(page, link);
	await expect(text).toHaveValue('From another run.');
	await card.getByRole('button', { name: 'Discard' }).click();
	await expect(card).toHaveCount(0);
	await composer.fill('/draft The horse bolts.');
	await page.keyboard.press('Enter');
	await expect(brief).toHaveValue('The horse bolts.');
	await expect(pov).toHaveValue('the boy');
	await gotoReady(page, link);
	await expect(brief).toHaveValue('The horse bolts.');
});

// #1168: on a story with the Assistant turned off, the panel lists the drafts
// that wait on other scenes, one still being written among them.
test('a muted story lists its waiting drafts, and one being written can be stopped', async ({
	page
}) => {
	const stamp = Date.now();
	const first = await storyWithScene(page, `Lightermen ${stamp}`, `Slipway ${stamp}`);
	await page.getByRole('button', { name: 'New scene' }).click();
	await expect(page).not.toHaveURL(new RegExp(`scene=${first}`));
	const second = new URL(page.url()).searchParams.get('scene')!;
	await page.getByRole('button', { name: 'New scene' }).click();
	await expect(page).not.toHaveURL(new RegExp(`scene=${second}`));
	const third = new URL(page.url()).searchParams.get('scene')!;
	await stageDraft(first, 'The slip was greased.');
	const writing = await stageDraft(second, '', 'running');
	await sql(
		`update stories set llm_config = llm_config || '{"enabled":false}'::jsonb
		 where id = (select story_id from scenes where id = $1)`,
		[first]
	);

	// The job is the test's to answer for: running until Stop, then stopped.
	let state = 'running';
	await page.route('**/api/assistant/job-status*', (route) => route.fulfill({ json: { state } }));
	await page.route('**/api/assistant/job-stop', async (route) => {
		await sql(
			`update assistant_drafts set status = 'discarded',
			   note = 'You stopped this draft before it finished.' where id = $1`,
			[writing]
		);
		state = 'stopped';
		await route.fulfill({ json: { ok: true } });
	});

	await gotoReady(page, `/stories/slipway-${stamp}?scene=${third}`);
	await page.getByRole('tab', { name: 'Assistant' }).click();
	await expect(page.getByText('The Assistant is off for this story.')).toBeVisible();
	const list = page.getByRole('list', { name: 'Drafts on other scenes' });
	await expect(list.getByRole('listitem')).toHaveCount(2);
	await expect(list.getByRole('listitem').nth(0)).toContainText('Ready');
	await expect(list.getByRole('listitem').nth(1)).toContainText('Being written');

	// The one being written opens on its card, which can stop it.
	await list.getByRole('link').nth(1).click();
	await expect(page).toHaveURL(new RegExp(`scene=${second}`));
	const card = page.getByRole('group', { name: 'Scene draft' });
	await expect(card).toContainText('Drafting this scene');
	await expect(list.getByRole('listitem')).toHaveCount(1);
	await card.getByRole('button', { name: 'Stop' }).click();
	await expect(card).toHaveCount(0);

	// The list follows a draft being written on its own, with no reload.
	const again = await stageDraft(second, '', 'running');
	state = 'running';
	await gotoReady(page, `/stories/slipway-${stamp}?scene=${third}`);
	await page.getByRole('tab', { name: 'Assistant' }).click();
	await expect(list.getByRole('listitem')).toHaveCount(2);
	await expect(list.getByRole('listitem').nth(1)).toContainText('Being written');
	await sql(`update assistant_drafts set status = 'ready', text_md = 'Written.' where id = $1`, [
		again
	]);
	await expect(list.getByRole('listitem').nth(1)).toContainText('Ready', { timeout: 20_000 });
});
