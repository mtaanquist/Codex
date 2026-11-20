import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import {
	chapters,
	characters,
	entityMentions,
	scenes,
	stories,
	universes,
	users
} from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/auth';
import type { GatewayDeps } from '../../src/lib/server/llm/gateway';
import type { HttpRequest, Provider } from '../../src/lib/server/llm/providers/types';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

// Storing the account API key encrypts it with APP_SECRET.
process.env.APP_SECRET = process.env.APP_SECRET || 'entity-enrich-text-test-secret';

const { listPendingForEntity } = await import('../../src/lib/server/entity-suggestions');
const { enrichEntityFromText, estimateEntityEnrich } =
	await import('../../src/lib/server/llm/enrich');
const { ReplyCutOffError } = await import('../../src/lib/server/llm/gateway');
const { saveAccountLlmConfig, saveModelContext, saveModelPricing, saveStoryLlmOverride } =
	await import('../../src/lib/server/llm/config');

// Every prompt the stub was sent, and the reply (or failure) for each call in
// turn; the last entry repeats.
let prompts: string[] = [];
let replies: (string | Error)[] = [];
// The 1-based calls whose reply is reported as cut off at the reply limit.
let cutOffCalls: number[] = [];
const stubProvider: Provider = {
	async *chatStream() {
		yield { type: 'done' };
	},
	async respond(req) {
		prompts.push(req.messages.map((m) => m.content).join('\n'));
		const reply = replies[Math.min(prompts.length, replies.length) - 1];
		if (reply instanceof Error) throw reply;
		return {
			content: reply,
			toolCalls: [],
			finishReason: cutOffCalls.includes(prompts.length) ? ('length' as const) : undefined
		};
	},
	async listModels() {
		return [];
	}
};
const noHttp: HttpRequest = async () => {
	throw new Error('the injected provider should not call the transport');
};
// No waiting between the gateway's retries of a failed request.
const deps: GatewayDeps = { provider: stubProvider, http: noHttp, sleep: async () => {} };

let pool: pg.Pool;
let db: Database;
let ownerId: string;
let strangerId: string;
let universeId: string;
let storyId: string;
let bram: string;

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	prompts = [];
	cutOffCalls = [];
	replies = ['{"aliases":["The Grey"],"details":[{"label":"Eyes","value":"grey"}],"summary":null}'];
	await pool.query(
		'truncate table entity_suggestions, entity_mentions, revisions, characters, stories, universes, users cascade'
	);
	const [owner] = await db
		.insert(users)
		.values({ email: 'o@example.com', displayName: 'Olwen', passwordHash: 'x', role: 'user' })
		.returning({ id: users.id });
	ownerId = owner.id;
	const [stranger] = await db
		.insert(users)
		.values({ email: 's@example.com', displayName: 'Sam', passwordHash: 'x', role: 'user' })
		.returning({ id: users.id });
	strangerId = stranger.id;
	const [universe] = await db
		.insert(universes)
		.values({ ownerId, name: 'Aldermoor' })
		.returning({ id: universes.id });
	universeId = universe.id;
	storyId = await makeStory('The Tide Below');
	const [c] = await db
		.insert(characters)
		.values({ universeId, ownerId, name: 'Bram' })
		.returning({ id: characters.id });
	bram = c.id;
	await saveAccountLlmConfig(db, ownerId, {
		enabled: true,
		assistantName: '',
		persona: 'balanced',
		endpoint: 'https://api.example.com/v1',
		apiKey: 'sk',
		models: { chat: 'chat-model' },
		toolCallBudget: 8
	});
});

afterAll(async () => {
	await pool.end();
});

async function makeStory(title: string) {
	const [story] = await db
		.insert(stories)
		.values({ universeId, ownerId, title })
		.returning({ id: stories.id });
	return story.id;
}

