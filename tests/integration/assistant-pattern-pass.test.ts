import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { asc, eq } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import {
	chapters,
	reviewComments,
	reviewSuggestions,
	reviewThreads,
	scenes,
	stories,
	universes,
	users
} from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

process.env.APP_SECRET = process.env.APP_SECRET || 'pattern-pass-test-secret';

import type {
	ChatMessage,
	Provider,
	ProviderResponse
} from '../../src/lib/server/llm/providers/types';

const { saveAccountLlmConfig, saveModelPricing } = await import('../../src/lib/server/llm/config');
const { reviewStoryScenes } = await import('../../src/lib/server/llm/scene-review');
const { loadReviewRun } = await import('../../src/lib/server/review-runs');

let pool: pg.Pool;
let db: Database;
let userId: string;
let storyId: string;
let sceneIds: string[];

const MODEL = 'review-model';
const asked = (messages: ChatMessage[]) =>
	messages
		.filter((m) => m.role === 'user')
		.map((m) => m.content)
		.join('\n');
const isSurvey = (m: ChatMessage[]) => asked(m).includes('survey stage of a chapter pattern pass');
const isApply = (m: ChatMessage[]) => asked(m).includes('apply stage of a pattern pass');

// Answers the survey with one pattern across the chapter's first two scenes,
// each apply turn with one suggest_edit for "sighed" in the scene it is shown
// (then plain text), and every scene review with no notes.
function patternProvider(
	onRequest?: (messages: ChatMessage[]) => void,
	opts: { editScene?: (shown: string) => string; failFor?: () => string } = {}
): {
	provider: Provider;
	seen: ChatMessage[][];
} {
	const seen: ChatMessage[][] = [];
	const provider: Provider = {
		async *chatStream() {
			yield { type: 'done' };
		},
		async respond(req): Promise<ProviderResponse> {
			seen.push(req.messages);
			onRequest?.(req.messages);
			const usage = { promptTokens: 1000, completionTokens: 0 };
			if (isSurvey(req.messages)) {
				return {
					content: JSON.stringify([
						{
							name: 'Sighing',
							description: 'Characters sigh to show every feeling.',
							sceneIds: [sceneIds[0], sceneIds[1], 'invented-id'],
							examples: ['Mara sighed.']
						}
					]),
					toolCalls: [],
					usage
				};
			}
			if (isApply(req.messages)) {
				if (req.messages.some((m) => m.role === 'tool')) {
					return { content: 'done', toolCalls: [], usage };
				}
				const shown = /\(id: ([0-9a-f-]{36})\)/.exec(asked(req.messages))![1];
				if (opts.failFor?.() === shown) throw new Error('Endpoint fell over.');
				const sceneId = opts.editScene?.(shown) ?? shown;
				return {
					content: '',
					toolCalls: [
						{
							id: `e-${sceneId}`,
							name: 'suggest_edit',
							arguments: JSON.stringify({ sceneId, original: 'sighed', replacement: 'paused' })
						}
					],
					usage
				};
			}
			return { content: 'no notes', toolCalls: [], usage };
		},
		async listModels() {
			return [];
		}
	};
	return { provider, seen };
}

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await pool.query(
		'truncate table assistant_review_runs, review_suggestions, review_comments, review_threads, scenes, chapters, stories, universes, users cascade'
	);
	const [user] = await db
		.insert(users)
		.values({ email: 'p@example.com', displayName: 'Pat', passwordHash: 'x', role: 'user' })
		.returning({ id: users.id });
	userId = user.id;
	const [universe] = await db
		.insert(universes)
		.values({ ownerId: userId, name: 'U' })
		.returning({ id: universes.id });
	const [story] = await db
		.insert(stories)
		.values({ universeId: universe.id, ownerId: userId, title: 'S' })
		.returning({ id: stories.id });
	storyId = story.id;
	const [chapter] = await db
		.insert(chapters)
		.values({ storyId, title: 'One', position: 1 })
		.returning({ id: chapters.id });
	sceneIds = [];
	const bodies = ['Mara sighed. The rain fell.', 'Tom sighed at the door.', 'A quiet morning.'];
	for (const [i, bodyMd] of bodies.entries()) {
		const [scene] = await db
			.insert(scenes)
			.values({
				storyId,
				chapterId: chapter.id,
				globalPosition: i + 1,
				title: `Scene ${i + 1}`,
				bodyMd,
				summaryMd: `Summary ${i + 1}.`
			})
			.returning({ id: scenes.id });
		sceneIds.push(scene.id);
	}
	await saveAccountLlmConfig(db, userId, {
		enabled: true,
		assistantName: '',
		persona: 'balanced',
		endpoint: 'https://api.example.com/v1',
		apiKey: 'sk',
		models: { reviewer: MODEL },
		toolCallBudget: 8
	});
});

