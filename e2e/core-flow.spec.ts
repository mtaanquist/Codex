import { expect, test } from '@playwright/test';

test('sign in, create a universe and a story, and open it', async ({ page, browser }) => {
	// A long journey that waits on the async worker twice; the default 30s
	// budget is too tight on a loaded CI runner and was silently capping the
	// 60s indexing wait below. Tripling it to 90s gives that wait its room.
	test.slow();
	await page.goto('/');

	// Repeated runs share the seeded user, so pin the preferences to their
	// defaults before exercising them later. They live on the account page now.
	await page.goto('/account');
	await page.getByRole('link', { name: 'Display' }).click();
	await page.getByLabel('Entity autocomplete').selectOption('popup');
	await page.getByLabel('Scene marks in the story view').selectOption('shown');
	await page.getByLabel('Editing mode').selectOption('rich');
	await page.getByRole('button', { name: 'Save preferences' }).click();
	await expect(page.getByRole('status')).toHaveText('Saved.');
	await page.goto('/');

	// Backups belong to the site admin; a regular account sees no panel.
	await expect(page.getByRole('heading', { name: 'Backups' })).toHaveCount(0);

	// Unique name so repeated local runs do not collide.
	const universeName = `Testverse ${Date.now()}`;
	await page.getByRole('button', { name: 'New universe' }).click();
	await page.getByLabel('New universe').fill(universeName);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText(`${universeName} - settings`);

	await page.goto('/');
	await page
		.locator('.universe-section', { hasText: universeName })
		.getByRole('button', { name: 'New story in this universe' })
		.click();
	await page.getByLabel('New story').fill('Book of Ash');
	await page.getByRole('button', { name: 'Create story' }).click();

	// Opening a story lands in the editor shell: breadcrumb and sidebar both
	// carry the story title.
	await expect(page.locator('.crumb.current')).toHaveText('Book of Ash');
	await expect(page.locator('.story-title')).toHaveText('Book of Ash');

	// The top-bar help opens the editor article in a modal; Esc closes it.
	// Opening is idempotent, so retry the click until the dialog shows: a lone
	// click can be dropped if it lands as the top bar re-renders.
	const help = page.getByRole('dialog', { name: 'Writing in the editor' });
	await expect(async () => {
		await page.getByRole('button', { name: 'Help: the editor' }).click();
		await expect(help.getByRole('heading', { name: 'Writing in the editor' })).toBeVisible({
			timeout: 2000
		});
	}).toPass({ timeout: 15000 });
	await page.keyboard.press('Escape');
	await expect(help).toBeHidden();

	// Build the tree: a chapter, then a scene inside it, which opens.
	await page.getByRole('button', { name: 'New chapter' }).click();
	await expect(page.locator('.chapter-name')).toHaveText('Chapter 1');
	await page.getByRole('button', { name: 'New scene' }).click();
	await expect(page).toHaveURL(/scene=/);
	await expect(page.getByPlaceholder('Untitled scene')).toBeVisible();
	await expect(page.locator('.scene-row.active .scene-name')).toHaveText('Untitled scene');

	// Focus mode hides the chrome; Esc brings it back. The control sits on the
	// editor's formatting bar, so it needs a scene open.
	await page.getByRole('button', { name: 'Focus mode' }).click();
	await expect(page.locator('.topbar')).toBeHidden();
	await page.keyboard.press('Escape');
	await expect(page.locator('.topbar')).toBeVisible();

	// Write prose: the autosave chip confirms, and a reload preserves it.
	await page.locator('.cm-content').click();
	await page.keyboard.type('The gate of Halden opened the way it always did.');
	await expect(page.locator('.saved')).toHaveText(/Saved just now/);
	const titleSave = page.waitForResponse(
		(r) => r.url().includes('/api/scenes/') && r.request().method() === 'PUT' && r.ok()
	);
	await page.getByPlaceholder('Untitled scene').fill('Departure from Halden');
	await titleSave;
	// The sidebar name tracks the rename without a reload.
	await expect(page.locator('.scene-row.active .scene-name')).toHaveText('Departure from Halden');
	await page.reload();
	await expect(page.locator('.cm-content')).toContainText('The gate of Halden');
	await expect(page.locator('.scene-row.active .scene-name')).toHaveText('Departure from Halden');

	// Reorder: a second scene dragged above the first keeps its place after
	// a reload, proving the positions persisted.
	await page.getByRole('button', { name: 'New scene' }).click();
	await expect(page.locator('.scene-row')).toHaveCount(2);
	await expect(page.locator('.scene-row').nth(1).locator('.scene-name')).toHaveText(
		'Untitled scene'
	);
	const orderSave = page.waitForResponse((r) => r.url().includes('/scene-order') && r.ok());
	await page
		.locator('.scene-row')
		.nth(1)
		.dragTo(page.locator('.scene-row').nth(0), { targetPosition: { x: 60, y: 4 } });
	await orderSave;
	await expect(page.locator('.scene-row').nth(0).locator('.scene-name')).toHaveText(
		'Untitled scene'
	);
	await page.reload();
	await expect(page.locator('.scene-row').nth(0).locator('.scene-name')).toHaveText(
		'Untitled scene'
	);

	// The whole story reads as one continuous document with jump navigation.
	const sceneUrl = page.url();
	await page.getByRole('link', { name: 'Read the whole story' }).click();
	await expect(page).toHaveURL(/view=story/);
	await expect(page.locator('.doc-scene')).toHaveCount(2);
	await expect(page.locator('.story-doc')).toContainText('The gate of Halden');

	// The continuous view is editable in place: each scene is its own
	// editor with its own autosave.
	await expect(page.locator('.doc-scene-mark')).toHaveCount(2);
	const docEditor = page
		.locator('.doc-scene', { hasText: 'The gate of Halden' })
		.locator('.cm-content');
	const docSave = page.waitForResponse(
		(r) => r.url().includes('/api/scenes/') && r.request().method() === 'PUT' && r.ok()
	);
	await docEditor.click();
	await page.keyboard.press('Control+End');
	await page.keyboard.type(' Edited in the flow.');
	await docSave;

	// Vertical arrows cross scene boundaries.
	await page.locator('.doc-scene').nth(0).locator('.cm-content').click();
	await page.keyboard.press('Control+End');
	await page.keyboard.press('ArrowDown');
	await expect(page.locator('.doc-scene').nth(1).locator('.cm-content')).toBeFocused();
	await page.locator('.scene-row').nth(1).click();
	await expect(page).toHaveURL(/#scene-/);

	// Toggling back returns to the scene that was open before.
	await page.getByRole('link', { name: 'Back to the scene editor' }).click();
	await expect(page).toHaveURL(sceneUrl);

	// A scene mark in the document jumps straight into editing that scene.
	await page.getByRole('link', { name: 'Read the whole story' }).click();
	await page.locator('.doc-scene-mark').nth(1).click();
	await expect(page).not.toHaveURL(/view=story/);
	await expect(page).toHaveURL(/scene=/);
	await expect(page.locator('.cm-content')).toContainText('The gate of Halden');

	// Plan view: with nothing selected the centre shows the scene board.
	await page.getByRole('link', { name: 'Plan' }).click();
	await expect(page).toHaveURL(/\/plan$/);
	await expect(page.getByRole('region', { name: 'Draft scenes' })).toBeVisible();

	// Create a character, fill the editor, and it persists.
	await page.getByPlaceholder('New character name').fill('Alice');
	await page.getByRole('button', { name: 'Add character' }).click();
	await expect(page).toHaveURL(/entity=/);
	const characterSave = page.waitForResponse(
		(r) => r.url().includes('/api/characters/') && r.request().method() === 'PUT' && r.ok()
	);
	await page.getByPlaceholder('Name', { exact: true }).fill('Alice Vane');
	// Aliases are tags: open the input, then add each on Enter.
	await page.getByRole('button', { name: 'Add alias' }).click();
	await page.getByLabel('Add alias').fill('Allie');
	await page.getByLabel('Add alias').press('Enter');
	await page.getByLabel('Add alias').fill('Mrs. Fenwick');
	await page.getByLabel('Add alias').press('Enter');
	await expect(page.locator('.chip', { hasText: 'Mrs. Fenwick' })).toBeVisible();
	await page
		.getByPlaceholder('One or two lines. Shown when a mention is hovered.')
		.fill('A toll-road smuggler.');
	await page
		.getByPlaceholder('Notes that apply only to this story.')
		.fill('Starts the book in debt.');
	await characterSave;

	// Details edit one cell at a time: Enter saves and opens the next,
	// Escape finishes, and the saved facts read back as plain cells.
	const detailsSave = page.waitForResponse(
		(r) => r.url().includes('/api/characters/') && r.request().method() === 'PUT' && r.ok()
	);
	await page.getByRole('button', { name: '+ Add detail' }).click();
	await page.getByLabel('Detail label').fill('Age');
	await page.getByLabel('Detail value').fill('32');
	await page.getByLabel('Detail value').press('Enter');
	await page.getByLabel('Detail label').fill('Status');
	await page.getByLabel('Detail value').fill('Alive');
	await page.getByLabel('Detail value').press('Escape');
	await expect(page.getByLabel('Detail label')).toHaveCount(0);
	await expect(page.locator('.detail-cell', { hasText: 'Age' })).toContainText('32');
	await detailsSave;

	await page.reload();
	await expect(page.getByPlaceholder('Name', { exact: true })).toHaveValue('Alice Vane');
	await expect(page.locator('.ent-row .name')).toHaveText('Alice Vane');
	await expect(page.getByPlaceholder('Notes that apply only to this story.')).toHaveValue(
		'Starts the book in debt.'
	);
	await expect(page.locator('.detail-cell', { hasText: 'Status' })).toContainText('Alive');
	// Clicking a saved cell reopens it for editing.
	await page.locator('.detail-cell', { hasText: 'Age' }).click();
	await expect(page.getByLabel('Detail label')).toHaveValue('Age');
	await page.getByLabel('Detail label').press('Escape');

	// Places follow the same pattern.
	await page.getByPlaceholder('New place name').fill('Halden');
	await page.getByRole('button', { name: 'Add place' }).click();
	await expect(page).toHaveURL(/entity=/);
	await expect(page.getByPlaceholder('Name', { exact: true })).toHaveValue('Halden');

	// Lore entries live under their category; each seeded category ("Lore",
	// "Faction") has its own add form, so scope to the Lore one.
	const loreForm = page.locator('form', { has: page.getByPlaceholder('New Lore entry') });
	await loreForm.getByPlaceholder('New Lore entry').fill('Toll-pass');
	await loreForm.getByRole('button', { name: 'Add entry' }).click();
	await expect(page).toHaveURL(/entity=/);
	const loreSave = page.waitForResponse(
		(r) => r.url().includes('/api/lore/') && r.request().method() === 'PUT' && r.ok()
	);
	await page.getByRole('button', { name: 'Add keyword' }).click();
	await page.getByLabel('Add keyword').fill('gate');
	await page.getByLabel('Add keyword').press('Enter');
	await loreSave;

	// A coloured category groups the cast: create one, assign Alice to it,
	// and her badge takes the colour.
	await page.getByPlaceholder('New category name').fill('Factions');
	await page.locator('select[name="color"]').selectOption('var(--cat-rose)');
	await page.getByRole('button', { name: 'Add category' }).click();
	await expect(page.locator('.group-label', { hasText: 'Factions' })).toBeVisible();
	await page.locator('.ent-row', { hasText: 'Alice Vane' }).click();
	const categorySave = page.waitForResponse(
		(r) => r.url().includes('/api/characters/') && r.request().method() === 'PUT' && r.ok()
	);
	// For characters the field is named for what it does: a colour group.
	await page.getByLabel('Colour group').selectOption({ label: 'Factions' });
	await categorySave;
	await page.reload();
	await expect(
		page.locator('.ent-row', { hasText: 'Alice Vane' }).locator('.badge')
	).toHaveAttribute('style', /var\(--cat-rose\)/);

	// Back to Write via the segmented control.
	await page.getByRole('link', { name: 'Write' }).click();
	await expect(page.locator('.chapter-name')).toHaveText('Chapter 1');

	// Mentions: typing a known alias underlines it live; hovering shows the
	// character's summary.
	await page.locator('.scene-row').nth(1).click();
	await expect(page.locator('.cm-content')).toContainText('The gate of Halden');
	await page.locator('.cm-content').click();
	await page.keyboard.press('Control+End');
	// Capture the autosave so the prose (and its mention rebuild) is persisted
	// before the reload below, independent of the autosave debounce.
	const fenwickSave = page.waitForResponse(
		(r) => r.url().includes('/api/scenes/') && r.request().method() === 'PUT' && r.ok()
	);
	await page.keyboard.type(' Mrs. Fenwick waited.');
	// The body mentions the lore keyword "gate", the place "Halden", and the
	// alias: all three underline. Hovering opens the entity card with the
	// kind line, the summary, and the way to the full page.
	await expect(page.locator('.ref-word')).toHaveText(['gate', 'Halden', 'Mrs. Fenwick']);
	await page.locator('.ref-word', { hasText: 'Mrs. Fenwick' }).hover();
	await expect(page.locator('.entity-card .pop-name')).toHaveText('Alice Vane');
	// Alice joined the Factions category above; the kind line carries it.
	await expect(page.locator('.entity-card .pop-role')).toHaveText('Character · Factions');
	await expect(page.locator('.entity-card .pop-summary')).toHaveText('A toll-road smuggler.');
	await expect(page.locator('.entity-card .pop-open')).toHaveAttribute('href', /\/plan\?entity=/);
	await fenwickSave;

	// The worker indexes the mention asynchronously; once it has, the scene's
	// cast shows in the right panel. The window is generous because a loaded
	// CI runner shares cycles between the app, the worker, and Postgres.
	await expect(async () => {
		await page.reload();
		// Assert each expected entity is present rather than an exact ordered
		// list: the worker can surface them in any order and in stages, and a
		// strict array match turns a mid-indexing reload into a hard failure.
		for (const name of ['Alice Vane', 'Halden', 'Toll-pass']) {
			await expect(page.locator('.r-line-name').filter({ hasText: name })).toHaveCount(1, {
				timeout: 3000
			});
		}
	}).toPass({ timeout: 60000 });
	// The cast is grouped by entity type: one of each here.
	await expect(page.locator('.r-sub')).toHaveText(['Characters', 'Places', 'Lore']);

	// Clicking the cast opens the read-only card in the right column; its
	// "Open in Plan view" link goes to the editable entity.
	await page.locator('.r-line', { hasText: 'Alice Vane' }).click();
	await expect(page.locator('.inspector .insp-name')).toHaveText('Alice Vane');
	await page.locator('.insp-open').click();

	// Find usages: the character's panel lists the scene with the snippet,
	// and jumps back into it.
	await expect(page).toHaveURL(/\/plan\?entity=/);
	await expect(page.getByPlaceholder('Name', { exact: true })).toHaveValue('Alice Vane');
	await expect(page.locator('.r-line-name')).toHaveText('Departure from Halden');
	await expect(page.locator('.snippet').first()).toContainText('Mrs. Fenwick waited.');
	await page.locator('.r-line').click();
	await expect(page).toHaveURL(/scene=/);
	await expect(page.locator('.cm-content')).toContainText('Mrs. Fenwick waited.');
	const proseSceneUrl = page.url();

	// Entity autocomplete, popup mode (the default): typing part of a name
	// offers the full one.
	await page.locator('.cm-content').click();
	await page.keyboard.press('Control+End');
	await page.keyboard.type(' Ali');
	// Ctrl-Space asks for the completion explicitly. Re-ask until the filtered
	// list shows: a single request can land before the editor has registered
	// the typed text, opening the popup unfiltered, and re-asking re-runs the
	// source against the current text.
	await expect(async () => {
		await page.keyboard.press('Control+Space');
		await expect(page.locator('.cm-tooltip-autocomplete .cm-completionLabel').first()).toHaveText(
			'Alice Vane',
			{ timeout: 2000 }
		);
	}).toPass({ timeout: 15000 });
	// The design's popup: a coloured badge, the kind, and the key footer.
	await expect(page.locator('.cm-tooltip-autocomplete .ac-badge').first()).toHaveText('A');
	await expect(page.locator('.cm-tooltip-autocomplete .cm-completionDetail').first()).toHaveText(
		'character'
	);
	await expect(page.locator('.cm-tooltip-autocomplete .ac-foot')).toBeVisible();
	const acceptSave = page.waitForResponse(
		(r) => r.url().includes('/api/scenes/') && r.request().method() === 'PUT' && r.ok()
	);
	await page.locator('.cm-tooltip-autocomplete li', { hasText: 'Alice Vane' }).click();
	await expect(page.locator('.cm-content')).toContainText('Mrs. Fenwick waited. Alice Vane');
	await acceptSave;

	// Ghost mode comes from the user preference: an unambiguous prefix
	// shows the rest of the name, and Tab accepts it.
	await page.goto('/account');
	await page.getByRole('link', { name: 'Display' }).click();
	await page.getByLabel('Entity autocomplete').selectOption('ghost');
	await page.getByRole('button', { name: 'Save preferences' }).click();
	await expect(page.getByRole('status')).toHaveText('Saved.');
	await page.goto(proseSceneUrl);
	await page.locator('.cm-content').click();
	await page.keyboard.press('Control+End');
	await page.keyboard.type(' Hal');
	await expect(page.locator('.cm-ghost-text')).toHaveText('den');
	const ghostSave = page.waitForResponse(
		(r) => r.url().includes('/api/scenes/') && r.request().method() === 'PUT' && r.ok()
	);
	await page.keyboard.press('Tab');
	await expect(page.locator('.cm-content')).toContainText('Alice Vane Halden');
	await ghostSave;

	// History: the autosaves are already on the timeline; a named
	// checkpoint joins them.
	await page.getByRole('button', { name: 'History' }).click();
	await expect(page.locator('.hist-row').first()).toBeVisible();
	const checkpointSave = page.waitForResponse(
		(r) => r.url().includes('/api/revisions') && r.request().method() === 'POST' && r.ok()
	);
	await page.getByLabel('Checkpoint name').fill('Before the rewrite');
	await page.getByRole('button', { name: 'Checkpoint now' }).click();
	await checkpointSave;
	await expect(page.locator('.hist-label').first()).toHaveText('Before the rewrite');

	// An edit after the checkpoint, so the preview has changes to show.
	const tailSave = page.waitForResponse(
		(r) => r.url().includes('/api/scenes/') && r.request().method() === 'PUT' && r.ok()
	);
	await page.locator('.cm-content').click();
	await page.keyboard.press('Control+End');
	await page.keyboard.type(' The end.');
	await tailSave;

	// Preview the checkpoint: banner, the old text, and a diff against
	// what is live now.
	await page
		.locator('.hist-row', { hasText: 'Before the rewrite' })
		.getByRole('link', { name: 'Preview' })
		.click();
	await expect(page).toHaveURL(/revision=/);
	await expect(page.locator('.revision-banner-title')).toHaveText('Viewing a past revision');
	await expect(page.locator('.prose-historical')).not.toContainText('The end.');
	await page.getByRole('button', { name: 'Show changes' }).click();
	await expect(page.locator('.diff-del')).toContainText('The end.');

	// Restore: the editor comes back with the checkpoint's text and the
	// timeline gains a restore entry on top.
	const restoreDone = page.waitForResponse((r) => r.url().includes('/restore') && r.ok());
	await page.getByRole('button', { name: 'Restore this version' }).click();
	await restoreDone;
	await expect(page).not.toHaveURL(/revision=/);
	await expect(page.locator('.cm-content')).toContainText('Alice Vane Halden');
	await expect(page.locator('.cm-content')).not.toContainText('The end.');
	await expect(page.locator('.hist-label').first()).toHaveText('Restored');

	// TODO markers: a TODO: line highlights in the prose and lands in the
	// To do panel.
	await page.getByRole('button', { name: 'Reference' }).click();
	const todoSave = page.waitForResponse(
		(r) => r.url().includes('/api/scenes/') && r.request().method() === 'PUT' && r.ok()
	);
	await page.locator('.cm-content').click();
	await page.keyboard.press('Control+End');
	await page.keyboard.press('Enter');
	await page.keyboard.type('TODO: tighten the toll scene');
	await todoSave;
	await expect(page.locator('.cm-line.todo-line')).toHaveCount(1);
	await expect(page.locator('.todo-text').first()).toContainText('tighten the toll scene');

	// A marked selection gets a checkable entry and a highlight.
	const markerCreate = page.waitForResponse(
		(r) => r.url().includes('/markers') && r.request().method() === 'POST' && r.ok()
	);
	await page.keyboard.press('Shift+Home');
	await page.keyboard.press('Control+Alt+m');
	await markerCreate;
	await expect(page.locator('.todo-marker')).toHaveCount(1);
	await expect(page.locator('.todo-row')).toHaveCount(2);

	// Checking it off clears the highlight and the row.
	const markerResolve = page.waitForResponse(
		(r) => r.url().includes('/api/markers/') && r.request().method() === 'PUT' && r.ok()
	);
	await page.locator('.todo-check').click();
	await markerResolve;
	await expect(page.locator('.todo-marker')).toHaveCount(0);
	await expect(page.locator('.todo-row')).toHaveCount(1);

	// Assets: a story cover uploads to the bucket and serves back, and a
	// dropped image lands in the prose as markdown. Needs a bucket (CI
	// provides MinIO); without one the segment is skipped, loudly.
	const PNG_B64 =
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
	if (process.env.ASSET_S3_BUCKET) {
		await page.locator('.crumb.current').click();
		await page.getByRole('link', { name: 'Cover' }).click();
		await expect(page.getByRole('heading', { name: 'Cover' })).toBeVisible();
		await expect(page.locator('svg.cover')).toBeVisible();
		await page.getByLabel('Cover image').setInputFiles({
			name: 'cover.png',
			mimeType: 'image/png',
			buffer: Buffer.from(PNG_B64, 'base64')
		});
		await page.getByRole('button', { name: 'Upload cover' }).click();
		await expect(page.getByRole('status')).toHaveText('Cover saved.');
		const coverSrc = await page.locator('img.cover').getAttribute('src');
		const served = await page.request.get(coverSrc!);
		expect(served.status()).toBe(200);
		expect(served.headers()['content-type']).toBe('image/png');

		await page.goto(proseSceneUrl);
		await page.locator('.cm-content').click();
		// Cursor to the end so the dropped image lands after the prose rather
		// than splitting a word; the drop handler falls back to the caret when
		// the drop point is past the text.
		await page.keyboard.press('Control+End');
		const dropSave = page.waitForResponse(
			(r) => r.url().includes('/api/scenes/') && r.request().method() === 'PUT' && r.ok()
		);
		await page.evaluate((b64) => {
			const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
			const transfer = new DataTransfer();
			transfer.items.add(new File([bytes], 'sketch.png', { type: 'image/png' }));
			const target = document.querySelector('.cm-content')!;
			const rect = target.getBoundingClientRect();
			target.dispatchEvent(
				new DragEvent('drop', {
					bubbles: true,
					cancelable: true,
					dataTransfer: transfer,
					clientX: rect.x + 5,
					clientY: rect.bottom + 50
				})
			);
		}, PNG_B64);
		await expect(page.locator('.cm-content')).toContainText('![sketch.png](/assets/');
		// Let the autosave persist the inserted markdown before publishing,
		// so the frozen edition actually contains the image.
		await dropSave;
	} else {
		console.warn('ASSET_S3_BUCKET not set: skipping the asset upload segment.');
	}

	// Publishing: set the story public, freeze an edition, and read it
	// back anonymously on the public pages.
	await page.locator('.crumb.current').click();
	await page.getByRole('link', { name: 'Publish' }).click();
	await expect(page.getByRole('heading', { name: 'Publish' })).toBeVisible();
	await page.getByLabel('Visibility').selectOption('public');
	await page.getByRole('button', { name: 'Save visibility' }).click();
	await expect(page.getByRole('status')).toHaveText('Saved.');
	await page.getByRole('button', { name: 'Publish edition' }).click();
	await expect(page.getByRole('status')).toContainText('Edition published.');

	const anonymous = await browser.newContext({ storageState: { cookies: [], origins: [] } });
	const reader = await anonymous.newPage();
	await reader.goto('/@e2e-tester');
	await expect(reader.getByRole('heading', { name: '@e2e-tester' })).toBeVisible();
	await reader.getByRole('link', { name: 'Book of Ash' }).first().click();
	await expect(reader.getByRole('heading', { level: 1, name: 'Book of Ash' })).toBeVisible();
	await expect(reader.locator('.reader')).toContainText('The gate of Halden');
	// Inline images of a published edition must serve to the anonymous
	// reader, not 404 (bug_004).
	if (process.env.ASSET_S3_BUCKET) {
		const inlineImg = reader.locator('.reader article img').first();
		await expect(inlineImg).toHaveCount(1);
		const src = await inlineImg.getAttribute('src');
		const served = await reader.request.get(src!);
		expect(served.status()).toBe(200);
	}
	// A mistyped story id under a real handle is a clean 404, not a 500.
	const notFound = await reader.request.get('/@e2e-tester/not-a-uuid');
	expect(notFound.status()).toBe(404);
	await anonymous.close();

	// Exports: the zip and the EPUB download, and the print view renders
	// the prose for PDF via the browser dialog.
	await page.getByRole('link', { name: 'Export', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Export' })).toBeVisible();
	const zipDownload = page.waitForEvent('download');
	await page.getByRole('link', { name: 'Markdown (.zip)' }).click();
	expect((await zipDownload).suggestedFilename()).toBe('book-of-ash.zip');
	const epubDownload = page.waitForEvent('download');
	await page.getByRole('link', { name: 'EPUB' }).click();
	expect((await epubDownload).suggestedFilename()).toContain('.epub');
	await page.getByRole('link', { name: 'PDF' }).click();
	await expect(page).toHaveURL(/\/print$/);
	await expect(page.locator('.title-page h1')).toHaveText('Book of Ash');
	await expect(page.locator('.chapter').first()).toContainText('The gate of Halden');
	await page.goto(proseSceneUrl);

	// Scene marks in the story view follow the display preference.
	await page.goto('/account');
	await page.getByRole('link', { name: 'Display' }).click();
	await page.getByLabel('Scene marks in the story view').selectOption('hidden');
	await page.getByRole('button', { name: 'Save preferences' }).click();
	await expect(page.getByRole('status')).toHaveText('Saved.');
	await page.goto(`${proseSceneUrl}&view=story`);
	await expect(page.locator('.doc-scene').first()).toBeVisible();
	await expect(page.locator('.doc-scene-mark')).toHaveCount(0);
	await page.goto(proseSceneUrl);

	// The breadcrumb leads to the universe editor: the same cast at universe
	// scope, with no per-story notes section.
	await page.getByRole('link', { name: universeName }).click();
	await expect(page).toHaveURL(/\/universes\/[^/]+\/plan$/);
	await page.locator('.ent-row', { hasText: 'Alice Vane' }).click();
	await expect(page.getByPlaceholder('Name', { exact: true })).toHaveValue('Alice Vane');
	await expect(page.getByPlaceholder('Notes that apply only to this story.')).toHaveCount(0);

	// Appearances group under the story they come from.
	await expect(page.locator('.r-card h5')).toHaveText('Appears in Book of Ash');
	await expect(page.locator('.r-line-name')).toHaveText('Departure from Halden');

	// An edit made at universe scope persists.
	const universeScopeSave = page.waitForResponse(
		(r) => r.url().includes('/api/characters/') && r.request().method() === 'PUT' && r.ok()
	);
	await page
		.getByPlaceholder('One or two lines. Shown when a mention is hovered.')
		.fill('A toll-road smuggler in debt.');
	await universeScopeSave;
	await page.reload();
	await expect(
		page.getByPlaceholder('One or two lines. Shown when a mention is hovered.')
	).toHaveValue('A toll-road smuggler in debt.');

	// Relationships: declare "lives in Halden" from Alice's page. The add form
	// is behind a dashed chip.
	await page.getByRole('button', { name: 'Add relationship' }).click();
	await page.getByLabel('Relation').selectOption({ label: 'lives in' });
	await page.getByLabel('Related entity').selectOption({ label: 'Halden' });
	await page.getByPlaceholder('Notes (optional)').fill('Since the toll war.');
	const relCreate = page.waitForResponse(
		(r) => r.url().includes('/api/relationships') && r.request().method() === 'POST' && r.ok()
	);
	await page.getByRole('button', { name: 'Add', exact: true }).click();
	await relCreate;
	await expect(page.locator('.rel-row')).toContainText('lives in Halden');

	// The right panel gains a Relationships card; following it lands on
	// Halden, which renders the inverse label.
	const relCard = page.locator('.r-card', { hasText: 'Relationships' });
	await relCard.locator('.r-line', { hasText: 'Halden' }).click();
	await expect(page.getByPlaceholder('Name', { exact: true })).toHaveValue('Halden');
	await expect(page.locator('.rel-row')).toContainText('home of Alice Vane');

	// Removing it from the other end clears both sides.
	const relDelete = page.waitForResponse(
		(r) => r.url().includes('/api/relationships/') && r.request().method() === 'DELETE' && r.ok()
	);
	await page.locator('.rel-remove').click();
	await relDelete;
	await expect(page.locator('.rel-row')).toHaveCount(0);

	// A character created at universe scope belongs to no story yet.
	await page.getByPlaceholder('New character name').fill('Corvin');
	await page.getByRole('button', { name: 'Add character' }).click();
	await expect(page.getByPlaceholder('Name', { exact: true })).toHaveValue('Corvin');

	// The dashboard reaches the story directly, under its universe.
	await page.locator('.brand').click();
	await expect(page).toHaveURL('/');
	const universeSection = page.locator('section', { hasText: universeName });
	await expect(universeSection.getByRole('link', { name: 'Book of Ash' })).toBeVisible();

	// Membership: the story's cast does not list Corvin until he is added
	// to the story; removing the declaration drops him again.
	await universeSection.getByRole('link', { name: 'Book of Ash' }).click();
	await page.getByRole('link', { name: 'Plan' }).click();
	await expect(page.locator('.ent-row', { hasText: 'Alice Vane' })).toHaveCount(1);
	// Corvin is not a member yet; he shows only in the open universe list.
	await expect(page.locator('.ent-row:not(.uni-row)', { hasText: 'Corvin' })).toHaveCount(0);
	await page.getByLabel('Add an existing character').selectOption({ label: 'Corvin' });
	await page.getByRole('button', { name: 'Add to this story' }).click();
	await expect(page).toHaveURL(/entity=/);
	await expect(page.locator('.ent-row', { hasText: 'Corvin' })).toHaveCount(1);
	await expect(page.getByText('Declared in this story.')).toBeVisible();
	const memberOff = page.waitForResponse(
		(r) => r.url().includes('/members') && r.request().method() === 'PUT' && r.ok()
	);
	await page.getByRole('button', { name: 'Remove from this story' }).click();
	await memberOff;
	// Corvin is not a member yet; he shows only in the open universe list.
	await expect(page.locator('.ent-row:not(.uni-row)', { hasText: 'Corvin' })).toHaveCount(0);

	// Deleting a story that has chapters, scenes, markers, revisions, and a
	// published edition succeeds rather than 500ing on the foreign keys, and
	// lands back on the universe.
	await page.goto(`${proseSceneUrl.split('?')[0]}/settings/danger`);
	await page.getByRole('button', { name: 'Delete story' }).click();
	await expect(page).toHaveURL(/\/universes\/[^/]+$/);
	await expect(page.getByRole('link', { name: 'Book of Ash' })).toHaveCount(0);
});

// A signed-out browser of its own: the shared session would bounce off
// /login before the form ever rendered.
test('wrong password is rejected', async ({ browser }) => {
	const anonymous = await browser.newContext({ storageState: { cookies: [], origins: [] } });
	const page = await anonymous.newPage();
	await page.goto('/login');
	await page.getByLabel('Email').fill('e2e@example.com');
	await page.getByLabel('Password').fill('not-the-password');
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page.getByRole('alert')).toHaveText('Wrong email or password.');
	await anonymous.close();
});
