import { expect, test } from '@playwright/test';
import pg from 'pg';
import { confirmPrompt } from './confirm';
import { e2eDatabaseUrl } from './database';
import { gotoReady } from './navigate';
import { pickFromLibraryMenu, startStoryInUniverse } from './library';

// Signs in as the account with the Assistant switched on.
test.use({ storageState: { cookies: [], origins: [] } });

// A writer with two earlier chats in a universe opens the newest, switches to
// the other from the chat list (searching it), starts a new chat, and deletes
// one. The chats are seeded straight into the database; no reply is needed.
test('the Assistant keeps several chats and switches between them', async ({ page }) => {
	await gotoReady(page, '/login');
	await page.getByLabel('Email').fill('assistant-e2e@example.com');
	await page.getByLabel('Password').fill('e2e-password');
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL('/');

	const name = `Chats ${Date.now()}`;
	await pickFromLibraryMenu(page, 'New universe');
	await page.getByLabel('New universe').fill(name);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText(`${name} - settings`);

	const pool = new pg.Pool({ connectionString: e2eDatabaseUrl() });
	let universeId: string;
	try {
		const { rows } = await pool.query<{ id: string; owner_id: string }>(
			'select id, owner_id from universes where name = $1',
			[name]
		);
		universeId = rows[0].id;
		const seed = async (title: string, at: string, turns: [string, string][]) => {
			const chat = await pool.query<{ id: string }>(
				`insert into assistant_chats (universe_id, user_id, title, created_at, updated_at)
				 values ($1, $2, $3, $4, $4) returning id`,
				[universeId, rows[0].owner_id, title, at]
			);
			for (const [role, content] of turns) {
				await pool.query(
					`insert into assistant_chat_messages (chat_id, universe_id, user_id, role, content, created_at)
					 values ($1, $2, $3, $4, $5, $6)`,
					[chat.rows[0].id, universeId, rows[0].owner_id, role, content, at]
				);
			}
		};
		await seed('About the harbour', '2026-11-01T10:00:00Z', [
			['user', 'About the harbour'],
			['assistant', 'The harbour freezes in winter.']
		]);
		await seed('Who is Marra?', '2026-11-02T10:00:00Z', [
			['user', 'Who is Marra?'],
			['assistant', 'Marra is a ferrywoman.']
		]);
	} finally {
		await pool.end();
	}

	await gotoReady(page, `/universes/${universeId}/insights`);
	const panel = page.locator('.assistant');
	const picker = panel.locator('.chat-picker-btn');
	// The most recent chat opens.
	await expect(picker).toHaveText('Who is Marra?');
	await expect(panel.locator('.chat-scroll')).toContainText('Marra is a ferrywoman.');

	// The list shows both, newest first; a search narrows it.
	await picker.click();
	const list = page.getByRole('dialog', { name: 'Your chats' });
	await expect(list.locator('.chat-row-title')).toHaveText(['Who is Marra?', 'About the harbour']);
	await list.getByLabel('Search chats').fill('harb');
	await expect(list.locator('.chat-row-title')).toHaveText(['About the harbour']);
	await list.locator('.chat-row').click();
	await expect(picker).toHaveText('About the harbour');
	await expect(panel.locator('.chat-scroll')).toContainText('The harbour freezes in winter.');
	await expect(panel.locator('.chat-scroll')).not.toContainText('ferrywoman');

	// A new chat starts empty and the earlier ones stay listed.
	await panel.getByRole('button', { name: 'New chat' }).click();
	await expect(picker).toHaveText('New chat');
	await expect(panel.locator('.chat-scroll')).not.toContainText('harbour freezes');

	// Deleting a chat removes it from the list, and it stays gone on a reload.
	await picker.click();
	await list.locator('.chat-row', { hasText: 'About the harbour' }).click();
	await panel.getByRole('button', { name: 'More actions' }).click();
	await page.getByRole('menuitem', { name: 'Delete chat' }).click();
	await confirmPrompt(page, 'Delete chat');
	await expect(picker).toHaveText('New chat');
	await page.reload();
	await expect(picker).toHaveText('Who is Marra?');
	await picker.click();
	await expect(list.locator('.chat-row-title')).toHaveText(['Who is Marra?']);
});

