import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import {
	assistantChatMessages,
	assistantChats,
	assistantChatSummaries,
	scenes,
	stories,
	universes,
	users
} from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

process.env.APP_SECRET = process.env.APP_SECRET || 'chat-history-test-secret';

const {
	appendChat,
	deleteChat,
	getChat,
	listChat,
	listChats,
	loadAssistantChat,
	resolveChat,
	setChatSettings,
	setProposalConfirmed
} = await import('../../src/lib/server/llm/chat-history');
const { deleteStory } = await import('../../src/lib/server/story-delete');
const { purgeAccount } = await import('../../src/lib/server/account-deletion');
const { purgeUniverseWithin } = await import('../../src/lib/server/universe-lifecycle');

let pool: pg.Pool;
let db: Database;
let userId: string;
let storyId: string;
let universeId: string;

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await pool.query(
		'truncate table assistant_chat_messages, assistant_chat_summaries, assistant_chats, revisions, scenes, chapters, stories, universes, users cascade'
	);
	const [user] = await db
		.insert(users)
		.values({ email: 'w@example.com', displayName: 'Wren', passwordHash: 'x', role: 'user' })
		.returning({ id: users.id });
	userId = user.id;
	const [universe] = await db
		.insert(universes)
		.values({ ownerId: userId, name: 'U' })
		.returning({ id: universes.id });
	universeId = universe.id;
	const [story] = await db
		.insert(stories)
		.values({ universeId: universe.id, ownerId: userId, title: 'S' })
		.returning({ id: stories.id });
	storyId = story.id;
	await db.insert(scenes).values({ storyId, globalPosition: 1, bodyMd: 'Once.' });
});

afterAll(async () => {
	await pool.end();
});

// A new chat in a scope, as the first message of one creates it.
async function newChat(scope: { storyId: string } | { universeId: string }, title = 'Chat') {
	return (await resolveChat(db, userId, scope, null, title))!;
}

async function say(
	scope: { storyId: string } | { universeId: string },
	chatId: string,
	text: string
) {
	await appendChat(db, userId, scope, chatId, { role: 'user', content: text, meta: null });
}

