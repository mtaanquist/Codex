import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import { chapters, scenes, stories, universes, users } from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/auth';
import type { GatewayDeps } from '../../src/lib/server/llm/gateway';
import type { HttpRequest, Provider } from '../../src/lib/server/llm/providers/types';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

// Storing the account API key encrypts it with APP_SECRET, so set one before the
// config helper loads (CI does not set it globally; each file that needs it does).
process.env.APP_SECRET = process.env.APP_SECRET || 'llm-summaries-test-secret';

const { saveAccountLlmConfig, saveStoryLlmOverride } =
	await import('../../src/lib/server/llm/config');
const { summariseStory } = await import('../../src/lib/server/llm/summaries');
const { duplicateScene, mergeScenes, splitScene } =
	await import('../../src/lib/server/scene-split-merge');
const { setSceneStatus } = await import('../../src/lib/server/scene-status');
const { trashScene, restoreScene, deleteChapter } =
	await import('../../src/lib/server/scene-lifecycle');
const { saveDraft, restoreDraftScene, newStoryFromDraft } =
	await import('../../src/lib/server/story-drafts');

// A stub provider that returns a distinct summary on each call, so a refresh is
// visible as a changed value. The transport is never reached.
let calls = 0;
let prompts: string[] = [];
// Runs while the stub is answering, to land a change mid-call.
let duringCall: ((call: number) => Promise<void>) | null = null;
const stubProvider: Provider = {
	async *chatStream() {
		yield { type: 'done' };
	},
	async respond(req) {
		calls += 1;
		prompts.push(req.messages.map((m) => m.content ?? '').join('\n'));
		if (duringCall) await duringCall(calls);
		return { content: `SUMMARY-${calls}`, toolCalls: [] };
	},
	async listModels() {
		return [];
	}
};
const noHttp: HttpRequest = async () => {
	throw new Error('the injected provider should not call the transport');
};
const deps: GatewayDeps = { provider: stubProvider, http: noHttp };

let pool: pg.Pool;
let db: Database;
let ownerId: string;
let storyId: string;
let chapterId: string;
let sceneAId: string;
let sceneBId: string;
let sceneCId: string;

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	calls = 0;
	prompts = [];
	duringCall = null;
	await pool.query('truncate table scenes, chapters, stories, universes, users cascade');
	const [owner] = await db
		.insert(users)
		.values({ email: 'o@example.com', displayName: 'Olwen', passwordHash: 'x', role: 'user' })
		.returning({ id: users.id });
	ownerId = owner.id;
	await saveAccountLlmConfig(db, ownerId, {
		enabled: true,
		assistantName: '',
		persona: 'balanced',
		endpoint: 'https://api.example.com/v1',
		apiKey: 'sk',
		models: { chat: 'chat-model' },
		toolCallBudget: 8
	});

	const [universe] = await db
		.insert(universes)
		.values({ ownerId, name: 'Aldermoor' })
		.returning({ id: universes.id });
	const [story] = await db
		.insert(stories)
		.values({ universeId: universe.id, ownerId, title: 'The Tide Below' })
		.returning({ id: stories.id });
	storyId = story.id;
	const [chapter] = await db
		.insert(chapters)
		.values({ storyId, position: 1, title: 'Descent' })
		.returning({ id: chapters.id });
	chapterId = chapter.id;

	// A: has prose, no summary -> filled.
	const [a] = await db
		.insert(scenes)
		.values({
			storyId,
			chapterId,
			globalPosition: 1,
			title: 'The Gate',
			bodyMd: 'Alice met Bram by the gate at dawn.',
			status: 'draft'
		})
		.returning({ id: scenes.id });
	sceneAId = a.id;
	// B: has prose and a hand-written summary (no watermark) -> left alone.
	const [b] = await db
		.insert(scenes)
		.values({
			storyId,
			chapterId,
			globalPosition: 2,
			title: 'The Road',
			bodyMd: 'They walked south for days.',
			summaryMd: 'My own note.',
			status: 'draft'
		})
		.returning({ id: scenes.id });
	sceneBId = b.id;
	// C: empty prose -> nothing to summarise.
	const [c] = await db
		.insert(scenes)
		.values({ storyId, chapterId, globalPosition: 3, title: 'Stub', bodyMd: '', status: 'outline' })
		.returning({ id: scenes.id });
	sceneCId = c.id;
});

