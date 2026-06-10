import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import {
	reviewComments,
	reviewSuggestions,
	reviewThreads,
	scenes,
	stories,
	universes,
	users
} from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/auth';
import type {
	ChatMessage,
	Provider,
	ProviderToolCall,
	HttpRequest
} from '../../src/lib/server/llm/providers/types';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';
import { reanchorRange } from '../../src/lib/review-anchor';

process.env.APP_SECRET = process.env.APP_SECRET || 'review-reply-test-secret';

const {
	addComment,
	createSuggestion,
	createThread,
	decideSuggestion,
	ensureSuggestionThread,
	listThreads,
	updateAssistantSuggestion
} = await import('../../src/lib/server/review');
const { saveAccountLlmConfig } = await import('../../src/lib/server/llm/config');
const { complete } = await import('../../src/lib/server/llm/gateway');

let pool: pg.Pool;
let db: Database;
let authorId: string;
let storyId: string;
let sceneId: string;

const BODY = 'The quick brown fox jumps over the lazy dog.';

function scriptedProvider(turns: { content: string; toolCalls?: ProviderToolCall[] }[]): Provider {
	return {
		async *chatStream() {
			yield { type: 'done' };
		},
		async respond() {
			const turn = turns.shift() ?? { content: '' };
			return { content: turn.content, toolCalls: turn.toolCalls ?? [] };
		},
		async probe() {
			return { ok: true, supportsStreaming: false, supportsTools: true };
		},
		async listModels() {
			return [];
		}
	};
}

const noHttp: HttpRequest = async () => {
	throw new Error('the injected provider should not call the transport');
};

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await pool.query(
		'truncate table review_suggestions, review_comments, review_threads, reviewers, review_invitations, revisions, scenes, chapters, stories, app_settings, universes, users cascade'
	);
	const [author] = await db
		.insert(users)
		.values({ email: 'a@example.com', displayName: 'Avery', passwordHash: 'x', role: 'user' })
		.returning({ id: users.id });
	authorId = author.id;
	const [universe] = await db
		.insert(universes)
		.values({ ownerId: authorId, name: 'U' })
		.returning({ id: universes.id });
	const [story] = await db
		.insert(stories)
		.values({ universeId: universe.id, ownerId: authorId, title: 'S' })
		.returning({ id: stories.id });
	storyId = story.id;
	const [scene] = await db
		.insert(scenes)
		.values({ storyId, globalPosition: 1, bodyMd: BODY })
		.returning({ id: scenes.id });
	sceneId = scene.id;
});

afterAll(async () => {
	await pool.end();
});

async function assistantSuggestion(): Promise<string> {
	const start = BODY.indexOf('quick');
	const made = await createSuggestion(db, {
		storyId,
		sceneId,
		author: { assistant: true },
		range: { start, end: start + 5 },
		replacement: 'swift'
	});
	if (!made.ok) throw new Error(made.reason);
	return made.suggestionId;
}

describe('ensureSuggestionThread', () => {
	it('creates the discussion thread once and finds it after', async () => {
		const suggestionId = await assistantSuggestion();
		const first = await ensureSuggestionThread(db, { storyId, suggestionId });
		const second = await ensureSuggestionThread(db, { storyId, suggestionId });
		expect(first).toMatchObject({ ok: true });
		expect(second).toEqual(first);
		const [thread] = await db
			.select()
			.from(reviewThreads)
			.where(eq(reviewThreads.suggestionId, suggestionId));
		expect(thread.sceneId).toBe(sceneId);
		expect(thread.anchorStart).toBeNull();
	});

	it('refuses a suggestion from another story', async () => {
		const suggestionId = await assistantSuggestion();
		const [other] = await db
			.insert(stories)
			.values({
				universeId: (await db.select().from(universes))[0].id,
				ownerId: authorId,
				title: 'Other'
			})
			.returning({ id: stories.id });
		const result = await ensureSuggestionThread(db, { storyId: other.id, suggestionId });
		expect(result).toMatchObject({ ok: false });
	});

	it('rides along on listThreads with its suggestion id', async () => {
		const suggestionId = await assistantSuggestion();
		const ensured = await ensureSuggestionThread(db, { storyId, suggestionId });
		if (!ensured.ok) throw new Error('thread not created');
		await addComment(db, {
			storyId,
			threadId: ensured.threadId,
			author: { userId: authorId },
			body: 'Could this be softer?'
		});
		const threads = await listThreads(db, storyId, reanchorRange, { userId: authorId });
		const discussion = threads.find((t) => t.id === ensured.threadId);
		expect(discussion?.suggestionId).toBe(suggestionId);
		expect(discussion?.comments.map((c) => c.body)).toEqual(['Could this be softer?']);
		// A standalone thread keeps a null suggestionId.
		await createThread(db, {
			storyId,
			sceneId,
			anchor: null,
			author: { userId: authorId },
			body: 'A scene note.'
		});
		const after = await listThreads(db, storyId, reanchorRange, { userId: authorId });
		expect(after.find((t) => t.suggestionId === null)).toBeTruthy();
	});
});