// Scenes in reading order, one per body; a body that names Bram is indexed as
// a mention of him.
async function writeScenes(inStoryId: string, bodies: string[]) {
	const [chapter] = await db
		.insert(chapters)
		.values({ storyId: inStoryId, position: 1, title: 'One' })
		.returning({ id: chapters.id });
	const ids: string[] = [];
	for (const [i, bodyMd] of bodies.entries()) {
		const [scene] = await db
			.insert(scenes)
			.values({
				storyId: inStoryId,
				chapterId: chapter.id,
				globalPosition: i + 1,
				title: `Scene ${i + 1}`,
				bodyMd
			})
			.returning({ id: scenes.id });
		ids.push(scene.id);
		const at = bodyMd.indexOf('Bram');
		if (at !== -1) {
			await db.insert(entityMentions).values({
				sourceType: 'scene',
				sourceId: scene.id,
				targetType: 'character',
				targetId: bram,
				position: at,
				surroundingText: bodyMd.slice(Math.max(0, at - 40), at + 40)
			});
		}
	}
	return ids;
}

const read = (
	mode: 'scenes' | 'book',
	scope: { storyId: string } | { universeId: string } = { storyId }
) => enrichEntityFromText(db, { userId: ownerId, scope, entityId: bram, mode }, deps);

describe('reading the scenes around an entity', () => {
	it('sends the mentioning scene with the one before and after, in order, and nothing farther', async () => {
		await writeScenes(storyId, [
			'FAR-BEFORE the tide turned.',
			'JUST-BEFORE the old man with the grey eyes watched the gulls.',
			'Bram counted the boats.',
			'JUST-AFTER the harbourmaster went home.',
			'FAR-AFTER the storm came.'
		]);
		const result = await read('scenes');
		expect(prompts).toHaveLength(1);
		const prompt = prompts[0];
		expect(prompt).not.toContain('FAR-BEFORE');
		expect(prompt).not.toContain('FAR-AFTER');
		expect(prompt.indexOf('JUST-BEFORE')).toBeLessThan(prompt.indexOf('Bram counted'));
		expect(prompt.indexOf('Bram counted')).toBeLessThan(prompt.indexOf('JUST-AFTER'));
		expect(prompt.indexOf('JUST-AFTER')).toBeLessThan(prompt.indexOf('Enrich the character'));
		expect(result.scenes).toBe(3);
		expect(result.requests).toBe(1);
		expect(result.suggestions.map((s) => s.field).sort()).toEqual(['alias', 'detail']);
		expect(await listPendingForEntity(db, ownerId, 'character', bram)).toHaveLength(2);
	});

	it('asks nothing when no scene mentions the entity', async () => {
		await writeScenes(storyId, ['The tide turned.', 'The storm came.']);
		const result = await read('scenes');
		expect(prompts).toHaveLength(0);
		expect(result).toEqual({ suggestions: [], scenes: 0, requests: 0 });
	});

	it('reads every story from the universe, without a neighbour across stories, and skips a muted or trashed one', async () => {
		const road = await makeStory('The Salt Road');
		const muted = await makeStory('The Quiet Book');
		const trashed = await makeStory('The Lost Book');
		await writeScenes(storyId, ['TIDE-OTHER scene.', 'Bram at the harbour.']);
		await writeScenes(road, ['Bram on the road.', 'ROAD-AFTER scene.']);
		await writeScenes(muted, ['Bram in the MUTED-BOOK.']);
		await writeScenes(trashed, ['Bram in the TRASHED-BOOK.']);
		await saveStoryLlmOverride(db, muted, { enabled: false });
		await db.update(stories).set({ deletedAt: new Date() }).where(eq(stories.id, trashed));

		const result = await read('scenes', { universeId });
		const prompt = prompts[0];
		for (const kept of ['TIDE-OTHER', 'Bram at the harbour', 'Bram on the road', 'ROAD-AFTER']) {
			expect(prompt).toContain(kept);
		}
		expect(prompt).toContain('# The Tide Below');
		expect(prompt).toContain('# The Salt Road');
		expect(prompt).not.toContain('MUTED-BOOK');
		expect(prompt).not.toContain('TRASHED-BOOK');
		expect(result.scenes).toBe(4);

		prompts = [];
		await read('scenes');
		expect(prompts[0]).not.toContain('Bram on the road');
	});

	it('leaves out a trashed scene, as a mention and as a neighbour', async () => {
		const ids = await writeScenes(storyId, [
			'TRASHED-NEIGHBOUR scene.',
			'Bram counted the boats.',
			'Bram in a TRASHED-MENTION scene.'
		]);
		for (const id of [ids[0], ids[2]]) {
			await db.update(scenes).set({ deletedAt: new Date() }).where(eq(scenes.id, id));
		}
		const result = await read('scenes');
		expect(prompts[0]).not.toContain('TRASHED-NEIGHBOUR');
		expect(prompts[0]).not.toContain('TRASHED-MENTION');
		expect(result.scenes).toBe(1);
	});

	it("reads nothing of another writer's entity or story", async () => {
		await writeScenes(storyId, ['Bram counted the boats.']);
		const result = await enrichEntityFromText(
			db,
			{ userId: strangerId, scope: { storyId }, entityId: bram, mode: 'scenes' },
			deps
		);
		expect(prompts).toHaveLength(0);
		expect(result.suggestions).toEqual([]);
	});

	it('stages nothing for an entity outside the given universe', async () => {
		await writeScenes(storyId, ['Bram counted the boats.']);
		const [elsewhere] = await db
			.insert(universes)
			.values({ ownerId, name: 'Elsewhere' })
			.returning({ id: universes.id });
		const result = await read('scenes', { universeId: elsewhere.id });
		expect(prompts).toHaveLength(0);
		expect(result.suggestions).toEqual([]);
	});
});