afterAll(async () => {
	await pool.end();
});

async function readScene(id: string) {
	const [row] = await db
		.select({
			summaryMd: scenes.summaryMd,
			summaryGeneratedAt: scenes.summaryGeneratedAt,
			updatedAt: scenes.updatedAt
		})
		.from(scenes)
		.where(eq(scenes.id, id));
	return row;
}

// updated_at has millisecond precision: an edit in the same millisecond as
// the summary would read as already summarised.
const nextMillisecond = () => new Promise((resolve) => setTimeout(resolve, 2));

describe('summariseStory', () => {
	it('fills blank summaries, leaves hand-written ones, skips empty scenes, and drafts the chapter', async () => {
		const before = await readScene(sceneAId);
		const result = await summariseStory(db, { userId: ownerId, storyId }, deps);

		expect(result.scenes).toBe(1); // only A
		expect(result.chapters).toBe(1);
		expect(result.failed).toBe(0);

		const a = await readScene(sceneAId);
		expect(a.summaryMd).toMatch(/^SUMMARY-/);
		expect(a.summaryGeneratedAt).not.toBeNull();
		// The summary write preserves updated_at, so it does not register as an edit.
		expect(a.updatedAt.getTime()).toBe(before.updatedAt.getTime());

		const b = await readScene(sceneBId);
		expect(b.summaryMd).toBe('My own note.'); // untouched
		expect(b.summaryGeneratedAt).toBeNull();

		const c = await readScene(sceneCId);
		expect(c.summaryMd).toBeNull();

		const [chapter] = await db
			.select({ summaryMd: chapters.summaryMd, summaryGeneratedAt: chapters.summaryGeneratedAt })
			.from(chapters)
			.where(eq(chapters.id, chapterId));
		expect(chapter.summaryMd).toMatch(/^SUMMARY-/);
		expect(chapter.summaryGeneratedAt).not.toBeNull();
	});

	it('is a no-op on a second run when nothing changed', async () => {
		await summariseStory(db, { userId: ownerId, storyId }, deps);
		const again = await summariseStory(db, { userId: ownerId, storyId }, deps);
		expect(again.scenes).toBe(0);
		expect(again.chapters).toBe(0);
	});

	it('refreshes an Assistant-generated summary after the scene body changes', async () => {
		await summariseStory(db, { userId: ownerId, storyId }, deps);
		const first = await readScene(sceneAId);

		// A writer edit bumps updated_at past the summary watermark.
		await nextMillisecond();
		await db
			.update(scenes)
			.set({ bodyMd: 'Alice met Bram, then ran.' })
			.where(eq(scenes.id, sceneAId));

		const result = await summariseStory(db, { userId: ownerId, storyId }, deps);
		expect(result.scenes).toBe(1);
		const second = await readScene(sceneAId);
		expect(second.summaryMd).not.toBe(first.summaryMd);
		expect(second.summaryGeneratedAt!.getTime()).toBeGreaterThan(
			first.summaryGeneratedAt!.getTime()
		);
	});

	it('keeps a summary the writer types while the model is writing one', async () => {
		duringCall = async (call) => {
			// Raw SQL so the writer's summary does not move updated_at either.
			if (call === 1) {
				await pool.query(`update scenes set summary_md = 'Mine.' where id = $1`, [sceneAId]);
			}
			if (call === 2) {
				await pool.query(`update chapters set summary_md = 'My chapter.' where id = $1`, [
					chapterId
				]);
			}
		};
		const result = await summariseStory(db, { userId: ownerId, storyId }, deps);
		expect(result).toMatchObject({ scenes: 0, chapters: 0 });
		const a = await readScene(sceneAId);
		expect(a.summaryMd).toBe('Mine.');
		expect(a.summaryGeneratedAt).toBeNull();
		const [chapter] = await db
			.select({ summaryMd: chapters.summaryMd, summaryGeneratedAt: chapters.summaryGeneratedAt })
			.from(chapters)
			.where(eq(chapters.id, chapterId));
		expect(chapter).toEqual({ summaryMd: 'My chapter.', summaryGeneratedAt: null });
	});

	it('does not roll back an edit made while the model is writing', async () => {
		let edited: Date | null = null;
		duringCall = async (call) => {
			if (call !== 1) return;
			const [row] = await db
				.update(scenes)
				.set({ bodyMd: 'Alice met Bram, then ran.' })
				.where(eq(scenes.id, sceneAId))
				.returning({ updatedAt: scenes.updatedAt });
			edited = row.updatedAt;
		};
		await summariseStory(db, { userId: ownerId, storyId }, deps);
		const a = await readScene(sceneAId);
		expect(a.updatedAt).toEqual(edited);
		// Summarised from the old text, so it is left for the next run.
		expect(a.summaryMd).toBeNull();

		duringCall = null;
		expect((await summariseStory(db, { userId: ownerId, storyId }, deps)).scenes).toBe(1);
		expect(prompts.at(-2)).toContain('then ran');
	});

	it('does not run for a story the user does not own', async () => {
		const [stranger] = await db
			.insert(users)
			.values({ email: 's@example.com', displayName: 'Sam', passwordHash: 'x', role: 'user' })
			.returning({ id: users.id });
		const result = await summariseStory(db, { userId: stranger.id, storyId }, deps);
		expect(result.scenes).toBe(0);
		expect(result.chapters).toBe(0);
	});

	it('drafts each chapter from its own live scenes, in story order', async () => {
		const [second] = await db
			.insert(chapters)
			.values({ storyId, position: 2, title: 'Harbour' })
			.returning({ id: chapters.id });
		await db.insert(scenes).values([
			{
				storyId,
				chapterId: second.id,
				globalPosition: 5,
				bodyMd: 'x',
				summaryMd: 'Harbour later.'
			},
			{
				storyId,
				chapterId: second.id,
				globalPosition: 4,
				bodyMd: 'x',
				summaryMd: 'Harbour first.'
			},
			{
				storyId,
				chapterId: second.id,
				globalPosition: 6,
				bodyMd: 'x',
				summaryMd: 'Harbour deleted.',
				deletedAt: new Date()
			}
		]);

		const result = await summariseStory(db, { userId: ownerId, storyId }, deps);
		expect(result.chapters).toBe(2);
		const harbour = prompts.find((p) => p.includes('"Harbour"'));
		expect(harbour).toContain('1. Harbour first.\n2. Harbour later.');
		expect(harbour).not.toContain('Harbour deleted.');
		expect(harbour).not.toContain('My own note.');
		const descent = prompts.find((p) => p.includes('"Descent"'));
		expect(descent).toContain('My own note.');
		expect(descent).not.toContain('Harbour');
	});
});