describe('retracting a suggestion with a discussion', () => {
	it("takes its own discussion along, but never someone else's words", async () => {
		const { deleteSuggestion } = await import('../../src/lib/server/review');
		const start = BODY.indexOf('lazy');
		const made = await createSuggestion(db, {
			storyId,
			sceneId,
			author: { userId: authorId },
			range: { start, end: start + 4 },
			replacement: 'sleepy'
		});
		if (!made.ok) throw new Error(made.reason);
		const ensured = await ensureSuggestionThread(db, { storyId, suggestionId: made.suggestionId });
		if (!ensured.ok) throw new Error('thread not created');
		await addComment(db, {
			storyId,
			threadId: ensured.threadId,
			author: { userId: authorId },
			body: 'My own note.'
		});
		// Only the actor's words in the discussion: the retraction removes both.
		const removed = await deleteSuggestion(db, { userId: authorId }, made.suggestionId);
		expect(removed).toEqual({ ok: true });
		const threads = await db.select().from(reviewThreads);
		expect(threads).toHaveLength(0);

		// With the Assistant's reply in the discussion, the retraction refuses.
		const again = await createSuggestion(db, {
			storyId,
			sceneId,
			author: { userId: authorId },
			range: { start, end: start + 4 },
			replacement: 'dozy'
		});
		if (!again.ok) throw new Error(again.reason);
		const thread2 = await ensureSuggestionThread(db, { storyId, suggestionId: again.suggestionId });
		if (!thread2.ok) throw new Error('thread not created');
		await addComment(db, {
			storyId,
			threadId: thread2.threadId,
			author: { assistant: true },
			body: 'I would keep it.'
		});
		const refused = await deleteSuggestion(db, { userId: authorId }, again.suggestionId);
		expect(refused).toMatchObject({ ok: false });
	});
});

describe('updateAssistantSuggestion', () => {
	it('revises the replacement of a pending assistant suggestion', async () => {
		const suggestionId = await assistantSuggestion();
		const result = await updateAssistantSuggestion(db, {
			storyId,
			suggestionId,
			replacement: 'nimble'
		});
		expect(result).toEqual({ ok: true });
		const [row] = await db
			.select({
				replacement: reviewSuggestions.replacement,
				rangeStart: reviewSuggestions.rangeStart
			})
			.from(reviewSuggestions)
			.where(eq(reviewSuggestions.id, suggestionId));
		expect(row.replacement).toBe('nimble');
		// The anchored range is untouched; only the proposed text moved.
		expect(row.rangeStart).toBe(BODY.indexOf('quick'));
	});

	it('never touches a human-authored or decided suggestion', async () => {
		const start = BODY.indexOf('lazy');
		const human = await createSuggestion(db, {
			storyId,
			sceneId,
			author: { userId: authorId },
			range: { start, end: start + 4 },
			replacement: 'sleepy'
		});
		if (!human.ok) throw new Error(human.reason);
		expect(
			(
				await updateAssistantSuggestion(db, {
					storyId,
					suggestionId: human.suggestionId,
					replacement: 'x'
				})
			).ok
		).toBe(false);

		const assistantId = await assistantSuggestion();
		await decideSuggestion(db, authorId, assistantId, false);
		expect(
			(
				await updateAssistantSuggestion(db, {
					storyId,
					suggestionId: assistantId,
					replacement: 'x'
				})
			).ok
		).toBe(false);
	});
});

