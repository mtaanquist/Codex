import { expect, test } from '@playwright/test';
import pg from 'pg';
import { e2eDatabaseUrl } from './database';
import { gotoReady } from './navigate';
import { pickFromLibraryMenu, startStoryInUniverse } from './library';
import { openRowMenu } from './context-menu';

// Runs as the account with the Assistant switched on.
test.use({ storageState: 'e2e/.auth/assistant.json' });

const DRAFT = 'Ilse stepped onto the ferry as the bell rang.\n\nThe river took them.';

// #1168: the Assistant drafts a whole scene from a brief. The draft is written
// by a background job, so the cost count, the request and the job status are
// stubbed (no model or worker is needed) and the finished draft is written to
// the database as the job would leave it. Reading the draft back and keeping
// it go through the real endpoints.
test('a scene draft is costed first, waits for the writer, and fills the empty scene', async ({
	page
}) => {
	await gotoReady(page, '/');
	const stamp = Date.now();
	await pickFromLibraryMenu(page, 'New universe');
	await page.getByLabel('New universe').fill(`Ferrymen ${stamp}`);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await gotoReady(page, '/');
	await startStoryInUniverse(page, `Ferrymen ${stamp}`);
	await page.getByLabel('New story').fill(`Crossing ${stamp}`);
	await page.getByRole('button', { name: 'Create story' }).click();
	await expect(page).toHaveURL(`/stories/crossing-${stamp}`);
	await page.getByRole('button', { name: 'New chapter' }).click();
	await expect(page.locator('.chapter-name')).toHaveText('Chapter 1');
	await page.getByRole('button', { name: 'New scene' }).click();
	await expect(page).toHaveURL(/scene=/);
	const sceneId = new URL(page.url()).searchParams.get('scene')!;

	const requests: unknown[] = [];
	await page.route('**/api/assistant/draft', async (route) => {
		const body = route.request().postDataJSON() as {
			defaults?: boolean;
			estimate?: boolean;
			brief?: string;
			targetWords?: number;
		};
		// What the form opens with comes from the real endpoint.
		if (body.defaults) return route.continue();
		if (body.estimate) {
			await route.fulfill({
				json: {
					model: 'stub',
					estTokens: 4200,
					estCompletionTokens: 1260,
					estCostUsd: 0.03,
					overCap: false
				}
			});
			return;
		}
		requests.push({ brief: body.brief, targetWords: body.targetWords });
		const pool = new pg.Pool({ connectionString: e2eDatabaseUrl() });
		try {
			const { rows } = await pool.query<{ id: string }>(
				`insert into assistant_drafts
				   (user_id, story_id, scene_id, brief, target_words, text_md, status, job_id)
				 select st.owner_id, sc.story_id, sc.id, $2, $3, $4, 'ready', 'job-1'
				 from scenes sc join stories st on st.id = sc.story_id where sc.id = $1
				 returning id`,
				[sceneId, body.brief, body.targetWords, DRAFT]
			);
			await route.fulfill({ json: { ok: true, jobId: 'job-1', draftId: rows[0].id } });
		} finally {
			await pool.end();
		}
	});
	await page.route('**/api/assistant/job-status*', async (route) => {
		await route.fulfill({ json: { state: 'done' } });
	});

	// Asked for from the scene's own menu.
	await openRowMenu(page, page.locator('.scene-row').first());
	await page.locator('.row-menu').getByRole('menuitem', { name: 'Assistant' }).hover();
	await page.locator('.row-submenu').getByRole('menuitem', { name: 'Draft this scene...' }).click();

	const card = page.getByRole('group', { name: 'Scene draft' });
	await card.getByLabel('What happens in this scene').fill('Ilse takes the last ferry.');
	await card.getByLabel('Length in words').fill('900');
	await card.getByRole('button', { name: 'Check the cost' }).click();
	// The count is shown and nothing has been asked for yet.
	await expect(card).toContainText(
		'This sends about 4,200 tokens and writes about 1,260 (about $0.03).'
	);
	expect(requests).toEqual([]);
	await card.getByRole('button', { name: 'Draft the scene' }).click();

	// The finished draft waits in the panel; the scene is still empty.
	const text = card.getByLabel('Read it, and change anything you like before keeping it');
	await expect(text).toHaveValue(DRAFT);
	expect(requests).toEqual([{ brief: 'Ilse takes the last ferry.', targetWords: 900 }]);
	await expect(page.locator('.cm-content')).not.toContainText('Ilse stepped');

	// It is still there after a reload, from the link its notice carries.
	await gotoReady(page, `/stories/crossing-${stamp}?scene=${sceneId}&draft=1`);
	await expect(text).toHaveValue(DRAFT);

	// The writer's edit is what is kept, and it goes into the empty scene.
	await text.fill(`${DRAFT}\n\nShe did not look back.`);
	await card.getByRole('button', { name: 'Fill this scene' }).click();
	await expect(page.locator('.cm-content')).toContainText('She did not look back.');
	await expect(card).toHaveCount(0);

	// It was saved to the scene itself, and no scene was added.
	await page.reload();
	await expect(page.locator('.cm-content')).toContainText('Ilse stepped onto the ferry');
	await expect(page.locator('.scene-row')).toHaveCount(1);
});
