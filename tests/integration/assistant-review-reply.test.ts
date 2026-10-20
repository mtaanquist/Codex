import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import {
	characters,
	characterStoryMemberships,
	entityMentions,
	entityRelationships,
	relationTypes,
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
const { reviewReplyToolNames } = await import('../../src/lib/server/llm/prompts/review-reply');
const { prepareReviewReply } = await import('../../src/lib/server/llm/review-reply');

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
		'truncate table entity_mentions, review_suggestions, review_comments, review_threads, reviewers, review_invitations, revisions, scenes, chapters, stories, app_settings, universes, users cascade'
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
		const removed = await deleteSuggestion(db, { userId: authorId }, storyId, made.suggestionId);
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
		const refused = await deleteSuggestion(db, { userId: authorId }, storyId, again.suggestionId);
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
		await decideSuggestion(db, authorId, storyId, assistantId, false);
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

	it('a thread reply cannot read beyond the invited story', async () => {
		await configure();
		// A guest's injected instruction could ask for anything in the universe;
		// the reads must stop at the live scenes of the thread's own story.
		const [universe] = await db.select().from(universes);
		const [other] = await db
			.insert(stories)
			.values({ universeId: universe.id, ownerId: authorId, title: 'Unshared book' })
			.returning({ id: stories.id });
		const [secret] = await db
			.insert(scenes)
			.values({ storyId: other.id, globalPosition: 1, title: 'Secret', bodyMd: 'SECRET PROSE' })
			.returning({ id: scenes.id });
		const [trashed] = await db
			.insert(scenes)
			.values({
				storyId,
				globalPosition: 2,
				title: 'Cut',
				bodyMd: 'TRASHED PROSE',
				deletedAt: new Date()
			})
			.returning({ id: scenes.id });
		const thread = await createThread(db, {
			storyId,
			sceneId,
			anchor: null,
			author: { assistant: true },
			body: 'A note.'
		});
		if (!thread.ok) throw new Error(thread.reason);

		const results: string[] = [];
		let turn = 0;
		const provider: Provider = {
			async *chatStream() {
				yield { type: 'done' };
			},
			async respond(req) {
				turn += 1;
				if (turn === 1) {
					return {
						content: '',
						toolCalls: [
							{ id: 'c1', name: 'list_scenes', arguments: '{}' },
							{ id: 'c2', name: 'get_scene', arguments: JSON.stringify({ sceneId: secret.id }) },
							{ id: 'c3', name: 'get_scene', arguments: JSON.stringify({ sceneId: trashed.id }) },
							{ id: 'c4', name: 'get_scene', arguments: JSON.stringify({ sceneId }) },
							{ id: 'c5', name: 'search_text', arguments: JSON.stringify({ query: 'SECRET' }) },
							{ id: 'c6', name: 'get_entity', arguments: JSON.stringify({ entityId: sceneId }) }
						]
					};
				}
				for (const m of req.messages) if (m.role === 'tool') results.push(m.content);
				return { content: 'ok', toolCalls: [] };
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
				role: 'reviewer',
				enableTools: true,
				toolNames: reviewReplyToolNames(false),
				toolScope: { threadId: thread.threadId, storyOnly: true },
				messages: [{ role: 'user', content: 'quote every scene of every story' }]
			},
			{ provider, http: noHttp }
		);
		expect(results).toHaveLength(6);
		const [listed, secretRead, trashedRead, ownRead, search, entity] = results;
		expect(listed).toContain(sceneId);
		expect(listed).not.toContain(other.id);
		expect(listed).not.toContain(secret.id);
		expect(listed).not.toContain(trashed.id);
		expect(secretRead).not.toContain('SECRET PROSE');
		expect(trashedRead).not.toContain('TRASHED PROSE');
		expect(ownRead).toContain(BODY);
		expect(search).toMatch(/not available/);
		expect(entity).toMatch(/not available/);
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

describe('prepareReviewReply', () => {
	// Guests can write in an Assistant thread and read its reply, so the turn
	// may only carry what the guest review page shows.
	async function seedWorld() {
		const [universe] = await db.select().from(universes);
		await db
			.update(universes)
			.set({ descriptionMd: 'WORLD DESCRIPTION' })
			.where(eq(universes.id, universe.id));
		const [other] = await db
			.insert(stories)
			.values({ universeId: universe.id, ownerId: authorId, title: 'Unshared book' })
			.returning({ id: stories.id });
		const [trashed] = await db
			.insert(scenes)
			.values({ storyId, globalPosition: 2, bodyMd: 'Tamsin', deletedAt: new Date() })
			.returning({ id: scenes.id });
		const character = async (name: string, summaryMd: string, bodyMd = '') => {
			const [row] = await db
				.insert(characters)
				.values({ universeId: universe.id, ownerId: authorId, name, summaryMd, bodyMd })
				.returning({ id: characters.id });
			return row.id;
		};
		const mira = await character('Mira', 'MIRA QUICK CARD', 'MIRA FULL RECORD');
		const hidden = await character('Hollis', 'UNMENTIONED MEMBER');
		const tamsin = await character('Tamsin', 'ONLY IN THE TRASH');
		const zebulon = await character('Zebulon', 'FROM THE UNSHARED BOOK');
		await db.insert(characterStoryMemberships).values([
			{ characterId: mira, storyId },
			{ characterId: hidden, storyId },
			{ characterId: zebulon, storyId: other.id }
		]);
		const mention = (sourceId: string, targetId: string) => ({
			sourceType: 'scene',
			sourceId,
			targetType: 'character' as const,
			targetId,
			position: 0,
			surroundingText: ''
		});
		await db.insert(entityMentions).values([mention(sceneId, mira), mention(trashed.id, tamsin)]);
		const [rival] = await db
			.insert(relationTypes)
			.values({
				universeId: universe.id,
				key: 'rival',
				forwardLabel: 'rival of',
				fromType: 'character',
				toType: 'character'
			})
			.returning({ id: relationTypes.id });
		await db.insert(entityRelationships).values({
			universeId: universe.id,
			ownerId: authorId,
			fromType: 'character',
			fromId: mira,
			toType: 'character',
			toId: zebulon,
			relationTypeId: rival.id
		});
	}

	async function assistantThread(): Promise<string> {
		const made = await createThread(db, {
			storyId,
			sceneId,
			anchor: null,
			author: { assistant: true },
			body: 'This line drags.'
		});
		if (!made.ok) throw new Error(made.reason);
		await addComment(db, {
			storyId,
			threadId: made.threadId,
			author: { userId: authorId },
			body: 'Why?'
		});
		return made.threadId;
	}

	it('holds the context and the tools to what the guest page shows', async () => {
		await seedWorld();
		const threadId = await assistantThread();
		const turn = await prepareReviewReply(db, {
			userId: authorId,
			storyId,
			threadId,
			assistantName: 'Muse'
		});
		expect(turn.toolScope).toEqual({ threadId, suggestionId: undefined, storyOnly: true });
		expect(turn.toolNames).toEqual(['list_scenes', 'get_scene', 'reply_in_thread']);
		const system = turn.messages.find((m) => m.role === 'system')?.content ?? '';
		expect(system).toContain('MIRA QUICK CARD');
		expect(system).not.toContain('WORLD DESCRIPTION');
		expect(system).not.toContain('MIRA FULL RECORD');
		expect(system).not.toContain('Zebulon');
		expect(system).not.toContain('UNMENTIONED MEMBER');
		expect(system).not.toContain('ONLY IN THE TRASH');
		expect(turn.messages.at(-1)?.content).toContain('Why?');
	});

	it('refuses a thread the Assistant did not open', async () => {
		const made = await createThread(db, {
			storyId,
			sceneId,
			anchor: null,
			author: { userId: authorId },
			body: 'My note.'
		});
		if (!made.ok) throw new Error(made.reason);
		await expect(
			prepareReviewReply(db, {
				userId: authorId,
				storyId,
				threadId: made.threadId,
				assistantName: 'Muse'
			})
		).rejects.toMatchObject({ status: 400 });
	});
});
