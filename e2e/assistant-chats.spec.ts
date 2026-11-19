import { expect, test, type Page } from '@playwright/test';
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
	const picker = panel.locator('.chat-title');
	// The most recent chat opens.
	await expect(picker).toHaveText('Who is Marra?');
	await expect(panel.locator('.chat-scroll')).toContainText('Marra is a ferrywoman.');

	// The list shows both, newest first; a search narrows it.
	await panel.getByRole('button', { name: 'Chat history' }).click();
	const list = page.getByRole('dialog', { name: 'Your chats' });
	await expect(list.locator('.chat-row-title')).toHaveText(['Who is Marra?', 'About the harbour']);
	// Arrow keys move between the search box and the rows.
	const search = list.getByLabel('Search chats');
	await search.focus();
	await page.keyboard.press('ArrowDown');
	await expect(list.locator('.chat-row').first()).toBeFocused();
	await page.keyboard.press('ArrowDown');
	await expect(list.locator('.chat-row').nth(1)).toBeFocused();
	await page.keyboard.press('Home');
	await expect(list.locator('.chat-row').first()).toBeFocused();
	await page.keyboard.press('ArrowUp');
	await expect(search).toBeFocused();
	await search.fill('harb');
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
	await panel.getByRole('button', { name: 'Chat history' }).click();
	await list.locator('.chat-row', { hasText: 'About the harbour' }).click();
	await panel.getByRole('button', { name: 'Chat commands' }).click();
	await panel.getByRole('option', { name: /Delete chat/ }).click();
	await confirmPrompt(page, 'Delete chat');
	await expect(picker).toHaveText('New chat');
	await page.reload();
	await expect(picker).toHaveText('Who is Marra?');
	await panel.getByRole('button', { name: 'Chat history' }).click();
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
	const picker = panel.locator('.chat-title');
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
	await panel.getByRole('button', { name: 'Chat history' }).click();
	await expect(
		page.getByRole('dialog', { name: 'Your chats' }).locator('.chat-row-title')
	).toHaveCount(0);
});

// Signs in as the Assistant account, starts a story in a fresh universe, and
// opens the Assistant tab on a new chat.
async function freshStoryPanel(page: Page, label: string, storyTitle = 'Cinders') {
	await gotoReady(page, '/login');
	await page.getByLabel('Email').fill('assistant-e2e@example.com');
	await page.getByLabel('Password').fill('e2e-password');
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL('/');

	const name = `${label} ${Date.now()}`;
	await pickFromLibraryMenu(page, 'New universe');
	await page.getByLabel('New universe').fill(name);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText(`${name} - settings`);
	await gotoReady(page, '/');
	await startStoryInUniverse(page, name);
	await page.getByLabel('New story').fill(storyTitle);
	await page.getByRole('button', { name: 'Create story' }).click();
	await expect(page.locator('.story-title')).toHaveText(storyTitle);

	const tab = page.locator('.right-head .seg-btn', { hasText: 'Assistant' });
	const panel = page.locator('.assistant');
	const picker = panel.locator('.chat-title');
	await expect(async () => {
		await tab.click();
		await expect(picker).toHaveText('New chat', { timeout: 2000 });
	}).toPass();

	return { panel, picker };
}

// A recap that fails in a new chat stores nothing, and the server drops the
// chat it made for it; the panel must not hold on to that chat, or the next
// question would be sent to a chat that is gone.
test('a failed catch-up in a new chat leaves the next question in a new chat', async ({ page }) => {
	const { panel, picker } = await freshStoryPanel(page, 'Recap');

	// The endpoint fails mid-recap; the server has already dropped the chat.
	let recapChatId: string | undefined;
	await page.route('**/api/assistant/recap', (route) => {
		recapChatId = (route.request().postDataJSON() as { newChatId?: string }).newChatId;
		return route.fulfill({
			status: 200,
			headers: {
				'content-type': 'text/event-stream',
				'x-chat-id': '00000000-0000-4000-8000-000000000001',
				'x-chat-created': '1',
				'x-chat-title': 'Catch%20me%20up'
			},
			body: `data: ${JSON.stringify({ type: 'error', message: 'The endpoint failed.' })}\n\n`
		});
	});
	await panel.getByRole('button', { name: 'Chat commands' }).click();
	await panel.getByRole('option', { name: /Catch me up/ }).click();
	await expect(panel.locator('.chat-scroll')).toContainText('The endpoint failed.');
	await expect(picker).toHaveText('New chat');

	let posted: { chatId?: string | null; newChatId?: string } | null = null;
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
	// A fresh id, so the question cannot land in the chat the server is dropping.
	expect(recapChatId).toBeTruthy();
	expect(posted!.newChatId).not.toBe(recapChatId);
});

