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

async function seedEdit(
	pool: pg.Pool,
	scene: { id: string; story_id: string; body_md: string },
	threadId: string,
	range: [number, number],
	replacement: string,
	follows: string | null = null
): Promise<string> {
	const revision = await pool.query<{ id: string }>(
		`insert into revisions (entity_type, entity_id, body_md, reason)
		 values ('scene', $1, $2, 'autosave') returning id`,
		[scene.id, scene.body_md]
	);
	const edit = await pool.query<{ id: string }>(
		`insert into review_suggestions
		 (story_id, scene_id, assistant, base_revision_id, range_start, range_end, replacement,
		  pattern_thread_id, follows_suggestion_id)
		 values ($1, $2, true, $3, $4, $5, $6, $7, $8) returning id`,
		[
			scene.story_id,
			scene.id,
			revision.rows[0].id,
			range[0],
			range[1],
			replacement,
			threadId,
			follows
		]
	);
	return edit.rows[0].id;
}

async function typeScene(page: Page, text: string, previous?: string) {
	await page.getByRole('button', { name: 'New scene' }).click();
	if (previous) await expect(page.locator('.cm-content')).not.toContainText(previous);
	await page.locator('.cm-content').click();
	await page.keyboard.type(text);
	await expect(page.locator('.saved')).toHaveText(/Saved just now/);
	await expect(page.locator('.cm-content')).toHaveText(text);
}

// A story with two scenes and a pattern note with one edit in each, opened in
// review on the first scene.
async function openNote(page: Page): Promise<{ name: string; storyPath: string }> {
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
		for (const scene of [one, two]) await seedEdit(pool, scene, thread.rows[0].id, [0, 7], 'Kara');
	} finally {
		await pool.end();
	}

	// The note sits on the first scene.
	await gotoReady(page, `${storyPath}/review?scene=${firstSceneId}`);
	return { name, storyPath };
}

async function sceneBodies(name: string): Promise<string[]> {
	const pool = new pg.Pool({ connectionString: e2eDatabaseUrl() });
	try {
		const { rows } = await pool.query<{ body_md: string }>(
			`select s.body_md from scenes s join stories st on st.id = s.story_id
			 join universes u on u.id = st.universe_id where u.name = $1 order by s.global_position`,
			[name]
		);
		return rows.map((r) => r.body_md);
	} finally {
		await pool.end();
	}
}

test('the author works through a pattern note across two scenes', async ({ page }) => {
	const { name, storyPath } = await openNote(page);
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
	expect(await sceneBodies(name)).toEqual(['The elk crossed the ford.', 'Kara looked back.']);
});

// The suggestion is revised while the writer is rewording it. The accept is
// refused; the card then shows the new wording above theirs, keeps what they
// typed, and keeps the keyboard in the pass.
test('an edit revised while the writer rewords it shows the new wording', async ({ page }) => {
	const { name } = await openNote(page);
	const note = page.locator('.rv-card').filter({ hasText: 'Pattern note (POV epithets)' });
	await note.getByRole('button', { name: 'Work through this (2)' }).click();
	const pass = page.locator('.review-panel');
	const step = pass.locator('[aria-current="step"]');
	await expect(pass.getByText('1 of 2')).toBeVisible();
	await step.getByRole('button', { name: 'Edit' }).click();
	await step.getByLabel('Your wording').fill('Kara of the ford');

	const pool = new pg.Pool({ connectionString: e2eDatabaseUrl() });
	try {
		await pool.query(
			`update review_suggestions set replacement = 'The ranger'
			 where scene_id = (select s.id from scenes s join stories st on st.id = s.story_id
			   join universes u on u.id = st.universe_id where u.name = $1
			   order by s.global_position limit 1)`,
			[name]
		);
	} finally {
		await pool.end();
	}

	await step.getByRole('button', { name: 'Accept my wording' }).click();
	const refusal = step.getByRole('alert');
	await expect(refusal).toHaveText('This suggestion changed. Read it again.');
	await expect(step.locator('.pp-revised')).toContainText('The ranger');
	await expect(step.getByLabel('Your wording')).toHaveValue('Kara of the ford');
	await expect(step).toBeFocused();
	expect(await sceneBodies(name)).toEqual(['The elf crossed the ford.', 'The elf looked back.']);

	// Read again, the writer's own wording goes in.
	await step.getByRole('button', { name: 'Accept my wording' }).click();
	await expect(pass.getByText('2 of 2')).toBeVisible();
	await expect
		.poll(() => sceneBodies(name))
		.toEqual(['Kara of the ford crossed the ford.', 'The elf looked back.']);
});

