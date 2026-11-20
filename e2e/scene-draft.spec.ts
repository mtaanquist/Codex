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
	await expect(card).toContainText(/This sends about [\d,]+ tokens and writes about [\d,]+\./);
	await expect(card).toContainText('This model has no price on record');
	await expect(card.getByRole('button', { name: 'Draft the scene' })).toBeFocused();
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
	const edited = `${DRAFT}\n\nShe did not look back.`;
	const saved = page.waitForResponse(
		(response) => response.request().method() === 'PATCH' && response.ok()
	);
	await text.fill(edited);
	await text.blur();
	await saved;
	await gotoReady(page, `/stories/crossing-${stamp}?scene=${sceneId}&draft=1`);
	await expect(text).toHaveValue(edited);
	await expect(page).not.toHaveURL(/draft=1/);
	await expect(page).toHaveURL(new RegExp(`scene=${sceneId}`));

	// The writer's edit is what is kept, and it goes into the empty scene.
	await card.getByRole('button', { name: 'Fill this scene' }).click();
	await expect(page.locator('.cm-content')).toContainText('She did not look back.');
	await expect(card).toHaveCount(0);

	// It was saved to the scene itself, and no scene was added.
	await page.reload();
	await expect(page.locator('.cm-content')).toContainText('Ilse stepped onto the ferry');
	await expect(page.locator('.scene-row')).toHaveCount(1);
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

	// A draft the job has written, waiting on the scene.
	await sql(
		`insert into assistant_drafts
		   (user_id, story_id, scene_id, brief, target_words, text_md, status, job_id)
		 select st.owner_id, sc.story_id, sc.id, 'The landing.', 800, $2, 'ready', gen_random_uuid()
		 from scenes sc join stories st on st.id = sc.story_id where sc.id = $1`,
		[sceneId, DRAFT]
	);
	// The story is then muted: the draft already written can still be kept.
	await sql(
		`update stories set llm_config = '{"enabled":false}'
		 where id = (select story_id from scenes where id = $1)`,
		[sceneId]
	);
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