// A first question stopped before any reply reaches the panel may already be
// stored, so the next question goes to the same chat, under the first one's
// title as the server stored it.
test('a question after a stopped first send lands in the same chat', async ({ page }) => {
	const { panel, picker } = await freshStoryPanel(page, 'Stopped');

	const ids: (string | undefined)[] = [];
	await page.route('**/api/assistant/chat', async (route) => {
		const body = route.request().postDataJSON() as { newChatId?: string };
		ids.push(body.newChatId);
		if (ids.length === 1) {
			await route.abort();
			return;
		}
		await route.fulfill({
			status: 200,
			headers: {
				'content-type': 'text/event-stream',
				'x-chat-id': body.newChatId ?? '',
				'x-chat-created': '0',
				'x-chat-title': encodeURIComponent('Who lit the fire?')
			},
			body:
				`data: ${JSON.stringify({ type: 'token', text: 'Nobody knows.' })}\n\n` +
				`data: ${JSON.stringify({ type: 'done' })}\n\n`
		});
	});
	const composer = page.getByPlaceholder('Ask about your story', { exact: false });
	await composer.fill('Who lit the fire?');
	await composer.press('Enter');
	await expect.poll(() => ids.length).toBe(1);
	await expect(panel.locator('.chat-scroll')).toContainText('something went wrong');
	await composer.fill('And why?');
	await composer.press('Enter');
	await expect(panel.locator('.chat-scroll')).toContainText('Nobody knows.');
	expect(ids[1]).toBe(ids[0]);
	await expect(picker).toHaveText('Who lit the fire?');
});

// The model chip picks a model for this chat only: it rides with the chat's
// messages, and a new chat starts on the default again.
test('the model chip sets the model for one chat', async ({ page }) => {
	const { panel } = await freshStoryPanel(page, 'Model');
	await page.route('**/api/assistant/models', (route) =>
		route.fulfill({ json: { models: ['big-model', 'small-model'], complete: true } })
	);
	const settings: unknown[] = [];
	await page.route('**/api/assistant/chat', async (route) => {
		settings.push((route.request().postDataJSON() as { settings?: unknown }).settings);
		await route.fulfill({
			status: 200,
			headers: { 'content-type': 'text/event-stream' },
			body: `data: ${JSON.stringify({ type: 'done' })}\n\n`
		});
	});

	const chip = panel.getByRole('button', { name: /Model for this chat/ });
	const menu = page.getByRole('menu', { name: 'Model for this chat' });
	// The chip toggles its menu.
	await chip.click();
	await expect(menu).toBeVisible();
	await chip.click();
	await expect(menu).toHaveCount(0);
	await chip.click();
	await expect(menu.getByRole('menuitemradio', { name: /Default/ })).toHaveAttribute(
		'aria-checked',
		'true'
	);
	await menu.getByRole('menuitemradio', { name: 'small-model' }).click();
	await expect(menu).toHaveCount(0);
	await expect(chip).toContainText('small-model');

	const composer = page.getByPlaceholder('Ask about your story', { exact: false });
	await composer.fill('Who lit the fire?');
	await composer.press('Enter');
	await expect.poll(() => settings.length).toBe(1);
	expect(settings[0]).toEqual({ model: 'small-model' });

	await panel.getByRole('button', { name: 'New chat' }).click();
	await expect(chip).not.toContainText('small-model');
});

// Context from the + button: a story opens its own options, the pick shows as
// a chip, goes with the next message only, and stays on that message.
test('context added from the picker goes with the next message', async ({ page }) => {
	const title = `Ember ${Date.now()}`;
	const { panel } = await freshStoryPanel(page, 'Context', title);
	const posted: { attachments?: unknown }[][] = [];
	await page.route('**/api/assistant/chat', async (route) => {
		const body = route.request().postDataJSON() as { messages: { attachments?: unknown }[] };
		posted.push(body.messages);
		const first = posted.length === 1;
		const attachments = body.messages.at(-1)?.attachments as { id: string }[] | undefined;
		await route.fulfill({
			status: 200,
			headers: {
				'content-type': 'text/event-stream',
				// The whole book was sent, cut to fit.
				...(first && attachments
					? { 'x-chat-attachments': `story:${attachments[0].id}:book!` }
					: {})
			},
			body:
				`data: ${JSON.stringify({ type: 'token', text: 'Read it.' })}\n\n` +
				`data: ${JSON.stringify({ type: 'done' })}\n\n`
		});
	});

	await panel.getByRole('button', { name: 'Add context' }).click();
	const search = page.getByLabel('Search for context to add');
	await expect(search).toBeFocused();
	await search.fill(title);
	await expect(page.getByRole('option', { name: new RegExp(title) })).toBeVisible();
	await page.keyboard.press('Enter');
	await expect(page.getByRole('option', { name: /Outline and summaries/ })).toBeVisible();
	await page.getByRole('option', { name: /Whole book/ }).click();
	const chip = panel.locator('.composer .context-chip');
	await expect(chip).toHaveText(new RegExp(`${title} \\(whole book\\)`));

	const composer = page.getByPlaceholder('Ask about your story', { exact: false });
	await composer.fill('What is this book about?');
	await composer.press('Enter');
	await expect(panel.locator('.msg.user .msg-attachment')).toHaveText(
		`${title} (whole book) (shortened)`
	);
	await expect(chip).toHaveCount(0);
	expect(posted[0].at(-1)?.attachments).toEqual([
		expect.objectContaining({ kind: 'story', depth: 'book', label: title })
	]);

	await composer.fill('And the ending?');
	await composer.press('Enter');
	await expect.poll(() => posted.length).toBe(2);
	expect(posted[1].at(-1)?.attachments).toBeUndefined();
});