const LONG_APP_NAME = 'The Writing Desk Assistant For Novelists And Playwrights And Poets';

// #1175: a pattern note a connected app left. The link the app hands the writer
// (?pass=<note id>) opens the pass on that note, and the note's card offers
// the same way in.
test('a link from a connected app opens the pass on its note', async ({ page }) => {
	const { name, storyPath } = await openNote(page);
	let threadId: string;
	const pool = new pg.Pool({ connectionString: e2eDatabaseUrl() });
	try {
		const { rows } = await pool.query<{ id: string }>(
			`select t.id from review_threads t join stories st on st.id = t.story_id
			 join universes u on u.id = st.universe_id where u.name = $1`,
			[name]
		);
		threadId = rows[0].id;
		// The note and its edits as the app would have staged them.
		for (const table of ['review_comments', 'review_suggestions']) {
			await pool.query(
				`update ${table} set assistant = false, client_name = '${LONG_APP_NAME}',
				 client_host = 'app.example'
				 where ${table === 'review_comments' ? 'thread_id' : 'pattern_thread_id'} = $1`,
				[threadId]
			);
		}
		// A note written in markdown, as an app writes one.
		await pool.query(
			`update review_comments set body_md = body_md || E'\\n\\n**Worth a look.**' where thread_id = $1`,
			[threadId]
		);
	} finally {
		await pool.end();
	}

	await gotoReady(page, `${storyPath}/review?pass=${threadId}`);
	const pass = page.locator('.review-panel');
	await expect(pass.locator('.inspector-kind')).toHaveText('POV epithets');
	await expect(pass.getByText('1 of 2')).toBeVisible();
	await expect(pass.locator('.pp-para')).toContainText('crossed the ford.');

	// Stopping shows the note under the app's name, with the same way back in.
	await pass.getByRole('button', { name: 'Stop' }).click();
	const note = page.locator('.rv-card').filter({ hasText: 'Pattern note (POV epithets)' });
	await expect(note).toContainText('Writing Desk');
	// However long the name, the "App" chip and the app's address stay in
	// view inside the card, and the name is what gets cut.
	const chip = note.locator('.rv-card-top .rv-role');
	await expect(chip).toHaveText('App');
	await expect(chip).toBeInViewport({ ratio: 1 });
	const host = note.locator('.rv-who-host');
	await expect(host).toHaveText('app.example');
	await expect(host).toBeInViewport({ ratio: 1 });
	const cardBox = (await note.boundingBox())!;
	for (const part of [chip, host]) {
		const box = (await part.boundingBox())!;
		expect(box.x + box.width).toBeLessThanOrEqual(cardBox.x + cardBox.width);
	}
	// Initials come from the name, and the note's markdown is rendered.
	await expect(note.locator('.rv-card-top .rv-av')).toHaveText('TP');
	await expect(note.locator('.rv-body strong')).toHaveText('Worth a look.');
	await note.getByRole('button', { name: 'Work through this (2)' }).click();
	await pass.getByRole('button', { name: 'Accept', exact: true }).click();
	await expect(pass.locator('.pp-para')).toContainText('looked back.');
	await expect
		.poll(() => sceneBodies(name))
		.toEqual(['Kara crossed the ford.', 'The elf looked back.']);
});

// The writer may read another scene mid-pass. An accept then changes the
// step's scene on the server, and the open scene keeps its own text.
test('an accept with another scene open leaves that scene alone', async ({ page }) => {
	const { name } = await openNote(page);
	const note = page.locator('.rv-card').filter({ hasText: 'Pattern note (POV epithets)' });
	await note.getByRole('button', { name: 'Work through this (2)' }).click();
	const pass = page.locator('.review-panel');
	await expect(pass.getByText('1 of 2')).toBeVisible();

	await page.locator('.scene-row').nth(1).click();
	const editor = page.locator('.review-edit .cm-content');
	await expect(editor).toContainText('looked back.');
	await pass.getByRole('button', { name: 'Accept', exact: true }).click();
	await expect
		.poll(() => sceneBodies(name))
		.toEqual(['Kara crossed the ford.', 'The elf looked back.']);

	// Typing in the open scene saves onto its own text.
	await editor.click();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.type(' Twice.');
	await expect
		.poll(() => sceneBodies(name))
		.toEqual(['Kara crossed the ford.', 'The elf looked back. Twice.']);
});

