import { expect, test } from '@playwright/test';
import pg from 'pg';
import { e2eDatabaseUrl } from './database';
import { gotoReady } from './navigate';
import { pickFromLibraryMenu, startStoryInUniverse } from './library';
import { openRowMenu } from './context-menu';

// Runs as the account with the Assistant switched on.
test.use({ storageState: 'e2e/.auth/assistant.json' });

// #1168, step 2: the Assistant drafts a chapter scene by scene. The run is a
// background job, so the cost count, the request and the job status are
// stubbed (no model or worker is needed) and the finished drafts are written
// to the database as the job would leave them. The form's scene list, reading
// the drafts back, and keeping one go through the real endpoints.
test('a chapter draft is costed first, and each drafted scene is kept on its own', async ({
	page
}) => {
	await gotoReady(page, '/');
	const stamp = Date.now();
	await pickFromLibraryMenu(page, 'New universe');
	await page.getByLabel('New universe').fill(`Rivermen ${stamp}`);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await gotoReady(page, '/');
	await startStoryInUniverse(page, `Rivermen ${stamp}`);
	await page.getByLabel('New story').fill(`Flight ${stamp}`);
	await page.getByRole('button', { name: 'Create story' }).click();
	await expect(page).toHaveURL(`/stories/flight-${stamp}`);
	await page.getByRole('button', { name: 'New chapter' }).click();
	await expect(page.locator('.chapter-name')).toHaveText('Chapter 1');
	await page.getByRole('button', { name: 'New scene' }).click();
	await expect(page.locator('.scene-row')).toHaveCount(1);
	await page.getByRole('button', { name: 'New scene' }).click();
	await expect(page.locator('.scene-row')).toHaveCount(2);

	const requests: { brief?: string; scenes?: { brief: string }[] }[] = [];
	await page.route('**/api/assistant/draft/chapter', async (route) => {
		const body = route.request().postDataJSON() as {
			defaults?: boolean;
			estimate?: boolean;
			chapterId: string;
			brief: string;
			targetWords: number;
			scenes: { sceneId: string; brief: string }[];
		};
		// The scene list the form opens with comes from the real endpoint.
		if (body.defaults) return route.continue();
		if (body.estimate) {
			await route.fulfill({
				json: {
					model: 'stub',
					scenes: body.scenes.length,
					estTokens: 9000,
					estCompletionTokens: 2520,
					estCostUsd: 0.07,
					overCap: false,
					skipped: []
				}
			});
			return;
		}
		requests.push({ brief: body.brief, scenes: body.scenes.map((s) => ({ brief: s.brief })) });
		const pool = new pg.Pool({ connectionString: e2eDatabaseUrl() });
		try {
			const draftIds: string[] = [];
			for (const [index, scene] of body.scenes.entries()) {
				const { rows } = await pool.query<{ id: string }>(
					`insert into assistant_drafts
					   (user_id, story_id, chapter_id, scene_id, position, brief, target_words,
					    text_md, status, job_id)
					 select st.owner_id, sc.story_id, $2, sc.id, $3, $4, $5, $6, 'ready', 'job-c'
					 from scenes sc join stories st on st.id = sc.story_id where sc.id = $1
					 returning id`,
					[
						scene.sceneId,
						body.chapterId,
						index,
						scene.brief,
						body.targetWords,
						`Drafted scene ${index + 1}. The river ran on.`
					]
				);
				draftIds.push(rows[0].id);
			}
			await route.fulfill({ json: { ok: true, jobId: 'job-c', draftIds, skipped: [] } });
		} finally {
			await pool.end();
		}
	});
	await page.route('**/api/assistant/job-status*', async (route) => {
		await route.fulfill({ json: { state: 'done' } });
	});

	// Asked for from the chapter's own menu.
	await openRowMenu(page, page.locator('.chapter-row').first());
	await page.locator('.row-menu').getByRole('menuitem', { name: 'Assistant' }).hover();
	await page
		.locator('.row-submenu')
		.getByRole('menuitem', { name: 'Draft this chapter...' })
		.click();

	const card = page.getByRole('group', { name: 'Chapter draft' });
	await card.getByLabel('What happens in this chapter').fill('Ilse flees across the river.');
	// Both empty scenes are ticked, each with a line of its own to fill.
	const lines = card.getByPlaceholder('What happens in this scene');
	await expect(lines).toHaveCount(2);
	await lines.first().fill('She reaches the quay.');
	await card.getByRole('button', { name: 'Check the cost' }).click();
	// The count is shown and nothing has been asked for yet.
	await expect(card).toContainText(
		'This drafts 2 scenes. It sends about 9,000 tokens and writes about 2,520 (about $0.07).'
	);
	expect(requests).toEqual([]);
	await card.getByRole('button', { name: 'Draft the chapter' }).click();

	// Both scenes are listed as ready, and neither scene has changed.
	await expect(card.getByRole('link')).toHaveCount(2);
	await expect(card).toContainText('Open each scene to read its draft');
	expect(requests).toEqual([
		{
			brief: 'Ilse flees across the river.',
			scenes: [{ brief: 'She reaches the quay.' }, { brief: '' }]
		}
	]);

	// The first scene's draft is kept from that scene's own card.
	await card.getByRole('link').first().click();
	await expect(page).toHaveURL(/draft=1/);
	const sceneCard = page.getByRole('group', { name: 'Scene draft' });
	await expect(
		sceneCard.getByLabel('Read it, and change anything you like before keeping it')
	).toHaveValue('Drafted scene 1. The river ran on.');
	await sceneCard.getByRole('button', { name: 'Fill this scene' }).click();
	await expect(page.locator('.cm-content')).toContainText('Drafted scene 1.');
	await expect(sceneCard).toHaveCount(0);

	// The other scene's draft still waits, and is still there after a reload.
	await expect(card.getByRole('link')).toHaveCount(1);
	await page.reload();
	await expect(page.locator('.cm-content')).toContainText('Drafted scene 1.');
	await expect(page.locator('.scene-row')).toHaveCount(2);
});