test('the command menu and Tab keep a draft, and a refused send comes back', async ({ page }) => {
	const { panel } = await freshStoryPanel(page, 'Draft');
	const composer = page.getByPlaceholder('Ask about your story', { exact: false });

	// A command from the menu leaves the draft alone; one that takes input
	// goes in front of it.
	await composer.fill('Mira');
	await panel.getByRole('button', { name: 'Chat commands' }).click();
	await page.getByRole('option', { name: /Add context/ }).click();
	await page.keyboard.press('Escape');
	await expect(composer).toHaveValue('Mira');
	await panel.getByRole('button', { name: 'Chat commands' }).click();
	await page.getByRole('option', { name: /Character or place sheet/ }).click();
	await expect(composer).toHaveValue('/who Mira');

	// Tab completes a typed command without running it.
	await composer.fill('/mu');
	await composer.press('Tab');
	await expect(composer).toHaveValue('/mute');
	await expect(panel.getByRole('button', { name: 'Chat commands' })).toBeVisible();

	// A send the server turns away goes back in the chat box.
	await page.route('**/api/assistant/chat', (route) =>
		route.fulfill({
			status: 429,
			contentType: 'application/json',
			body: JSON.stringify({ message: 'Too many Assistant requests in a short time.' })
		})
	);
	await composer.fill('Where does it end?');
	await composer.press('Enter');
	await expect(panel.locator('.msg.assistant-msg').last()).toContainText(
		'Your message was not sent. Too many Assistant requests'
	);
	await expect(composer).toHaveValue('Where does it end?');
	await expect(panel.locator('.msg.user')).toHaveCount(0);

	// So does one that never reaches the server.
	await page.unroute('**/api/assistant/chat');
	await page.route('**/api/assistant/chat', (route) => route.abort('internetdisconnected'));
	await composer.fill('And the middle?');
	await composer.press('Enter');
	await expect(composer).toHaveValue('And the middle?');
	await expect(panel.locator('.msg.user')).toHaveCount(0);

	// A /rewrite that cannot go ahead keeps the line.
	await composer.fill('/rewrite cut the adverbs');
	await composer.press('Enter');
	await expect(panel.locator('.msg.assistant-msg').last()).toContainText('to use /rewrite');
	await expect(composer).toHaveValue('/rewrite cut the adverbs');
});

// A model that could not be saved does not stay on the chip, and a starter
// suggestion leaves a typed draft in the chat box.
test('a failed model save reverts the chip, and a suggestion keeps the draft', async ({ page }) => {
	const { panel } = await freshStoryPanel(page, 'Revert');
	const composer = page.getByPlaceholder('Ask about your story', { exact: false });

	await page.route('**/api/assistant/chat', (route) =>
		route.fulfill({
			status: 200,
			headers: {
				'content-type': 'text/event-stream',
				'x-chat-id': '00000000-0000-4000-8000-000000000001',
				'x-chat-title': 'Suggested'
			},
			body: `data: ${JSON.stringify({ type: 'done' })}\n\n`
		})
	);
	await composer.fill('My own question');
	await panel.locator('.suggest-chip').first().click();
	await expect(panel.locator('.msg.user')).toHaveCount(1);
	await expect(composer).toHaveValue('My own question');

	await page.route('**/api/assistant/models', (route) =>
		route.fulfill({ json: { models: ['big-model', 'small-model'], complete: true } })
	);
	await page.route('**/api/assistant/chats/*', (route) =>
		route.request().method() === 'PATCH' ? route.fulfill({ status: 500 }) : route.continue()
	);
	const chip = panel.getByRole('button', { name: /Model for this chat/ });
	await chip.click();
	await page
		.getByRole('menu', { name: 'Model for this chat' })
		.getByRole('menuitemradio', { name: 'small-model' })
		.click();
	await expect(page.getByText('Could not save the model')).toBeVisible();
	await expect(chip).not.toContainText('small-model');
});