describe('an entity and a story from different universes', () => {
	it('reads and counts nothing, in either mode', async () => {
		const [elsewhere] = await db
			.insert(universes)
			.values({ ownerId, name: 'Elsewhere' })
			.returning({ id: universes.id });
		const [other] = await db
			.insert(stories)
			.values({ universeId: elsewhere.id, ownerId, title: 'Another World' })
			.returning({ id: stories.id });
		await writeScenes(other.id, ['Bram is named here too.', 'A second scene.']);
		for (const mode of ['scenes', 'book'] as const) {
			const result = await read(mode, { storyId: other.id });
			expect(result).toEqual({ suggestions: [], scenes: 0, requests: 0, missing: true });
		}
		expect(prompts).toHaveLength(0);
		expect(
			await estimateEntityEnrich(db, {
				userId: ownerId,
				scope: { storyId: other.id },
				entityId: bram
			})
		).toBeNull();
		expect(
			await estimateEntityEnrich(db, {
				userId: ownerId,
				scope: { universeId: elsewhere.id },
				entityId: bram
			})
		).toBeNull();
	});
});

describe('reading the whole book', () => {
	it('sends every scene of the story, mentioned or not', async () => {
		await writeScenes(storyId, ['FIRST the old man watched.', 'SECOND the storm came.']);
		const result = await read('book');
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain('FIRST');
		expect(prompts[0]).toContain('SECOND');
		expect(result.scenes).toBe(2);
	});

	it('reads nothing of a story the Assistant is muted on, or one in the trash', async () => {
		await writeScenes(storyId, ['FIRST the old man watched.', 'Bram counted the boats.']);
		await saveStoryLlmOverride(db, storyId, { enabled: false });
		expect((await read('book')).scenes).toBe(0);
		expect((await read('scenes')).scenes).toBe(0);
		await saveStoryLlmOverride(db, storyId, { enabled: null });
		expect((await read('book')).scenes).toBe(2);

		prompts = [];
		await db.update(stories).set({ deletedAt: new Date() }).where(eq(stories.id, storyId));
		expect((await read('book')).scenes).toBe(0);
		expect(prompts).toHaveLength(0);
	});

	it('is not read from a universe', async () => {
		await writeScenes(storyId, ['Bram counted the boats.']);
		const result = await read('book', { universeId });
		expect(prompts).toHaveLength(0);
		expect(result.scenes).toBe(0);
	});
});