// A copy of a scene whose summary was current for its text is current too, so
// the next pass does not pay to summarise the same text again. A copy of a
// stale summary stays stale and is refreshed.
describe('copied summaries', () => {
	async function editSceneA() {
		await nextMillisecond();
		await db
			.update(scenes)
			.set({ bodyMd: 'Alice met Bram, then ran.' })
			.where(eq(scenes.id, sceneAId));
	}
	async function draftWithoutSceneA(): Promise<string> {
		const saved = await saveDraft(db, ownerId, storyId, { label: 'Before', note: '' });
		if (!saved.ok) throw new Error('save failed');
		await db.update(scenes).set({ deletedAt: new Date() }).where(eq(scenes.id, sceneAId));
		return saved.id;
	}
	async function storyRow() {
		const [row] = await db.select().from(stories).where(eq(stories.id, storyId));
		return row;
	}

	// Scene C gets prose, so the Assistant summarises a scene after A that the
	// position shift of a duplicate or split moves along.
	async function summariseWithSceneAfterA() {
		await db.update(scenes).set({ bodyMd: 'Bram rowed out alone.' }).where(eq(scenes.id, sceneCId));
		const first = await summariseStory(db, { userId: ownerId, storyId }, deps);
		expect(first.scenes).toBe(2);
	}

	it('skips a duplicated scene whose summary was current', async () => {
		await summariseWithSceneAfterA();
		const result = await duplicateScene(db, ownerId, sceneAId);
		if (!result.ok) throw new Error('duplicate failed');
		const again = await summariseStory(db, { userId: ownerId, storyId }, deps);
		// Neither the copy nor scene C, which only moved down one place.
		expect(again.scenes).toBe(0);
		const copy = await readScene(result.newSceneId);
		expect(copy.summaryGeneratedAt).not.toBeNull();
	});

	it('refreshes only the two halves of a split, not the scenes after it', async () => {
		await summariseWithSceneAfterA();
		await nextMillisecond();
		const split = await splitScene(db, ownerId, sceneAId, 'Alice met Bram'.length);
		if (!split.ok) throw new Error('split failed');
		const again = await summariseStory(db, { userId: ownerId, storyId }, deps);
		expect(again.scenes).toBe(2);
	});

	it('keeps a summary current through a status change', async () => {
		await summariseStory(db, { userId: ownerId, storyId }, deps);
		expect(await setSceneStatus(db, ownerId, sceneAId, 'revised')).toBe(true);
		const again = await summariseStory(db, { userId: ownerId, storyId }, deps);
		expect(again.scenes).toBe(0);
	});

	it('keeps a summary current through a chapter delete', async () => {
		await summariseStory(db, { userId: ownerId, storyId }, deps);
		expect(await deleteChapter(db, ownerId, chapterId)).toBe(true);
		const again = await summariseStory(db, { userId: ownerId, storyId }, deps);
		expect(again.scenes).toBe(0);
	});

	it('keeps a summary current through the trash and back', async () => {
		await summariseStory(db, { userId: ownerId, storyId }, deps);
		// Indexed, the way the mention job leaves it (raw SQL, as that job writes).
		await pool.query('update scenes set mentions_indexed_at = now() where id = $1', [sceneAId]);
		expect(await trashScene(db, ownerId, sceneAId)).toBe(true);
		expect(await restoreScene(db, ownerId, sceneAId)).toBe(true);
		const again = await summariseStory(db, { userId: ownerId, storyId }, deps);
		expect(again.scenes).toBe(0);
		// Its mentions went with the trash, so the restored scene is due a rebuild.
		const [row] = await db
			.select({ mentionsIndexedAt: scenes.mentionsIndexedAt })
			.from(scenes)
			.where(eq(scenes.id, sceneAId));
		expect(row.mentionsIndexedAt).toBeNull();
	});

	it('refreshes a duplicated scene whose summary was stale', async () => {
		await summariseStory(db, { userId: ownerId, storyId }, deps);
		await editSceneA();
		const result = await duplicateScene(db, ownerId, sceneAId);
		if (!result.ok) throw new Error('duplicate failed');
		const again = await summariseStory(db, { userId: ownerId, storyId }, deps);
		// The original and its copy.
		expect(again.scenes).toBe(2);
		expect((await readScene(result.newSceneId)).summaryMd).toMatch(/^SUMMARY-/);
	});

	it('skips a scene added back from a draft whose summary was current', async () => {
		await summariseStory(db, { userId: ownerId, storyId }, deps);
		const draftId = await draftWithoutSceneA();
		const restored = await restoreDraftScene(db, storyId, draftId, sceneAId);
		if (!restored.ok || !restored.created) throw new Error('add back failed');
		const again = await summariseStory(db, { userId: ownerId, storyId }, deps);
		expect(again.scenes).toBe(0);
	});

	it('refreshes a scene added back from a draft whose summary was stale', async () => {
		await summariseStory(db, { userId: ownerId, storyId }, deps);
		await editSceneA();
		const draftId = await draftWithoutSceneA();
		const restored = await restoreDraftScene(db, storyId, draftId, sceneAId);
		if (!restored.ok || !restored.created) throw new Error('add back failed');
		const again = await summariseStory(db, { userId: ownerId, storyId }, deps);
		expect(again.scenes).toBe(1);
	});

	it('skips the scenes and chapters of a new story made from a draft', async () => {
		await summariseStory(db, { userId: ownerId, storyId }, deps);
		const saved = await saveDraft(db, ownerId, storyId, { label: 'Before', note: '' });
		if (!saved.ok) throw new Error('save failed');
		const made = await newStoryFromDraft(db, ownerId, await storyRow(), saved.id, 'Copy');
		if (!made.ok) throw new Error('copy failed');
		const [copy] = await db.select().from(stories).where(eq(stories.slug, made.slug));
		const [copiedChapter] = await db
			.select({ summaryMd: chapters.summaryMd, summaryGeneratedAt: chapters.summaryGeneratedAt })
			.from(chapters)
			.where(eq(chapters.storyId, copy.id));
		// Still marked as the Assistant's, so a later change refreshes it.
		expect(copiedChapter.summaryMd).toMatch(/^SUMMARY-/);
		expect(copiedChapter.summaryGeneratedAt).not.toBeNull();
		const again = await summariseStory(db, { userId: ownerId, storyId: copy.id }, deps);
		expect(again.scenes).toBe(0);
		expect(again.chapters).toBe(0);
	});

	it('refreshes a chapter summary in a new story when it was stale in the draft', async () => {
		await summariseStory(db, { userId: ownerId, storyId }, deps);
		await nextMillisecond();
		await db.update(chapters).set({ title: 'Descent, renamed' }).where(eq(chapters.id, chapterId));
		const saved = await saveDraft(db, ownerId, storyId, { label: 'Before', note: '' });
		if (!saved.ok) throw new Error('save failed');
		const made = await newStoryFromDraft(db, ownerId, await storyRow(), saved.id, 'Copy');
		if (!made.ok) throw new Error('copy failed');
		const [copy] = await db.select().from(stories).where(eq(stories.slug, made.slug));
		const again = await summariseStory(db, { userId: ownerId, storyId: copy.id }, deps);
		expect(again.scenes).toBe(0);
		expect(again.chapters).toBe(1);
	});
});

