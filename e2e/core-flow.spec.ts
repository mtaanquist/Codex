import { expect, test } from '@playwright/test';

test('sign in, create a universe and a story, and open it', async ({ page }) => {
	await page.goto('/login');
	await page.getByLabel('Email').fill('e2e@example.com');
	await page.getByLabel('Password').fill('e2e-password');
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL('/');

	// Unique name so repeated local runs do not collide.
	const universeName = `Testverse ${Date.now()}`;
	await page.getByLabel('New universe').fill(universeName);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText(universeName);

	await page.getByLabel('New story').fill('Book of Ash');
	await page.getByRole('button', { name: 'Create story' }).click();

	// Opening a story lands in the editor shell: breadcrumb and sidebar both
	// carry the story title.
	await expect(page.locator('.crumb.current')).toHaveText('Book of Ash');
	await expect(page.locator('.story-title')).toHaveText('Book of Ash');

	// Focus mode hides the chrome; Esc brings it back.
	await page.getByRole('button', { name: 'Focus mode' }).click();
	await expect(page.locator('.topbar')).toBeHidden();
	await page.keyboard.press('Escape');
	await expect(page.locator('.topbar')).toBeVisible();

	// Build the tree: a chapter, then a scene inside it, which opens.
	await page.getByRole('button', { name: 'New chapter' }).click();
	await expect(page.locator('.chapter-name')).toHaveText('Chapter 1');
	await page.getByRole('button', { name: 'New scene' }).click();
	await expect(page).toHaveURL(/scene=/);
	await expect(page.getByPlaceholder('Untitled scene')).toBeVisible();
	await expect(page.locator('.scene-row.active .scene-name')).toHaveText('Untitled scene');

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
	await page.locator('.scene-row').nth(1).click();
	await expect(page).toHaveURL(/#scene-/);

	// Toggling back returns to the scene that was open before.
	await page.getByRole('link', { name: 'Back to the scene editor' }).click();
	await expect(page).toHaveURL(sceneUrl);

	// A scene mark in the document jumps straight into editing that scene.
	await page.getByRole('link', { name: 'Read the whole story' }).click();
	await page.locator('.doc-scene-mark').nth(1).click();
	await expect(page).toHaveURL(/scene=/);
	await expect(page.locator('.cm-content')).toContainText('The gate of Halden');

	// Plan view: create a character, fill the editor, and it persists.
	await page.getByRole('link', { name: 'Plan' }).click();
	await expect(page).toHaveURL(/\/plan$/);
	await page.getByPlaceholder('New character name').fill('Alice');
	await page.getByRole('button', { name: 'Add character' }).click();
	await expect(page).toHaveURL(/entity=/);
	const characterSave = page.waitForResponse(
		(r) => r.url().includes('/api/characters/') && r.request().method() === 'PUT' && r.ok()
	);
	await page.getByPlaceholder('Name', { exact: true }).fill('Alice Vane');
	await page
		.getByPlaceholder('Nicknames and variants, separated by commas. Used to spot mentions.')
		.fill('Allie, Mrs. Fenwick');
	await page
		.getByPlaceholder('One or two lines. Shown when a mention is hovered.')
		.fill('A toll-road smuggler.');
	await page
		.getByPlaceholder('Notes that apply only to this story.')
		.fill('Starts the book in debt.');
	await characterSave;
	await page.reload();
	await expect(page.getByPlaceholder('Name', { exact: true })).toHaveValue('Alice Vane');
	await expect(page.locator('.ent-row .name')).toHaveText('Alice Vane');
	await expect(page.getByPlaceholder('Notes that apply only to this story.')).toHaveValue(
		'Starts the book in debt.'
	);

	// Back to Write via the segmented control.
	await page.getByRole('link', { name: 'Write' }).click();
	await expect(page.locator('.chapter-name')).toHaveText('Chapter 1');

	// Mentions: typing a known alias underlines it live; hovering shows the
	// character's summary.
	await page.locator('.scene-row').nth(1).click();
	await expect(page.locator('.cm-content')).toContainText('The gate of Halden');
	await page.locator('.cm-content').click();
	await page.keyboard.press('Control+End');
	await page.keyboard.type(' Mrs. Fenwick waited.');
	await expect(page.locator('.ref-word')).toHaveText('Mrs. Fenwick');
	await page.locator('.ref-word').hover();
	await expect(page.locator('.entity-tip-name')).toHaveText('Alice Vane');
	await expect(page.locator('.entity-tip-summary')).toHaveText('A toll-road smuggler.');

	// The breadcrumb leads back to the universe, which lists the story.
	await page.getByRole('link', { name: universeName }).click();
	await expect(page.getByRole('link', { name: 'Book of Ash' })).toBeVisible();
});

test('wrong password is rejected', async ({ page }) => {
	await page.goto('/login');
	await page.getByLabel('Email').fill('e2e@example.com');
	await page.getByLabel('Password').fill('not-the-password');
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page.getByRole('alert')).toHaveText('Wrong email or password.');
});