afterAll(async () => {
	await pool.end();
});

describe('the chapter pattern pass', () => {
	it('is off unless asked for', async () => {
		const { provider, seen } = patternProvider();
		await reviewStoryScenes(db, { userId, storyId }, { provider });
		expect(seen.some(isSurvey)).toBe(false);
	});

	it('leaves one note per pattern, with edits in each scene linked to it', async () => {
		const { provider, seen } = patternProvider();
		const result = await reviewStoryScenes(
			db,
			{ userId, storyId, patterns: 'chapter' },
			{ provider }
		);

		expect(seen.filter(isSurvey)).toHaveLength(1);
		const threads = await db
			.select({ id: reviewThreads.id, sceneId: reviewThreads.sceneId, body: reviewComments.bodyMd })
			.from(reviewThreads)
			.innerJoin(reviewComments, eq(reviewComments.threadId, reviewThreads.id))
			.where(eq(reviewComments.assistant, true));
		const notes = threads.filter((t) => t.body.startsWith('Pattern note'));
		expect(notes).toHaveLength(1);
		expect(notes[0].sceneId).toBe(sceneIds[0]);
		expect(notes[0].body).toContain('Pattern note (Sighing)');
		expect(notes[0].body).toContain('Shows up in: Scene 1, Scene 2.');

		const edits = await db
			.select({
				sceneId: reviewSuggestions.sceneId,
				patternThreadId: reviewSuggestions.patternThreadId
			})
			.from(reviewSuggestions)
			.orderBy(asc(reviewSuggestions.createdAt));
		expect(edits.map((e) => e.sceneId)).toEqual([sceneIds[0], sceneIds[1]]);
		expect(edits.every((e) => e.patternThreadId === notes[0].id)).toBe(true);
		// The note and its two edits.
		expect(result.notes).toBe(3);
	});

	it('hands each scene review the pattern note as already said', async () => {
		const { provider, seen } = patternProvider();
		await reviewStoryScenes(db, { userId, storyId, patterns: 'chapter' }, { provider });
		const reviews = seen.filter((m) => !isSurvey(m) && !isApply(m));
		expect(reviews).toHaveLength(3);
		for (const messages of reviews) expect(asked(messages)).toContain('Pattern note (Sighing)');
	});

	it('does not report a pattern again while its note is open', async () => {
		const first = patternProvider();
		await reviewStoryScenes(
			db,
			{ userId, storyId, patterns: 'chapter' },
			{ provider: first.provider }
		);
		const second = patternProvider();
		await reviewStoryScenes(
			db,
			{ userId, storyId, patterns: 'chapter' },
			{ provider: second.provider }
		);
		expect(asked(second.seen.find(isSurvey)!)).toContain('already have open notes');
		const notes = await db
			.select({ body: reviewComments.bodyMd })
			.from(reviewComments)
			.where(eq(reviewComments.assistant, true));
		expect(notes.filter((n) => n.body.startsWith('Pattern note'))).toHaveLength(1);
	});

	it('resumes a stopped run without surveying again or repeating an edit', async () => {
		const controller = new AbortController();
		let applies = 0;
		const first = patternProvider((messages) => {
			if (isApply(messages) && !messages.some((m) => m.role === 'tool')) {
				applies += 1;
				if (applies === 2) controller.abort();
			}
		});
		const stopped = await reviewStoryScenes(
			db,
			{ userId, storyId, patterns: 'chapter', jobId: 'resume-1', signal: controller.signal },
			{ provider: first.provider }
		);
		expect(stopped.aborted).toBe(true);
		const saved = await loadReviewRun(db, 'resume-1');
		expect(saved?.patterns?.[0].surveyed).toBe(true);

		const second = patternProvider();
		await reviewStoryScenes(
			db,
			{ userId, storyId, patterns: 'chapter', jobId: 'resume-1' },
			{ provider: second.provider }
		);
		expect(second.seen.some(isSurvey)).toBe(false);
		const edits = await db.select({ sceneId: reviewSuggestions.sceneId }).from(reviewSuggestions);
		expect(edits.map((e) => e.sceneId).sort()).toEqual([sceneIds[0], sceneIds[1]].sort());
		const notes = await db
			.select({ body: reviewComments.bodyMd })
			.from(reviewComments)
			.where(eq(reviewComments.assistant, true));
		expect(notes.filter((n) => n.body.startsWith('Pattern note'))).toHaveLength(1);
	});

	it('stops at the spend cap before the edits', async () => {
		await saveAccountLlmConfig(db, userId, {
			enabled: true,
			assistantName: '',
			persona: 'balanced',
			endpoint: 'https://api.example.com/v1',
			apiKey: 'sk',
			models: { reviewer: MODEL },
			toolCallBudget: 8,
			spendCapUsd: 0.5
		});
		await saveModelPricing(db, userId, { [MODEL]: { prompt: 0.001, completion: 0 } });
		const { provider, seen } = patternProvider();
		const result = await reviewStoryScenes(
			db,
			{ userId, storyId, patterns: 'chapter' },
			{ provider }
		);
		expect(result.capped).toBe(true);
		expect(seen).toHaveLength(1);
		expect(isSurvey(seen[0])).toBe(true);
	});

	it('continues a capped run under a new job without surveying again', async () => {
		const capTo = async (spendCapUsd: number) => {
			await saveAccountLlmConfig(db, userId, {
				enabled: true,
				assistantName: '',
				persona: 'balanced',
				endpoint: 'https://api.example.com/v1',
				apiKey: 'sk',
				models: { reviewer: MODEL },
				toolCallBudget: 8,
				spendCapUsd
			});
			await saveModelPricing(db, userId, { [MODEL]: { prompt: 0.001, completion: 0 } });
		};
		await capTo(0.5);
		const first = patternProvider();
		const capped = await reviewStoryScenes(
			db,
			{ userId, storyId, patterns: 'chapter', jobId: 'cap-1' },
			{ provider: first.provider }
		);
		expect(capped.capped).toBe(true);

		await capTo(100);
		const second = patternProvider();
		await reviewStoryScenes(
			db,
			{ userId, storyId, patterns: 'chapter', jobId: 'cap-2' },
			{ provider: second.provider }
		);
		expect(second.seen.some(isSurvey)).toBe(false);
		const edits = await db.select({ sceneId: reviewSuggestions.sceneId }).from(reviewSuggestions);
		expect(edits.map((e) => e.sceneId).sort()).toEqual([sceneIds[0], sceneIds[1]].sort());
		const notes = await db
			.select({ body: reviewComments.bodyMd })
			.from(reviewComments)
			.where(eq(reviewComments.assistant, true));
		expect(notes.filter((n) => n.body.startsWith('Pattern note'))).toHaveLength(1);
	});

	it('records a failed fix and carries on with the next scene and the scene reviews', async () => {
		const { provider, seen } = patternProvider(undefined, { failFor: () => sceneIds[0] });
		const result = await reviewStoryScenes(
			db,
			{ userId, storyId, patterns: 'chapter' },
			{ provider }
		);
		expect(result.failures.some((f) => f.sceneId === sceneIds[0])).toBe(true);
		const edits = await db.select({ sceneId: reviewSuggestions.sceneId }).from(reviewSuggestions);
		expect(edits.map((e) => e.sceneId)).toEqual([sceneIds[1]]);
		const reviews = seen.filter((m) => !isSurvey(m) && !isApply(m));
		for (const messages of reviews) expect(asked(messages)).toContain('Pattern note (Sighing)');
	});

	it('keeps each fix in the scene it was asked about', async () => {
		const { provider } = patternProvider(undefined, { editScene: () => sceneIds[1] });
		await reviewStoryScenes(db, { userId, storyId, patterns: 'chapter' }, { provider });
		const edits = await db.select({ sceneId: reviewSuggestions.sceneId }).from(reviewSuggestions);
		// The apply turn for scene 1 aimed at scene 2 and was refused.
		expect(edits.map((e) => e.sceneId)).toEqual([sceneIds[1]]);
	});
});