describe('a text too long for one request', () => {
	// With no known window a request carries about 24,000 characters, so two
	// of these scenes fit one request and the third starts another.
	const long = (tag: string) => `Bram ${tag}. ${'word '.repeat(1800)}`;

	it('is read in parts, each told what the earlier ones found, and staged once', async () => {
		await writeScenes(storyId, [long('ONE'), long('TWO'), long('THREE')]);
		replies = [
			'{"aliases":["The Grey"],"details":[{"label":"Eyes","value":"grey"}],"summary":"Too early."}',
			'{"aliases":["the grey","Old Bram"],"details":[{"label":"eyes","value":"blue"}],"summary":"A harbourmaster."}'
		];
		const result = await read('scenes');
		expect(prompts).toHaveLength(2);
		expect(result.requests).toBe(2);
		expect(result.partial).toBeUndefined();

		expect(prompts[0]).toContain('part 1 of 2');
		expect(prompts[0]).toContain('Bram ONE');
		expect(prompts[0]).not.toContain('Bram THREE');
		expect(prompts[1]).toContain('part 2 of 2');
		expect(prompts[1]).toContain('Bram THREE');
		expect(prompts[1]).toContain('Known aliases: The Grey.');
		expect(prompts[1]).toContain('Known detail - Eyes: grey');
		// The summary is asked for once, at the end.
		expect(prompts[0]).toContain('do not propose a summary');
		expect(prompts[1]).not.toContain('do not propose a summary');

		const staged = result.suggestions.map((s) => `${s.field}:${s.label ?? ''}:${s.value}`).sort();
		expect(staged).toEqual([
			'alias::Old Bram',
			'alias::The Grey',
			'detail:Eyes:grey',
			'summary::A harbourmaster.'
		]);
		expect(await listPendingForEntity(db, ownerId, 'character', bram)).toHaveLength(4);
	});

	it('keeps what the earlier parts found when a later part fails, and says so', async () => {
		await writeScenes(storyId, [long('ONE'), long('TWO'), long('THREE')]);
		replies = ['{"aliases":["The Grey"],"details":[],"summary":null}', new Error('endpoint down')];
		const result = await read('scenes');
		expect(result.partial).toBe(true);
		expect(result.suggestions.map((s) => s.value)).toEqual(['The Grey']);
		expect(await listPendingForEntity(db, ownerId, 'character', bram)).toHaveLength(1);
	});

	it('has staged the first part by the time the second is asked for', async () => {
		await writeScenes(storyId, [long('ONE'), long('TWO'), long('THREE')]);
		let pendingAtSecondCall = -1;
		const watching: GatewayDeps = {
			...deps,
			provider: {
				...stubProvider,
				async respond(...args) {
					if (prompts.length === 1) {
						pendingAtSecondCall = (await listPendingForEntity(db, ownerId, 'character', bram))
							.length;
					}
					return stubProvider.respond(...args);
				}
			}
		};
		await enrichEntityFromText(
			db,
			{ userId: ownerId, scope: { storyId }, entityId: bram, mode: 'scenes' },
			watching
		);
		expect(pendingAtSecondCall).toBe(2);
	});

	it('says how to fix it when a later part is cut off at the reply limit', async () => {
		await writeScenes(storyId, [long('ONE'), long('TWO'), long('THREE')]);
		cutOffCalls = [2];
		const result = await read('scenes');
		expect(result.partial).toBe(true);
		expect(result.partialNote).toContain('Longest reply');
		expect(result.suggestions.length).toBeGreaterThan(0);
	});

	it('fails with the reply limit advice when the first part is cut off', async () => {
		await writeScenes(storyId, [long('ONE')]);
		cutOffCalls = [1];
		await expect(read('scenes')).rejects.toBeInstanceOf(ReplyCutOffError);
		expect(await listPendingForEntity(db, ownerId, 'character', bram)).toHaveLength(0);
	});

	it('reads a text of any length, and stops between parts at the spend cap', async () => {
		// About 5,000 tokens each, so one scene per request.
		const huge = (i: number) => `Bram ${i}. ${'word '.repeat(4000)}`;
		await writeScenes(
			storyId,
			Array.from({ length: 9 }, (_, i) => huge(i))
		);
		const whole = await read('scenes');
		expect(whole.requests).toBe(9);
		expect(whole.partial).toBeUndefined();

		prompts = [];
		let calls = 0;
		const meter = {
			// Reached once two requests have been paid for.
			get capReached() {
				return calls >= 2;
			},
			record() {
				calls += 1;
			},
			async flush() {},
			spentUsd: 1.5,
			spentEstimated: false
		};
		const result = await enrichEntityFromText(
			db,
			{
				userId: ownerId,
				scope: { storyId },
				entityId: bram,
				mode: 'scenes',
				meter: meter as never
			},
			deps
		);
		expect(result.capped).toBe(true);
		expect(result.requests).toBe(2);
		expect(prompts).toHaveLength(2);
	});

	it('fails outright when the first part fails, staging nothing', async () => {
		await writeScenes(storyId, [long('ONE'), long('TWO'), long('THREE')]);
		replies = [new Error('endpoint down')];
		await expect(read('scenes')).rejects.toThrow();
		expect(await listPendingForEntity(db, ownerId, 'character', bram)).toHaveLength(0);
	});

	it('stops between parts when the request is stopped, keeping what was found', async () => {
		await writeScenes(storyId, [long('ONE'), long('TWO'), long('THREE')]);
		const stop = new AbortController();
		const stopping: GatewayDeps = {
			...deps,
			provider: {
				...stubProvider,
				async respond(...args) {
					const reply = await stubProvider.respond(...args);
					stop.abort();
					return reply;
				}
			}
		};
		const result = await enrichEntityFromText(
			db,
			{ userId: ownerId, scope: { storyId }, entityId: bram, mode: 'scenes', signal: stop.signal },
			stopping
		);
		expect(prompts).toHaveLength(1);
		expect(result.partial).toBe(true);
		expect(result.suggestions.length).toBeGreaterThan(0);
	});
});