describe('scoped review-reply tools through the gateway', () => {
	async function configure() {
		await saveAccountLlmConfig(db, authorId, {
			enabled: true,
			assistantName: 'Muse',
			persona: 'balanced',
			endpoint: 'https://api.example.com/v1',
			apiKey: 'sk',
			models: { chat: 'chat-model' },
			toolCallBudget: 8
		});
	}

	it('reply_in_thread posts into the scoped thread as the Assistant', async () => {
		await configure();
		const suggestionId = await assistantSuggestion();
		const ensured = await ensureSuggestionThread(db, { storyId, suggestionId });
		if (!ensured.ok) throw new Error('thread not created');
		const provider = scriptedProvider([
			{
				content: '',
				toolCalls: [
					{
						id: 'c1',
						name: 'reply_in_thread',
						arguments: JSON.stringify({ comment: 'I softened the verb.' })
					},
					{
						id: 'c2',
						name: 'update_suggestion',
						arguments: JSON.stringify({ replacement: 'gentle' })
					}
				]
			},
			{ content: 'Done.' }
		]);
		const messages: ChatMessage[] = [{ role: 'user', content: 'soften it' }];
		const text = await complete(
			db,
			{
				userId: authorId,
				storyId,
				role: 'reviewer',
				enableTools: true,
				toolNames: ['reply_in_thread', 'update_suggestion'],
				toolScope: { threadId: ensured.threadId, suggestionId },
				messages
			},
			{ provider, http: noHttp }
		);
		expect(text).toBe('Done.');
		const comments = await db
			.select()
			.from(reviewComments)
			.where(eq(reviewComments.threadId, ensured.threadId));
		expect(comments).toHaveLength(1);
		expect(comments[0].assistant).toBe(true);
		expect(comments[0].bodyMd).toBe('I softened the verb.');
		const [updated] = await db
			.select({ replacement: reviewSuggestions.replacement })
			.from(reviewSuggestions)
			.where(eq(reviewSuggestions.id, suggestionId));
		expect(updated.replacement).toBe('gentle');
	});

	it('the scoped tools refuse to run without a scope', async () => {
		await configure();
		const provider = scriptedProvider([
			{
				content: '',
				toolCalls: [
					{ id: 'c1', name: 'reply_in_thread', arguments: JSON.stringify({ comment: 'hi' }) },
					{ id: 'c2', name: 'update_suggestion', arguments: JSON.stringify({ replacement: 'x' }) }
				]
			},
			{ content: 'nothing happened' }
		]);
		await complete(
			db,
			{
				userId: authorId,
				storyId,
				role: 'reviewer',
				enableTools: true,
				toolNames: ['reply_in_thread', 'update_suggestion'],
				messages: [{ role: 'user', content: 'try' }]
			},
			{ provider, http: noHttp }
		);
		const comments = await db.select().from(reviewComments);
		expect(comments).toHaveLength(0);
	});

	it('the default chat toolset does not include the scoped tools', async () => {
		await configure();
		let offered: string[] = [];
		const provider: Provider = {
			async *chatStream() {
				yield { type: 'done' };
			},
			async respond(req) {
				offered = (req.tools ?? []).map((tool) => tool.name);
				return { content: 'ok', toolCalls: [] };
			},
			async probe() {
				return { ok: true, supportsStreaming: false, supportsTools: true };
			},
			async listModels() {
				return [];
			}
		};
		await complete(
			db,
			{
				userId: authorId,
				storyId,
				role: 'chat',
				enableTools: true,
				messages: [{ role: 'user', content: 'hello' }]
			},
			{ provider, http: noHttp }
		);
		expect(offered).not.toContain('reply_in_thread');
		expect(offered).not.toContain('update_suggestion');
		expect(offered).toContain('get_scene');
	});
});
