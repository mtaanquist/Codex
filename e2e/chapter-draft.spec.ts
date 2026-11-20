import { expect, test } from '@playwright/test';
import pg from 'pg';
import { e2eDatabaseUrl } from './database';
import { gotoReady } from './navigate';
import { pickFromLibraryMenu, startStoryInUniverse } from './library';
import { openRowMenu } from './context-menu';

// Runs as the account with the Assistant switched on.
test.use({ storageState: 'e2e/.auth/assistant.json' });

async function sql(text: string, values: unknown[]): Promise<void> {
	const pool = new pg.Pool({ connectionString: e2eDatabaseUrl() });
	try {
		await pool.query(text, values);
	} finally {
		await pool.end();
	}
}

// #1168, step 2: the Assistant drafts a chapter scene by scene. Counting the
// cost and asking for the run go through the real endpoints; the background
// job has no model to call, so the drafts' rows are then marked written as the
// job would leave them, and the job's status is stubbed. The form's scene
// list, reading the drafts back, and keeping each one are real too.
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
	// A model for Write, so the drafts can be counted.
	await sql(
		`update stories set llm_config = '{"models":{"coauthor":"e2e-model"}}' where slug = $1`,
		[`flight-${stamp}`]
	);

	const asked: { brief?: string; scenes?: { brief: string }[] }[] = [];
	let chapterId = '';
	await page.route('**/api/assistant/draft/chapter', async (route) => {
		if (route.request().method() !== 'POST') return route.continue();
		const body = route.request().postDataJSON() as {
			defaults?: boolean;
			estimate?: boolean;
			chapterId: string;
			brief: string;
			scenes: { sceneId: string; brief: string }[];
		};
		if (body.defaults || body.estimate) return route.continue();
		chapterId = body.chapterId;
		asked.push({ brief: body.brief, scenes: body.scenes.map((s) => ({ brief: s.brief })) });
		const response = await route.fetch();
		const { draftIds } = (await response.json()) as { draftIds: string[] };
		await sql(
			`update assistant_drafts
			 set status = 'ready', text_md = 'Drafted scene ' || (position + 1) || '. The river ran on.'
			 where id = any($1::uuid[])`,
			[draftIds]
		);
		await route.fulfill({ response });
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
		/This drafts 2 scenes\. It sends about [\d,]+ tokens and writes up to [\d,]+\./
	);
	await expect(card.getByRole('button', { name: 'Draft the chapter' })).toBeFocused();
	expect(asked).toEqual([]);
	// A second press at once starts nothing: the cost has to have been on
	// screen for a moment first.
	await page.keyboard.press('Enter');
	await page.waitForTimeout(300);
	expect(asked).toEqual([]);
	await page.waitForTimeout(800);
	await card.getByRole('button', { name: 'Draft the chapter' }).click();

	// Both scenes are listed as ready, and neither scene has changed.
	await expect(card.getByRole('link')).toHaveCount(2);
	await expect(card).toContainText('Open each scene to read its draft');
	expect(asked).toEqual([
		{
			brief: 'Ilse flees across the river.',
			scenes: [{ brief: 'She reaches the quay.' }, { brief: '' }]
		}
	]);

	// The link the run's notice carries opens the list of drafts again, not a
	// new form, and opens it once: its marker is then gone from the address.
	await gotoReady(page, `/stories/flight-${stamp}?draftChapter=${chapterId}`);
	await expect(card.getByRole('link')).toHaveCount(2);
	await expect(card.getByLabel('What happens in this chapter')).toHaveCount(0);
	await expect(page).not.toHaveURL(/draftChapter/);

	// The first scene's draft is kept from that scene's own card.
	await card.getByRole('link').first().click();
	const sceneCard = page.getByRole('group', { name: 'Scene draft' });
	const draftText = sceneCard.getByLabel('Read it, and change anything you like before keeping it');
	await expect(draftText).toHaveValue('Drafted scene 1. The river ran on.');
	await sceneCard.getByRole('button', { name: 'Fill this scene' }).click();
	await expect(page.locator('.cm-content')).toContainText('Drafted scene 1.');
	await expect(sceneCard).toHaveCount(0);

	// The other scene's draft still waits. Added as a new scene, it leaves the
	// chapter's list too, though the new scene is the one now open.
	await expect(card.getByRole('link')).toHaveCount(1);
	await card.getByRole('link').click();
	await expect(draftText).toHaveValue('Drafted scene 2. The river ran on.');
	await sceneCard.getByRole('button', { name: 'Add as a new scene after this one' }).click();
	await expect(page.locator('.scene-row')).toHaveCount(3);
	await expect(page.locator('.cm-content')).toContainText('Drafted scene 2.');
	await expect(card).toHaveCount(0);

	await page.reload();
	await expect(page.locator('.scene-row')).toHaveCount(3);
	await expect(card).toHaveCount(0);
});
