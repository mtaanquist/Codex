import { expect, test } from '@playwright/test';
import pg from 'pg';
import { e2eDatabaseUrl } from './database';
import { gotoReady } from './navigate';
import { pickFromLibraryMenu } from './library';

// Runs as the account with the Assistant switched on.
test.use({ storageState: 'e2e/.auth/assistant.json' });

declare global {
	interface Window {
		finishReply: () => void;
	}
}

// The panel draws a reply one top-level Markdown block at a time. A reply that
// arrives in pieces keeps the blocks it has finished in place, and a one-line
// notice that takes the place of a longer reply leaves none of it behind.
test('a reply renders block by block as it arrives, and a notice replaces all of it', async ({
	page
}) => {
	await gotoReady(page, '/');
	const name = `Blocks ${Date.now()}`;
	await pickFromLibraryMenu(page, 'New universe');
	await page.getByLabel('New universe').fill(name);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText(`${name} - settings`);

	// A chat whose oldest turn left is a reply of several blocks.
	const pool = new pg.Pool({ connectionString: e2eDatabaseUrl() });
	let universeId: string;
	let chatId: string;
	try {
		const { rows } = await pool.query<{ id: string; owner_id: string }>(
			'select id, owner_id from universes where name = $1',
			[name]
		);
		universeId = rows[0].id;
		const chat = await pool.query<{ id: string }>(
			`insert into assistant_chats (universe_id, user_id, title) values ($1, $2, 'Harbour')
			 returning id`,
			[universeId, rows[0].owner_id]
		);
		chatId = chat.rows[0].id;
		await pool.query(
			`insert into assistant_chat_messages (chat_id, universe_id, user_id, role, content)
			 values ($1, $2, $3, 'assistant', $4)`,
			[chatId, universeId, rows[0].owner_id, '## Harbour notes\n\nIt freezes.\n\n- ice\n- fog']
		);
	} finally {
		await pool.end();
	}

	await gotoReady(page, `/universes/${universeId}/insights`);
	const panel = page.locator('.assistant');
	const replies = panel.locator('.assistant-msg .reply-md');
	await expect(replies).toHaveCount(1);
	await expect(replies.first().locator('h2')).toHaveText('Harbour notes');
	await expect(replies.first().locator('li')).toHaveText(['ice', 'fog']);

	// The next reply arrives in two parts, the second when the test says so.
	// page.route can only answer in one piece, so fetch itself is stood in for.
	await page.evaluate((storedIn) => {
		const real = window.fetch;
		window.fetch = async (input, init) => {
			const url = input instanceof Request ? input.url : String(input);
			if (!url.endsWith('/api/assistant/chat')) return real(input, init);
			window.fetch = real;
			const encoder = new TextEncoder();
			const frame = (event: object) => encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(frame({ type: 'token', text: 'First paragraph.\n\n- one\n' }));
					window.finishReply = () => {
						controller.enqueue(frame({ type: 'token', text: '- two\n\nA last **line**.' }));
						controller.enqueue(frame({ type: 'done' }));
						controller.close();
					};
				}
			});
			return new Response(body, {
				status: 200,
				headers: {
					'content-type': 'text/event-stream',
					'x-chat-id': storedIn,
					'x-chat-created': '0'
				}
			});
		};
	}, chatId);

	const composer = page.getByPlaceholder('Ask about this universe', { exact: false });
	await composer.fill('What else?');
	await composer.press('Enter');
	await expect(replies).toHaveCount(2);
	const streamed = replies.nth(1);
	await expect(streamed.locator('li')).toHaveText(['one']);
	// Mark the finished paragraph: the same element must still be there after
	// the rest arrives, or a selection inside it would be lost.
	await streamed
		.locator('p')
		.first()
		.evaluate((el) => el.setAttribute('data-kept', 'yes'));
	await page.evaluate(() => window.finishReply());
	await expect(streamed.locator('li')).toHaveText(['one', 'two']);
	await expect(streamed.locator('strong')).toHaveText('line');
	await expect(streamed.locator('> p')).toHaveText(['First paragraph.', 'A last line.']);
	await expect(streamed.locator('p[data-kept]')).toHaveText('First paragraph.');
	await expect(panel.getByRole('button', { name: 'Send' })).toBeVisible();

	// The chat was deleted in another tab: one line stands where the turns were.
	await page.route('**/api/assistant/chat', (route) =>
		route.fulfill({ status: 404, json: { message: 'That chat does not exist.' } })
	);
	await composer.fill('And then?');
	await composer.press('Enter');
	await expect(replies).toHaveCount(1);
	await expect(replies.first()).toContainText('This chat was deleted.');
	await expect(replies.first().locator('> *')).toHaveCount(1);
});
