import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';
import { e2eDatabaseUrl } from './database';
import { gotoReady } from './navigate';
import { pickFromLibraryMenu, startStoryInUniverse } from './library';

// #1132: an Assistant pattern note with edits in two scenes. The author works
// through it from the note's card: an accept over unsaved typing in the marked
// words is refused, the first edit is skipped, the second accepted, and the
// note resolved at the end. The note and its
// edits are seeded straight into the database, so no model is needed; this
// account has no Assistant set up, so no re-read runs after the accept.

async function typeScene(page: Page, text: string, previous?: string) {
	await page.getByRole('button', { name: 'New scene' }).click();
	if (previous) await expect(page.locator('.cm-content')).not.toContainText(previous);
	await page.locator('.cm-content').click();
	await page.keyboard.type(text);
	await expect(page.locator('.saved')).toHaveText(/Saved just now/);
	await expect(page.locator('.cm-content')).toHaveText(text);
}

test('the author works through a pattern note across two scenes', async ({ page }) => {
	await gotoReady(page, '/');
	const name = `Pattern ${Date.now()}`;
	await pickFromLibraryMenu(page, 'New universe');
	await page.getByLabel('New universe').fill(name);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await gotoReady(page, '/');
	await startStoryInUniverse(page, name);
	await page.getByLabel('New story').fill('Epithets');
	await page.getByRole('button', { name: 'Create story' }).click();
	await page.getByRole('button', { name: 'New chapter' }).click();
	const first = 'The elf crossed the ford.';
	const second = 'The elf looked back.';
	await typeScene(page, first);
	await typeScene(page, second, first);
	const storyPath = new URL(page.url()).pathname;

	let firstSceneId: string;
	const pool = new pg.Pool({ connectionString: e2eDatabaseUrl() });
	try {
		const { rows: sceneRows } = await pool.query<{ id: string; story_id: string; body_md: string }>(
			`select s.id, s.story_id, s.body_md from scenes s join stories st on st.id = s.story_id
			 join universes u on u.id = st.universe_id where u.name = $1 order by s.global_position`,
			[name]
		);
		const [one, two] = sceneRows;
		firstSceneId = one.id;
		const thread = await pool.query<{ id: string }>(
			`insert into review_threads (story_id, scene_id) values ($1, $2) returning id`,
			[one.story_id, one.id]
		);
		await pool.query(
			`insert into review_comments (thread_id, assistant, body_md) values ($1, true, $2)`,
			[thread.rows[0].id, 'Pattern note (POV epithets): Kara is often called the elf.']
		);
		for (const scene of [one, two]) {
			const revision = await pool.query<{ id: string }>(
				`insert into revisions (entity_type, entity_id, body_md, reason)
				 values ('scene', $1, $2, 'autosave') returning id`,
				[scene.id, scene.body_md]
			);
			await pool.query(
				`insert into review_suggestions
				 (story_id, scene_id, assistant, base_revision_id, range_start, range_end, replacement, pattern_thread_id)
				 values ($1, $2, true, $3, 0, 7, 'Kara', $4)`,
				[scene.story_id, scene.id, revision.rows[0].id, thread.rows[0].id]
			);
		}
	} finally {
		await pool.end();
	}

	// The note sits on the first scene.
	await gotoReady(page, `${storyPath}/review?scene=${firstSceneId}`);
	const note = page.locator('.rv-card').filter({ hasText: 'Pattern note (POV epithets)' });
	await note.getByRole('button', { name: 'Work through this (2)' }).click();

	const pass = page.locator('.review-panel');
	await expect(pass.locator('.inspector-kind')).toHaveText('POV epithets');
	await expect(pass.getByText('1 of 2')).toBeVisible();
	await expect(pass.locator('.pp-para')).toContainText('crossed the ford.');
	// Typing inside the marked words, not yet saved when Accept is clicked, is
	// saved first: the accept is refused rather than the typing lost.
	await page.locator('.review-edit .cm-content').click();
	await page.keyboard.press('ControlOrMeta+Home');
	for (let i = 0; i < 'The elf'.length; i++) await page.keyboard.press('ArrowRight');
	await page.keyboard.press('Backspace');
	await page.keyboard.type('k');
	await pass.getByRole('button', { name: 'Accept', exact: true }).click();
	await expect(pass.locator('.rv-anchor-lost')).toBeVisible();
	await expect(pass.getByText('1 of 2')).toBeVisible();
	await pass.getByRole('button', { name: 'Skip' }).click();

	// The pass moves on to the second scene, and its accept lands there.
	await expect(pass.getByText('2 of 2')).toBeVisible();
	await expect(pass.locator('.pp-para')).toContainText('looked back.');
	await expect(page.locator('.review-edit .cm-content')).toContainText('looked back.');
	await pass.getByRole('button', { name: 'Accept', exact: true }).click();

	await expect(pass.getByText('You have been through every change in this note.')).toBeVisible();
	await pass.getByRole('button', { name: 'Resolve the note' }).click();
	await expect(page.locator('.inspector-kind')).toHaveCount(0);

	// The typing is kept in the first scene, and the second scene has the change.
	await gotoReady(page, `${storyPath}/review`);
	await expect(page.locator('.rv-card').filter({ hasText: 'Pattern note' })).toHaveCount(0);
	const pool2 = new pg.Pool({ connectionString: e2eDatabaseUrl() });
	try {
		const { rows } = await pool2.query<{ body_md: string }>(
			`select s.body_md from scenes s join stories st on st.id = s.story_id
			 join universes u on u.id = st.universe_id where u.name = $1 order by s.global_position`,
			[name]
		);
		expect(rows.map((r) => r.body_md)).toEqual(['The elk crossed the ford.', 'Kara looked back.']);
	} finally {
		await pool2.end();
	}
});