describe('the estimate', () => {
	const estimate = (scope: { storyId: string } | { universeId: string } = { storyId }) =>
		estimateEntityEnrich(db, { userId: ownerId, scope, entityId: bram });

	it('counts the scenes and requests the read then makes, and sends nothing', async () => {
		const long = (tag: string) => `Bram ${tag}. ${'word '.repeat(3000)}`;
		await writeScenes(storyId, [long('ONE'), long('TWO'), long('THREE'), 'After.', 'Far after.']);
		const counted = await estimate();
		expect(prompts).toHaveLength(0);
		const result = await read('scenes');
		expect(counted!.scenes.scenes).toBe(result.scenes);
		expect(counted!.scenes.requests).toBe(result.requests);
		// Within a tenth of what was sent, at four characters a token.
		const sent = prompts.reduce((sum, prompt) => sum + prompt.length / 4, 0);
		expect(Math.abs(counted!.scenes.estTokens - sent) / sent).toBeLessThan(0.1);
		expect(counted!.confirm).toBe(true);
	});

	it('does not ask to confirm a small read, and shows no cost without a price', async () => {
		await writeScenes(storyId, ['Before.', 'Bram counted the boats.', 'After.']);
		const counted = await estimate();
		expect(counted!.confirm).toBe(false);
		expect(counted!.scenes.scenes).toBe(3);
		expect(counted!.scenes.estCostUsd).toBeUndefined();
	});

	it('prices the read when the model has a price', async () => {
		await writeScenes(storyId, ['Bram counted the boats.']);
		await saveModelPricing(db, ownerId, {
			'chat-model': { prompt: 0.000001, completion: 0.000002 }
		});
		const counted = await estimate();
		expect(counted!.scenes.estCostUsd).toBeCloseTo(
			counted!.scenes.estTokens * 0.000001 + 1500 * 0.000002,
			8
		);
	});

	it('offers the whole book only from a story, with a known window it fits, when it adds scenes', async () => {
		await writeScenes(storyId, [
			'Bram counted the boats.',
			'After.',
			'Far after.',
			'word '.repeat(4000)
		]);
		// No window known: not offered.
		expect((await estimate())!.book).toBeUndefined();

		await saveModelContext(db, ownerId, { 'chat-model': 200_000 });
		const fits = await estimate();
		expect(fits!.book?.scenes).toBe(4);
		expect(fits!.book?.requests).toBe(1);
		expect((await estimate({ universeId }))!.book).toBeUndefined();

		// Too long for one request on a small window.
		await saveModelContext(db, ownerId, { 'chat-model': 8000 });
		expect((await estimate())!.book).toBeUndefined();
	});

	it('does not offer the whole book when the scenes read already covers it', async () => {
		await writeScenes(storyId, ['Before.', 'Bram counted the boats.', 'After.']);
		await saveModelContext(db, ownerId, { 'chat-model': 200_000 });
		expect((await estimate())!.book).toBeUndefined();
	});

	it("is null for another writer's entity", async () => {
		await writeScenes(storyId, ['Bram counted the boats.']);
		expect(
			await estimateEntityEnrich(db, { userId: strangerId, scope: { storyId }, entityId: bram })
		).toBeNull();
	});
});