// Switching to another story of the universe from the outline keeps the page
// mounted; the Assistant panel must follow to the new story's chats rather
// than keep the old ones.
test('the Assistant panel follows a switch to another story', async ({ page }) => {
	await gotoReady(page, '/login');
	await page.getByLabel('Email').fill('assistant-e2e@example.com');
	await page.getByLabel('Password').fill('e2e-password');
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL('/');

	const name = `Switch ${Date.now()}`;
	await pickFromLibraryMenu(page, 'New universe');
	await page.getByLabel('New universe').fill(name);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText(`${name} - settings`);
	for (const title of ['Ashfall', 'Birchwood']) {
		await gotoReady(page, '/');
		await startStoryInUniverse(page, name);
		await page.getByLabel('New story').fill(title);
		await page.getByRole('button', { name: 'Create story' }).click();
		await expect(page.locator('.story-title')).toHaveText(title);
	}

	const pool = new pg.Pool({ connectionString: e2eDatabaseUrl() });
	try {
		const { rows } = await pool.query<{ id: string; owner_id: string }>(
			`select s.id, s.owner_id from stories s join universes u on u.id = s.universe_id
			 where u.name = $1 and s.title = 'Ashfall'`,
			[name]
		);
		const chat = await pool.query<{ id: string }>(
			`insert into assistant_chats (story_id, user_id, title) values ($1, $2, 'Ash questions')
			 returning id`,
			[rows[0].id, rows[0].owner_id]
		);
		for (const [role, content] of [
			['user', 'Ash questions'],
			['assistant', 'The ash falls for a week.']
		]) {
			await pool.query(
				`insert into assistant_chat_messages (chat_id, story_id, user_id, role, content)
				 values ($1, $2, $3, $4, $5)`,
				[chat.rows[0].id, rows[0].id, rows[0].owner_id, role, content]
			);
		}
	} finally {
		await pool.end();
	}

	await page.locator('.story-switch').click();
	await page.locator('.story-menu button', { hasText: 'Ashfall' }).click();
	await expect(page.locator('.story-title')).toHaveText('Ashfall');
	const tab = page.locator('.right-head .seg-btn', { hasText: 'Assistant' });
	const panel = page.locator('.assistant');
	const picker = panel.locator('.chat-picker-btn');
	await expect(async () => {
		await tab.click();
		await expect(picker).toHaveText('Ash questions', { timeout: 2000 });
	}).toPass();
	await expect(panel.locator('.chat-scroll')).toContainText('The ash falls for a week.');

	await page.locator('.story-switch').click();
	await page.locator('.story-menu button', { hasText: 'Birchwood' }).click();
	await expect(page.locator('.story-title')).toHaveText('Birchwood');
	await expect(picker).toHaveText('New chat');
	await expect(panel.locator('.chat-scroll')).not.toContainText('ash falls');
	await picker.click();
	await expect(
		page.getByRole('dialog', { name: 'Your chats' }).locator('.chat-row-title')
	).toHaveCount(0);
});

// A recap that fails in a new chat stores nothing, and the server drops the
// chat it made for it; the panel must not hold on to that chat, or the next
// question would be sent to a chat that is gone.
test('a failed catch-up in a new chat leaves the next question in a new chat', async ({ page }) => {
	await gotoReady(page, '/login');
	await page.getByLabel('Email').fill('assistant-e2e@example.com');
	await page.getByLabel('Password').fill('e2e-password');
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL('/');

	const name = `Recap ${Date.now()}`;
	await pickFromLibraryMenu(page, 'New universe');
	await page.getByLabel('New universe').fill(name);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText(`${name} - settings`);
	await gotoReady(page, '/');
	await startStoryInUniverse(page, name);
	await page.getByLabel('New story').fill('Cinders');
	await page.getByRole('button', { name: 'Create story' }).click();
	await expect(page.locator('.story-title')).toHaveText('Cinders');

	const tab = page.locator('.right-head .seg-btn', { hasText: 'Assistant' });
	const panel = page.locator('.assistant');
	const picker = panel.locator('.chat-picker-btn');
	await expect(async () => {
		await tab.click();
		await expect(picker).toHaveText('New chat', { timeout: 2000 });
	}).toPass();

	// The endpoint fails mid-recap; the server has already dropped the chat.
	await page.route('**/api/assistant/recap', (route) =>
		route.fulfill({
			status: 200,
			headers: {
				'content-type': 'text/event-stream',
				'x-chat-id': '00000000-0000-4000-8000-000000000001'
			},
			body: `data: ${JSON.stringify({ type: 'error', message: 'The endpoint failed.' })}\n\n`
		})
	);
	await panel.getByRole('button', { name: 'More actions' }).click();
	await page.getByRole('menuitem', { name: 'Catch me up' }).click();
	await expect(panel.locator('.chat-scroll')).toContainText('The endpoint failed.');
	await expect(picker).toHaveText('New chat');

	let posted: { chatId?: string | null } | null = null;
	await page.route('**/api/assistant/chat', async (route) => {
		posted = route.request().postDataJSON();
		await route.fulfill({
			status: 200,
			headers: { 'content-type': 'text/event-stream' },
			body: `data: ${JSON.stringify({ type: 'done' })}\n\n`
		});
	});
	const composer = page.getByPlaceholder('Ask about your story', { exact: false });
	await composer.fill('Who lit the fire?');
	await composer.press('Enter');
	await expect.poll(() => posted).not.toBeNull();
	expect(posted!.chatId ?? null).toBeNull();
});