async function readChapter(id: string) {
	const [row] = await db
		.select({
			summaryMd: chapters.summaryMd,
			summaryGeneratedAt: chapters.summaryGeneratedAt,
			updatedAt: chapters.updatedAt
		})
		.from(chapters)
		.where(eq(chapters.id, id));
	return row;
}

// The stamp is the updated_at the summary was built from, not a clock reading,
// so a server clock that disagrees with the database's does not make a fresh
// summary read as stale (or a stale one as fresh).
describe('summary stamp', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('stamps each summary with the updated_at it was built from', async () => {
		await summariseStory(db, { userId: ownerId, storyId }, deps);
		const a = await readScene(sceneAId);
		expect(a.summaryGeneratedAt!.getTime()).toBe(a.updatedAt.getTime());
		const chapter = await readChapter(chapterId);
		expect(chapter.summaryGeneratedAt!.getTime()).toBe(chapter.updatedAt.getTime());
	});

	it('stays current when the app clock runs behind the database', async () => {
		// The rows were inserted on the database clock; the app now reads an hour
		// earlier.
		vi.useFakeTimers({ toFake: ['Date'], now: Date.now() - 60 * 60 * 1000 });
		expect((await summariseStory(db, { userId: ownerId, storyId }, deps)).scenes).toBe(1);
		const again = await summariseStory(db, { userId: ownerId, storyId }, deps);
		expect(again).toMatchObject({ scenes: 0, chapters: 0 });
	});
});