test.describe('with the Assistant on', () => {
	test.use({ storageState: 'e2e/.auth/assistant.json' });

	// A note with the same edit in two scenes, and the re-read after an accept
	// answered by the test: it stages a follow-up on "ford" in the first scene
	// once `release` resolves.
	async function openPass(
		page: Page,
		release: Promise<void> = Promise.resolve(),
		// The status the re-read answers with; the follow-up is staged either way.
		status = 200
	) {
		await gotoReady(page, '/');

		const name = `Follow-up ${Date.now()}`;
		await pickFromLibraryMenu(page, 'New universe');
		await page.getByLabel('New universe').fill(name);
		await page.getByRole('button', { name: 'Create universe' }).click();
		await gotoReady(page, '/');
		await startStoryInUniverse(page, name);
		await page.getByLabel('New story').fill('Epithets');
		await page.getByRole('button', { name: 'Create story' }).click();
		await page.getByRole('button', { name: 'New chapter' }).click();
		const first = 'The elf crossed the ford.';
		await typeScene(page, first);
		await typeScene(page, 'The elf looked back.', first);
		const storyPath = new URL(page.url()).pathname;

		const pool = new pg.Pool({ connectionString: e2eDatabaseUrl() });
		const scenesOf = async () =>
			(
				await pool.query<{ id: string; story_id: string; body_md: string }>(
					`select s.id, s.story_id, s.body_md from scenes s join stories st on st.id = s.story_id
					 join universes u on u.id = st.universe_id where u.name = $1 order by s.global_position`,
					[name]
				)
			).rows;
		const [one, two] = await scenesOf();
		const thread = await pool.query<{ id: string }>(
			`insert into review_threads (story_id, scene_id) values ($1, $2) returning id`,
			[one.story_id, one.id]
		);
		const threadId = thread.rows[0].id;
		await pool.query(
			`insert into review_comments (thread_id, assistant, body_md) values ($1, true, $2)`,
			[threadId, 'Pattern note (POV epithets): Kara is often called the elf.']
		);
		for (const scene of [one, two]) await seedEdit(pool, scene, threadId, [0, 7], 'Kara');

		await page.route('**/api/assistant/pattern-reread', async (route) => {
			const { suggestionId } = route.request().postDataJSON() as { suggestionId: string };
			await release;
			const [after] = await scenesOf();
			const at = after.body_md.indexOf('ford');
			const id = await seedEdit(pool, after, threadId, [at, at + 4], 'river', suggestionId);
			await pool.query('update review_suggestions set reason = $1 where id = $2', [
				'A river reads larger than a ford.',
				id
			]);
			if (status === 200) await route.fulfill({ json: { staged: 1, ids: [id] } });
			else await route.fulfill({ status, body: 'Gateway timeout' });
		});

		await gotoReady(page, `${storyPath}/review?scene=${one.id}`);
		const note = page.locator('.rv-card').filter({ hasText: 'Pattern note (POV epithets)' });
		await note.getByRole('button', { name: 'Work through this (2)' }).click();
		const pass = page.locator('.review-panel');
		await expect(pass.locator('.pp-para')).toContainText('crossed the ford.');
		return {
			pass,
			current: pass.locator('.pp-card[aria-current="step"]'),
			done: async () => {
				await page.unrouteAll({ behavior: 'wait' });
				await pool.end();
			}
		};
	}

	// The follow-up joins the back of the queue: the pass goes on to the next
	// scene and only then back to the first for the follow-up.
	test('a follow-up from the re-read comes last', async ({ page }) => {
		const { pass, current, done } = await openPass(page);
		try {
			await pass.getByRole('button', { name: 'Accept', exact: true }).click();
			await expect(
				page.locator('.activity-card').filter({ hasText: 'Follow-up added' })
			).toBeVisible();
			await expect(pass.getByText('2 of 3')).toBeVisible();
			await expect(pass.locator('.pp-para')).toContainText('looked back.');
			await expect(current.getByText('Follow-up')).toHaveCount(0);
			await pass.getByRole('button', { name: 'Skip' }).click();
			await expect(current.getByText('Follow-up')).toBeVisible();
			await expect(pass.locator('.pp-para')).toContainText('Kara crossed the fordriver.');
			// The Assistant's reason shows under the change.
			await expect(current.locator('.rv-reason')).toHaveText(
				'Why:A river reads larger than a ford.'
			);
			await expect(page.locator('.review-edit .cm-content')).toContainText('Kara crossed');
		} finally {
			await done();
		}
	});

	// A follow-up that arrives while the writer rewords the next step waits
	// until that step is done, so the wording being typed is kept.
	test('a follow-up does not take over a step being reworded', async ({ page }) => {
		let release!: () => void;
		const { pass, current, done } = await openPass(page, new Promise<void>((r) => (release = r)));
		try {
			await pass.getByRole('button', { name: 'Accept', exact: true }).click();
			await expect(pass.locator('.pp-para')).toContainText('looked back.');
			await pass.getByRole('button', { name: 'Edit' }).click();
			await pass.getByLabel('Your wording').fill('Kara alone');
			// The re-read shows in a corner card, not in the pane, so the step
			// does not move when it starts or ends.
			const rereading = page.locator('.activity-card').filter({
				hasText: 'Re-reading the last change'
			});
			await expect(rereading).toBeVisible();
			await expect(pass.getByText('Re-reading')).toHaveCount(0);
			release();
			await expect(rereading).toHaveCount(0);
			await expect(
				page.locator('.activity-card').filter({ hasText: 'Follow-up added' })
			).toBeVisible();
			await expect(pass.getByLabel('Your wording')).toHaveValue('Kara alone');
			// The re-read ending takes neither focus nor typing from the box.
			await expect(pass.getByLabel('Your wording')).toBeFocused();
			await page.keyboard.type(' again');
			await expect(pass.getByLabel('Your wording')).toHaveValue('Kara alone again');
			await pass.getByRole('button', { name: 'Accept my wording' }).click();
			await expect(current.getByText('Follow-up')).toBeVisible();
			await expect(pass.locator('.pp-para')).toContainText('Kara crossed the fordriver.');
		} finally {
			await done();
		}
	});

	// Stopping the pass takes its running re-read card with it.
	test('stopping the pass clears the re-read card', async ({ page }) => {
		let release!: () => void;
		const { pass, done } = await openPass(page, new Promise<void>((r) => (release = r)));
		try {
			await pass.getByRole('button', { name: 'Accept', exact: true }).click();
			const rereading = page.locator('.activity-card').filter({
				hasText: 'Re-reading the last change'
			});
			await expect(rereading).toBeVisible();
			await pass.getByRole('button', { name: 'Stop' }).click();
			await expect(rereading).toHaveCount(0);
			const answered = page.waitForResponse('**/api/assistant/pattern-reread');
			release();
			await answered;
			// Nothing is said about a re-read of a pass already stopped.
			await page.waitForTimeout(300);
			await expect(page.locator('.activity-card')).toHaveCount(0);
			// But its follow-up is loaded, so a pass started again reaches it.
			await page.locator('.scene-row').first().click();
			const note = page.locator('.rv-card').filter({ hasText: 'Pattern note (POV epithets)' });
			await note.getByRole('button', { name: 'Work through this (2)' }).click();
			await expect(pass.locator('.pp-card')).toHaveCount(3);
		} finally {
			await done();
		}
	});

	// Every edit of the note shows as a card; only the current one has buttons.
	// A follow-up links to the edit it follows, and keeps the link after a
	// reload.
	test('the pass lists every edit, and a follow-up links to its original', async ({ page }) => {
		const { pass, current, done } = await openPass(page);
		try {
			const cards = pass.locator('.pp-card');
			await expect(cards).toHaveCount(2);
			await expect(pass.locator('.pp-faded').getByRole('button')).toHaveCount(0);
			await pass.getByRole('button', { name: 'Accept', exact: true }).click();
			await expect(cards).toHaveCount(3);
			await pass.getByRole('button', { name: 'Skip' }).click();
			await expect(pass.locator('.pp-faded').filter({ hasText: 'Skipped' })).toHaveCount(1);
			await expect(current.getByText('Follow-up')).toBeVisible();
			// Focus moves on with the step instead of falling back to the page.
			await expect(current).toBeFocused();
			const accepted = pass.locator('.pp-faded').filter({ hasText: 'Accepted' });
			await expect(accepted).toHaveCount(1);
			await current.getByRole('button', { name: 'Follows an earlier change' }).click();
			await expect(accepted).toHaveClass(/pp-flash/);

			// After a reload the follow-up still links back.
			await page.reload();
			await page.locator('html[data-hydrated="true"]').waitFor();
			const note = page.locator('.rv-card').filter({ hasText: 'Pattern note (POV epithets)' });
			await note.getByRole('button', { name: /Work through this/ }).click();
			// The skipped edit comes round again first.
			await expect(pass.locator('.pp-para')).toContainText('looked back.');
			await pass.getByRole('button', { name: 'Skip' }).click();
			await expect(current.getByText('Follow-up')).toBeVisible();
			await expect(
				current.getByRole('button', { name: 'Follows an earlier change' })
			).toBeVisible();
		} finally {
			await done();
		}
	});

	// Accepting every edit before the re-reads answer reaches the end; a
	// follow-up that arrives then becomes the step, in place of the end.
	test('a follow-up after the last accept replaces the end of the pass', async ({ page }) => {
		let release!: () => void;
		const { pass, current, done } = await openPass(page, new Promise<void>((r) => (release = r)));
		try {
			await pass.getByRole('button', { name: 'Accept', exact: true }).click();
			await expect(pass.locator('.pp-para')).toContainText('looked back.');
			await pass.getByRole('button', { name: 'Accept', exact: true }).click();
			// Not the end yet: the re-reads are still running.
			await expect(pass.getByText('The Assistant is still re-reading')).toBeVisible();
			await expect(pass.getByRole('button', { name: 'Resolve the note' })).toHaveCount(0);
			release();
			await expect(current.getByText('Follow-up')).toBeVisible();
			await expect(pass.getByText('You have been through every change in this note.')).toHaveCount(
				0
			);
		} finally {
			await done();
		}
	});

	// A re-read that fails after staging its follow-up (a timeout, say) still
	// brings the follow-up in.
	test('a follow-up from a re-read that failed still shows', async ({ page }) => {
		const { pass, done } = await openPass(page, Promise.resolve(), 504);
		try {
			await pass.getByRole('button', { name: 'Accept', exact: true }).click();
			await expect(
				page.locator('.activity-card').filter({ hasText: 'Could not re-read the last change' })
			).toBeVisible();
			// Loaded without a second accept: the count takes in the follow-up
			// while the second scene's edit is still the step.
			await expect(pass.getByText('2 of 3')).toBeVisible();
			await expect(pass.locator('.pp-para')).toContainText('looked back.');
			await expect(pass.locator('.pp-faded').filter({ hasText: 'Follow-up' })).toHaveCount(1);
		} finally {
			await done();
		}
	});

	// A pass stopped and started again while a re-read runs still waits for it
	// before offering to resolve the note.
	test('a restarted pass waits for a re-read from before', async ({ page }) => {
		let release!: () => void;
		const { pass, current, done } = await openPass(page, new Promise<void>((r) => (release = r)));
		try {
			await pass.getByRole('button', { name: 'Accept', exact: true }).click();
			await expect(pass.locator('.pp-para')).toContainText('looked back.');
			await pass.getByRole('button', { name: 'Stop' }).click();
			// The note sits on the first scene.
			await page.locator('.scene-row').first().click();
			const note = page.locator('.rv-card').filter({ hasText: 'Pattern note (POV epithets)' });
			await note.getByRole('button', { name: /Work through this/ }).click();
			await expect(pass.locator('.pp-para')).toContainText('looked back.');
			// Skip, so only the re-read from before the restart is running.
			await pass.getByRole('button', { name: 'Skip' }).click();
			await expect(pass.getByText('The Assistant is still re-reading')).toBeVisible();
			await expect(pass.getByRole('button', { name: 'Resolve the note' })).toHaveCount(0);
			release();
			await expect(current.getByText('Follow-up')).toBeVisible();
		} finally {
			await done();
		}
	});

	// A follow-up that turns up at the end while the writer types in the
	// manuscript shows in the pane without moving them.
	test('a follow-up at the end does not pull the writer out of the manuscript', async ({
		page
	}) => {
		let release!: () => void;
		const { pass, current, done } = await openPass(page, new Promise<void>((r) => (release = r)));
		try {
			await pass.getByRole('button', { name: 'Accept', exact: true }).click();
			await expect(pass.locator('.pp-para')).toContainText('looked back.');
			await pass.getByRole('button', { name: 'Accept', exact: true }).click();
			await expect(pass.getByText('The Assistant is still re-reading')).toBeVisible();
			const editor = page.locator('.review-edit .cm-content');
			await expect(editor).toContainText('Kara looked back.');
			await editor.click();
			await page.keyboard.press('ControlOrMeta+End');
			release();
			await expect(current.getByText('Follow-up')).toBeVisible();
			// Still in the second scene, still typing there.
			await page.keyboard.type(' Twice.');
			await expect(editor).toContainText('Kara looked back. Twice.');
			await expect(editor).toBeFocused();
		} finally {
			await done();
		}
	});
});