describe('chat history', () => {
	it('round-trips turns with their meta in order', async () => {
		const chatId = await newChat({ storyId });
		await appendChat(db, userId, { storyId }, chatId, {
			role: 'user',
			content: 'Why is this tense?',
			meta: { reference: { sceneId: storyId, text: 'The rain fell.' } }
		});
		await appendChat(db, userId, { storyId }, chatId, {
			role: 'assistant',
			content: 'Because of the storm.',
			meta: {
				proposals: [{ sceneId: storyId, sceneTitle: null, before: 'The', rationale: 'why' }]
			}
		});
		const stored = await listChat(db, userId, chatId);
		expect(stored.map((m) => m.role)).toEqual(['user', 'assistant']);
		expect(stored[0].meta?.reference?.text).toBe('The rain fell.');
		expect(stored[1].meta?.proposals?.[0].before).toBe('The');
	});

	it('skips empty turns and keeps chats to their owner', async () => {
		const chatId = await newChat({ storyId });
		await appendChat(db, userId, { storyId }, chatId, {
			role: 'assistant',
			content: '   ',
			meta: null
		});
		expect(await listChat(db, userId, chatId)).toHaveLength(0);
		const [other] = await db
			.insert(users)
			.values({ email: 'o@example.com', displayName: 'Other', passwordHash: 'x', role: 'user' })
			.returning({ id: users.id });
		await say({ storyId }, chatId, 'mine');
		expect(await listChat(db, other.id, chatId)).toHaveLength(0);
		expect(await getChat(db, other.id, chatId)).toBeNull();
		expect(await listChats(db, other.id, { storyId })).toEqual([]);
		expect(await deleteChat(db, other.id, chatId)).toBe(false);
		expect(await listChat(db, userId, chatId)).toHaveLength(1);
	});

	it('keeps several chats per story, most recently used first', async () => {
		const first = await newChat({ storyId }, 'First');
		const second = await newChat({ storyId }, 'Second');
		await say({ storyId }, first, 'one');
		await say({ storyId }, second, 'two');
		await say({ storyId }, first, 'three');
		const chats = await listChats(db, userId, { storyId });
		expect(chats.map((c) => c.title)).toEqual(['First', 'Second']);
		expect((await listChat(db, userId, first)).map((m) => m.content)).toEqual(['one', 'three']);
		expect((await listChat(db, userId, second)).map((m) => m.content)).toEqual(['two']);

		const loaded = await loadAssistantChat(db, userId, { storyId });
		expect(loaded.chatId).toBe(first);
		expect(loaded.messages.map((m) => m.content)).toEqual(['one', 'three']);
		expect(loaded.chats).toHaveLength(2);
		expect(loaded.summarised).toBe(false);
	});

	it('opens with no chat when the scope has none', async () => {
		expect(await loadAssistantChat(db, userId, { storyId })).toEqual({
			chats: [],
			chatId: null,
			messages: [],
			summarised: false,
			settings: {},
			model: { model: '', effort: null, claude: false }
		});
	});

	it("opens with the chat's own model choice", async () => {
		const chatId = await newChat({ storyId });
		await setChatSettings(db, userId, chatId, { model: 'other-model' });
		expect((await loadAssistantChat(db, userId, { storyId })).settings).toEqual({
			model: 'other-model'
		});
		await setChatSettings(db, userId, chatId, {});
		expect((await loadAssistantChat(db, userId, { storyId })).settings).toEqual({});
	});

	it('continues only a chat of the same scope', async () => {
		const chatId = await newChat({ storyId });
		expect(await resolveChat(db, userId, { storyId }, chatId, 'x')).toBe(chatId);
		expect(await resolveChat(db, userId, { universeId }, chatId, 'x')).toBeNull();
		expect(await resolveChat(db, userId, { storyId }, 'not-a-uuid', 'x')).toBeNull();
		expect(
			await resolveChat(db, userId, { storyId }, '00000000-0000-4000-8000-000000000009', 'x')
		).toBeNull();
	});

	it('trims the oldest turns past the cap, per chat', async () => {
		const chatId = await newChat({ storyId });
		const other = await newChat({ storyId });
		await say({ storyId }, other, 'untouched');
		for (let i = 0; i < 205; i++) await say({ storyId }, chatId, `turn ${i}`);
		const stored = await listChat(db, userId, chatId);
		expect(stored.length).toBeLessThanOrEqual(200);
		expect(stored[stored.length - 1].content).toBe('turn 204');
		expect(stored[0].content).not.toBe('turn 0');
		expect(await listChat(db, userId, other)).toHaveLength(1);
	});

	it('holds the cap when turns share a timestamp', async () => {
		// Rows written inside one transaction, or in the same microsecond, carry
		// the same created_at; the trim must still keep exactly the cap.
		const chatId = await newChat({ storyId });
		const at = new Date('2026-06-01T12:00:00Z');
		await db.insert(assistantChatMessages).values(
			Array.from({ length: 200 }, (_, i) => ({
				chatId,
				storyId,
				userId,
				role: 'user' as const,
				content: `tied ${i}`,
				createdAt: at
			}))
		);
		await say({ storyId }, chatId, 'newest');
		const stored = await listChat(db, userId, chatId);
		expect(stored).toHaveLength(200);
		expect(stored[stored.length - 1].content).toBe('newest');
	});

	it('deletes one chat with its turns and summary, leaving the others', async () => {
		const gone = await newChat({ storyId });
		const kept = await newChat({ storyId });
		await say({ storyId }, gone, 'hello');
		await say({ storyId }, kept, 'still here');
		await db
			.insert(assistantChatSummaries)
			.values({ chatId: gone, storyId, userId, summary: 's', coveredDigest: 'd' });
		expect(await deleteChat(db, userId, gone)).toBe(true);
		expect(await getChat(db, userId, gone)).toBeNull();
		expect(await listChat(db, userId, gone)).toHaveLength(0);
		expect(await db.select().from(assistantChatSummaries)).toHaveLength(0);
		expect(await listChat(db, userId, kept)).toHaveLength(1);
	});

	it('goes with the story and with the account', async () => {
		await say({ storyId }, await newChat({ storyId }), 'hello');
		await deleteStory(db, storyId, userId);
		expect(
			await db.select().from(assistantChatMessages).where(eq(assistantChatMessages.userId, userId))
		).toHaveLength(0);
		expect(await db.select().from(assistantChats)).toHaveLength(0);

		// A second story's chats go with the whole account.
		const [universe] = await db.select().from(universes);
		const [again] = await db
			.insert(stories)
			.values({ universeId: universe.id, ownerId: userId, title: 'S2' })
			.returning({ id: stories.id });
		await say({ storyId: again.id }, await newChat({ storyId: again.id }), 'still here');
		await purgeAccount(db, userId, null);
		expect(await db.select().from(assistantChatMessages)).toHaveLength(0);
		expect(await db.select().from(assistantChats)).toHaveLength(0);
	});
});