// A scene's own summary is current through the trash and back, so the scene
// pass does not touch its chapter; the chapter is marked instead.
describe('chapter summary after a change of scenes', () => {
	beforeEach(async () => {
		await summariseStory(db, { userId: ownerId, storyId }, deps);
	});

	it('refreshes the chapter summary after a scene is trashed', async () => {
		expect(await trashScene(db, ownerId, sceneAId)).toBe(true);
		expect(await summariseStory(db, { userId: ownerId, storyId }, deps)).toMatchObject({
			scenes: 0,
			chapters: 1
		});
		expect(prompts.at(-1)).not.toContain('SUMMARY-1');
	});

	it('refreshes the chapter summary after a scene is restored', async () => {
		expect(await trashScene(db, ownerId, sceneAId)).toBe(true);
		await summariseStory(db, { userId: ownerId, storyId }, deps);
		expect(await restoreScene(db, ownerId, sceneAId)).toBe(true);
		expect(await summariseStory(db, { userId: ownerId, storyId }, deps)).toMatchObject({
			scenes: 0,
			chapters: 1
		});
		expect(prompts.at(-1)).toContain('SUMMARY-1');
	});

	it('refreshes the chapter summary after a merge', async () => {
		const merged = await mergeScenes(db, ownerId, storyId, [sceneBId, sceneCId]);
		expect(merged.ok).toBe(true);
		// B keeps the writer's own summary, so only the chapter is due.
		expect(await summariseStory(db, { userId: ownerId, storyId }, deps)).toMatchObject({
			scenes: 0,
			chapters: 1
		});
	});

	it('leaves a chapter summary the writer wrote alone', async () => {
		await pool.query(
			`update chapters set summary_md = 'Mine.', summary_generated_at = null where id = $1`,
			[chapterId]
		);
		expect(await trashScene(db, ownerId, sceneAId)).toBe(true);
		expect(await readChapter(chapterId)).toMatchObject({
			summaryMd: 'Mine.',
			summaryGeneratedAt: null
		});
	});

	it('refreshes the chapter on a later run when the run that refreshed its scene stopped first', async () => {
		await nextMillisecond();
		await db.update(scenes).set({ bodyMd: 'Alice ran.' }).where(eq(scenes.id, sceneAId));
		// The first run took calls 1 and 2. Call 3 writes the scene summary;
		// the chapter's, and any retry of it, fail.
		duringCall = async (call) => {
			if (call >= 4) throw new Error('unreachable');
		};
		expect(await summariseStory(db, { userId: ownerId, storyId }, deps)).toMatchObject({
			scenes: 1,
			chapters: 0,
			failed: 1
		});
		duringCall = null;
		expect(await summariseStory(db, { userId: ownerId, storyId }, deps)).toMatchObject({
			scenes: 0,
			chapters: 1
		});
	});

	it('does not mark a chapter current when a scene is restored while it is being written', async () => {
		expect(await trashScene(db, ownerId, sceneAId)).toBe(true);
		duringCall = async () => {
			await restoreScene(db, ownerId, sceneAId);
		};
		const result = await summariseStory(db, { userId: ownerId, storyId }, deps);
		expect(result).toMatchObject({ chapters: 0, changed: 1 });
		duringCall = null;
		expect((await summariseStory(db, { userId: ownerId, storyId }, deps)).chapters).toBe(1);
	});
});

describe('summary pass stops and reports', () => {
	it('counts a summary not saved because the row changed', async () => {
		duringCall = async (call) => {
			if (call === 1) {
				await db.update(scenes).set({ bodyMd: 'Changed.' }).where(eq(scenes.id, sceneAId));
			}
		};
		const result = await summariseStory(db, { userId: ownerId, storyId }, deps);
		expect(result).toMatchObject({ scenes: 0, failed: 0, changed: 1 });
	});

	it('stops at once when no model is chosen', async () => {
		await saveAccountLlmConfig(db, ownerId, {
			enabled: true,
			assistantName: '',
			persona: 'balanced',
			endpoint: 'https://api.example.com/v1',
			apiKey: 'sk',
			models: {},
			toolCallBudget: 8
		});
		const result = await summariseStory(db, { userId: ownerId, storyId }, deps);
		expect(result).toMatchObject({ scenes: 0, chapters: 0, failed: 0, noModel: true });
		expect(calls).toBe(0);
	});

	it('stops at once when the Assistant is turned off for the story', async () => {
		await saveStoryLlmOverride(db, storyId, { enabled: false });
		const result = await summariseStory(db, { userId: ownerId, storyId }, deps);
		expect(result).toMatchObject({ scenes: 0, chapters: 0, failed: 0, disabled: true });
		expect(calls).toBe(0);
	});
});