// The universe-Plan chats are keyed on universeId rather than a story. They are
// separate from the story chats in the same universe and go with the universe
// on purge.
describe('universe-scoped chat history', () => {
	it('keeps universe chats separate from story chats in the same universe', async () => {
		await say({ storyId }, await newChat({ storyId }, 'Story chat'), 'about this story');
		await say({ universeId }, await newChat({ universeId }, 'Universe chat'), 'across');
		expect((await listChats(db, userId, { storyId })).map((c) => c.title)).toEqual(['Story chat']);
		expect((await listChats(db, userId, { universeId })).map((c) => c.title)).toEqual([
			'Universe chat'
		]);
	});

	it('rejects a chat with both scopes or neither (the CHECK)', async () => {
		await expect(
			db.insert(assistantChats).values({ storyId, universeId, userId })
		).rejects.toThrow();
		await expect(db.insert(assistantChats).values({ userId })).rejects.toThrow();
	});

	it('goes with the universe on purge', async () => {
		await say({ universeId }, await newChat({ universeId }), 'universe note');
		await db.transaction((tx) => purgeUniverseWithin(tx, universeId));
		expect(await db.select().from(assistantChatMessages)).toHaveLength(0);
		expect(await db.select().from(assistantChats)).toHaveLength(0);
	});
});

// The decided state of a split proposal card rides on its stored turn, so a
// confirm survives a reload and a revert reopens the card.
describe('setProposalConfirmed', () => {
	const proposal = {
		sceneId: '00000000-0000-4000-8000-000000000001',
		sceneTitle: null,
		before: 'Dawn came.',
		rationale: 'A natural break.'
	};

	it('marks the matching proposal confirmed and clears it again', async () => {
		const chatId = await newChat({ storyId });
		await appendChat(db, userId, { storyId }, chatId, {
			role: 'assistant',
			content: 'I propose a split.',
			meta: { proposals: [proposal, { ...proposal, before: 'Another point.' }] }
		});

		const confirmed = {
			splitSceneId: proposal.sceneId,
			newSceneId: '00000000-0000-4000-8000-000000000002'
		};
		expect(
			await setProposalConfirmed(
				db,
				userId,
				{ storyId },
				{ sceneId: proposal.sceneId, before: proposal.before },
				confirmed
			)
		).toBe(true);
		let [turn] = await listChat(db, userId, chatId);
		expect(turn.meta?.proposals?.[0].confirmed).toEqual(confirmed);
		// The other proposal on the same turn is untouched.
		expect(turn.meta?.proposals?.[1].confirmed).toBeUndefined();

		// The revert clears the mark.
		expect(
			await setProposalConfirmed(
				db,
				userId,
				{ storyId },
				{ sceneId: proposal.sceneId, before: proposal.before },
				null
			)
		).toBe(true);
		[turn] = await listChat(db, userId, chatId);
		expect(turn.meta?.proposals?.[0].confirmed).toBeUndefined();
	});

	it('reports no match for an unknown proposal and leaves other users alone', async () => {
		const chatId = await newChat({ storyId });
		await appendChat(db, userId, { storyId }, chatId, {
			role: 'assistant',
			content: 'I propose a split.',
			meta: { proposals: [proposal] }
		});
		expect(
			await setProposalConfirmed(
				db,
				userId,
				{ storyId },
				{ sceneId: proposal.sceneId, before: 'Different words.' },
				{ splitSceneId: 'x', newSceneId: 'y' }
			)
		).toBe(false);
		const [other] = await db
			.insert(users)
			.values({ email: 'o@example.com', displayName: 'O', passwordHash: 'x', role: 'user' })
			.returning({ id: users.id });
		expect(
			await setProposalConfirmed(
				db,
				other.id,
				{ storyId },
				{ sceneId: proposal.sceneId, before: proposal.before },
				{ splitSceneId: 'x', newSceneId: 'y' }
			)
		).toBe(false);
	});
});
