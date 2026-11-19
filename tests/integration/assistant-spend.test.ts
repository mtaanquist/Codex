import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { asc, eq, sql } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import { assistantUsage, scenes, stories, universes, users } from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

process.env.APP_SECRET = process.env.APP_SECRET || 'assistant-spend-test-secret';

import type { ChatMessage, Provider } from '../../src/lib/server/llm/providers/types';
import type { ReviewCategory } from '../../src/lib/review-shape';

const { accountLlmView, saveAccountLlmConfig, saveModelPricing } =
	await import('../../src/lib/server/llm/config');
const { reviewStoryScenes, SUMMARIES_CAPPED_MESSAGE } =
	await import('../../src/lib/server/llm/scene-review');
const { summariseStory } = await import('../../src/lib/server/llm/summaries');
const { CAP_NOT_APPLIED_MESSAGE } = await import('../../src/lib/server/llm/spend');
const { estimateStoryReview } = await import('../../src/lib/server/llm/estimate');
const { emptyReviewRun, loadReviewRun, saveReviewRun } =
	await import('../../src/lib/server/review-runs');

let pool: pg.Pool;
let db: Database;
let userId: string;
let universeId: string;

const MODEL = 'review-model';
// A round number so the arithmetic in the cap tests is obvious: every request
// reports 1000 prompt tokens, priced at $0.001 each, so one scene costs $1.
const PROMPT_TOKENS = 1000;
const PRICE_PER_TOKEN = 0.001;

function provider(): { provider: Provider; seen: ChatMessage[][] } {
	const seen: ChatMessage[][] = [];
	return {
		seen,
		provider: {
			async *chatStream() {
				yield { type: 'done' };
			},
			async respond(req) {
				seen.push(req.messages);
				return {
					content: 'no notes',
					toolCalls: [],
					usage: { promptTokens: PROMPT_TOKENS, completionTokens: 0 }
				};
			},
			async listModels() {
				return [];
			}
		}
	};
}

// A provider that cancels the run once it has answered, so the run stops after
// the scene it was reviewing.
function cancelledAfterOneScene(controller: AbortController) {
	const stub = provider();
	const respond = stub.provider.respond.bind(stub.provider);
	stub.provider.respond = async (...args) => {
		const reply = await respond(...args);
		controller.abort();
		return reply;
	};
	return stub;
}

async function configure(opts: { spendCapUsd?: number | null; spendWarnUsd?: number | null } = {}) {
	await saveAccountLlmConfig(db, userId, {
		enabled: true,
		assistantName: '',
		persona: 'balanced',
		endpoint: 'https://api.example.com/v1',
		apiKey: 'sk',
		models: { reviewer: MODEL },
		toolCallBudget: 8,
		...opts
	});
}

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await pool.query(
		'truncate table assistant_review_runs, assistant_usage, review_suggestions, review_comments, review_threads, scenes, chapters, stories, universes, users cascade'
	);
	const [user] = await db
		.insert(users)
		.values({ email: 's@example.com', displayName: 'Sam', passwordHash: 'x', role: 'user' })
		.returning({ id: users.id });
	userId = user.id;
	const [universe] = await db
		.insert(universes)
		.values({ ownerId: userId, name: 'U' })
		.returning({ id: universes.id });
	universeId = universe.id;
	await configure();
});

afterAll(async () => {
	await pool.end();
});

// Summaries carry no generated-at watermark, so nothing is stale and the run
// goes straight to the scene passes.
async function seedStory(sceneCount: number): Promise<string> {
	const [story] = await db
		.insert(stories)
		.values({ universeId, ownerId: userId, title: 'S' })
		.returning({ id: stories.id });
	for (let i = 0; i < sceneCount; i++) {
		await db.insert(scenes).values({
			storyId: story.id,
			globalPosition: i + 1,
			title: `Scene ${i + 1}`,
			bodyMd: `Body of scene ${i + 1}.`,
			summaryMd: `Summary of scene ${i + 1}.`
		});
	}
	return story.id;
}

const priceModel = () =>
	saveModelPricing(db, userId, { [MODEL]: { prompt: PRICE_PER_TOKEN, completion: 0 } });

const countRows = async (table: string) =>
	Number((await pool.query(`select count(*)::int as n from ${table}`)).rows[0].n);

describe('pre-flight review estimate (#548)', () => {
	it('reports a scene count and a token figure', async () => {
		const storyId = await seedStory(3);
		const estimate = await estimateStoryReview(db, { userId, storyId });

		expect(estimate.scenes).toBe(3);
		expect(estimate.estTokens).toBeGreaterThan(0);
		expect(estimate.model).toBe(MODEL);
	});

	it('omits the cost when the model has no known price', async () => {
		const storyId = await seedStory(2);
		const estimate = await estimateStoryReview(db, { userId, storyId });

		expect(estimate.estTokens).toBeGreaterThan(0);
		expect(estimate.estCostUsd).toBeUndefined();
		expect(estimate.capEnforceable).toBe(false);
	});

	it('reports a cost only when the model has a price', async () => {
		const storyId = await seedStory(2);
		await priceModel();
		const estimate = await estimateStoryReview(db, { userId, storyId });

		expect(estimate.estCostUsd).toBeCloseTo(estimate.estTokens * PRICE_PER_TOKEN, 6);
		expect(estimate.capEnforceable).toBe(true);
	});

	it('says a set cap cannot be applied to a model with no price', async () => {
		const storyId = await seedStory(2);
		await configure({ spendCapUsd: 5 });
		const estimate = await estimateStoryReview(db, { userId, storyId });

		expect(estimate.capUsd).toBe(5);
		expect(estimate.capEnforceable).toBe(false);
		expect(estimate.estCostUsd).toBeUndefined();
	});

	it('falls back to the static multiplier without enough history', async () => {
		const storyId = await seedStory(1);
		for (let i = 0; i < 3; i++) {
			await db
				.insert(assistantUsage)
				.values({ userId, role: 'reviewer', model: MODEL, promptTokens: 50_000 });
		}
		const estimate = await estimateStoryReview(db, { userId, storyId });

		expect(estimate.basis).toBe('static');
		expect(estimate.multiplier).toBe(2.5);
	});

	it('scales by the account history once there is enough of it', async () => {
		const storyId = await seedStory(1);
		const bare = await estimateStoryReview(db, { userId, storyId });
		// Big enough per-request prompts that the measured ratio lands on the
		// ceiling, which is a value the static basis never produces.
		for (let i = 0; i < 6; i++) {
			await db
				.insert(assistantUsage)
				.values({ userId, role: 'reviewer', model: MODEL, promptTokens: 5_000_000 });
		}
		const estimate = await estimateStoryReview(db, { userId, storyId });

		expect(estimate.basis).toBe('history');
		expect(estimate.multiplier).toBeGreaterThan(2.5);
		expect(estimate.estTokens).toBeGreaterThan(bare.estTokens);
	});

	it('prices the answers the run would write, not the prompt alone', async () => {
		const storyId = await seedStory(2);
		await saveModelPricing(db, userId, {
			[MODEL]: { prompt: PRICE_PER_TOKEN, completion: PRICE_PER_TOKEN * 4 }
		});
		const estimate = await estimateStoryReview(db, { userId, storyId });

		expect(estimate.estCompletionTokens).toBeGreaterThan(0);
		expect(estimate.estCompletionCostUsd).toBeCloseTo(
			estimate.estCompletionTokens * PRICE_PER_TOKEN * 4,
			6
		);
		expect(estimate.estCostUsd).toBeCloseTo(
			estimate.estTokens * PRICE_PER_TOKEN + (estimate.estCompletionCostUsd ?? 0),
			6
		);
	});

	it('draws the completion figure from history once there is enough of it', async () => {
		const storyId = await seedStory(1);
		const bare = await estimateStoryReview(db, { userId, storyId });
		expect(bare.basis).toBe('static');
		for (let i = 0; i < 6; i++) {
			await db.insert(assistantUsage).values({
				userId,
				role: 'reviewer',
				model: MODEL,
				promptTokens: 5_000_000,
				completionTokens: 9_000
			});
		}
		const estimate = await estimateStoryReview(db, { userId, storyId });

		expect(estimate.basis).toBe('history');
		expect(estimate.estCompletionTokens).toBeGreaterThan(bare.estCompletionTokens);
	});

	it('refuses to estimate when no reviewer model is configured', async () => {
		const storyId = await seedStory(1);
		await saveAccountLlmConfig(db, userId, {
			enabled: true,
			assistantName: '',
			persona: 'balanced',
			endpoint: 'https://api.example.com/v1',
			apiKey: 'sk',
			models: {},
			toolCallBudget: 8
		});
		await expect(estimateStoryReview(db, { userId, storyId })).rejects.toThrow(
			/No model is configured/
		);
	});

	it('changes nothing: no job, no usage row, no summary written', async () => {
		const storyId = await seedStory(2);
		await estimateStoryReview(db, { userId, storyId });

		expect(await countRows('assistant_usage')).toBe(0);
		expect(await countRows('assistant_review_runs')).toBe(0);
		const rows = await db
			.select({ summaryMd: scenes.summaryMd })
			.from(scenes)
			.where(eq(scenes.storyId, storyId))
			.orderBy(asc(scenes.globalPosition));
		expect(rows.map((r) => r.summaryMd)).toEqual(['Summary of scene 1.', 'Summary of scene 2.']);
	});
});

describe('per-run spend cap (#549)', () => {
	it('stops at a scene boundary once the cap is spent', async () => {
		const storyId = await seedStory(3);
		await priceModel();
		await configure({ spendCapUsd: 1.5 });
		const { provider: p } = provider();
		const result = await reviewStoryScenes(db, { userId, storyId }, { provider: p });

		// One dollar a scene: the third scene is never started.
		expect(result.reviewed).toBe(2);
		expect(result.total).toBe(3);
		expect(result.capped).toBe(true);
		expect(result.spentUsd).toBeCloseTo(2, 6);
	});

	it('is its own outcome, not a failure or a cancellation', async () => {
		const storyId = await seedStory(3);
		await priceModel();
		await configure({ spendCapUsd: 1.5 });
		const { provider: p } = provider();
		const result = await reviewStoryScenes(db, { userId, storyId }, { provider: p });

		expect(result.failed).toBe(0);
		expect(result.failures).toHaveLength(0);
		expect(result.aborted).toBeUndefined();
	});

	it('records the stop on the run so the modal and a retry can see it', async () => {
		const storyId = await seedStory(3);
		await priceModel();
		await configure({ spendCapUsd: 1.5 });
		const { provider: p } = provider();
		await reviewStoryScenes(db, { userId, storyId, jobId: 'cap-1' }, { provider: p });

		const run = await loadReviewRun(db, 'cap-1');
		expect(run?.capped).toBe(true);
		expect(run?.spentUsd).toBeCloseTo(2, 6);
		expect(run?.completed).toHaveLength(2);
	});

	it('running the same review again continues where it stopped', async () => {
		const storyId = await seedStory(3);
		await priceModel();
		await configure({ spendCapUsd: 1.5 });
		const first = provider();
		await reviewStoryScenes(db, { userId, storyId, jobId: 'cap-2' }, { provider: first.provider });

		await configure({ spendCapUsd: 10 });
		const second = provider();
		const result = await reviewStoryScenes(
			db,
			{ userId, storyId, jobId: 'cap-2' },
			{ provider: second.provider }
		);

		// Only the scene the first attempt never reached is sent again.
		expect(second.seen).toHaveLength(1);
		expect(second.seen[0].map((m) => m.content).join('\n')).toContain('Review the scene "Scene 3"');
		expect(result.reviewed).toBe(3);
		expect(result.capped).toBeUndefined();
	});

	it('continues under a new job id, the way the writer starts it again', async () => {
		const storyId = await seedStory(3);
		await priceModel();
		await configure({ spendCapUsd: 1.5 });
		const first = provider();
		await reviewStoryScenes(db, { userId, storyId, jobId: 'cap-3' }, { provider: first.provider });

		// The capped job completed, so the button mints a fresh job id; the run it
		// stopped part-way is picked up by its scope rather than re-billed.
		await configure({ spendCapUsd: 10 });
		const second = provider();
		const result = await reviewStoryScenes(
			db,
			{ userId, storyId, jobId: 'cap-4' },
			{ provider: second.provider }
		);

		expect(second.seen).toHaveLength(1);
		expect(second.seen[0].map((m) => m.content).join('\n')).toContain('Review the scene "Scene 3"');
		expect(result.reviewed).toBe(3);
		expect(result.capped).toBeUndefined();
		// The new run starts with the whole ceiling again, not the old spend.
		const run = await loadReviewRun(db, 'cap-4');
		expect(run?.capped).toBe(false);
		expect(run?.spentUsd).toBe(0);
	});

	it('does not adopt a run that finished inside its ceiling', async () => {
		const storyId = await seedStory(2);
		await priceModel();
		await configure({ spendCapUsd: 10 });
		const first = provider();
		await reviewStoryScenes(db, { userId, storyId, jobId: 'done-1' }, { provider: first.provider });

		const second = provider();
		const result = await reviewStoryScenes(
			db,
			{ userId, storyId, jobId: 'done-2' },
			{ provider: second.provider }
		);

		// A fresh full review really reviews the story again.
		expect(second.seen).toHaveLength(2);
		expect(result.reviewed).toBe(2);
	});

	it('does not adopt a capped run over a different scope', async () => {
		const other = await seedStory(3);
		await priceModel();
		await configure({ spendCapUsd: 1.5 });
		await reviewStoryScenes(db, { userId, storyId: other, jobId: 'cap-5' }, provider());

		const storyId = await seedStory(2);
		await configure({ spendCapUsd: 10 });
		const second = provider();
		const result = await reviewStoryScenes(
			db,
			{ userId, storyId, jobId: 'cap-6' },
			{ provider: second.provider }
		);

		expect(result.reviewed).toBe(2);
		expect(second.seen).toHaveLength(2);
	});

	it('does not adopt a capped run that checked other categories', async () => {
		const storyId = await seedStory(3);
		await priceModel();
		await configure({ spendCapUsd: 1.5 });
		const first = await reviewStoryScenes(
			db,
			{ userId, storyId, categories: ['mechanics'], jobId: 'cap-7' },
			{ provider: provider().provider }
		);
		expect(first.capped).toBe(true);

		// The scenes the mechanics pass covered were never checked for prose.
		await configure({ spendCapUsd: 10 });
		const second = provider();
		const result = await reviewStoryScenes(
			db,
			{ userId, storyId, categories: ['prose'], jobId: 'cap-8' },
			{ provider: second.provider }
		);

		expect(second.seen).toHaveLength(3);
		expect(result.reviewed).toBe(3);
	});

	it('does not adopt a capped run that a later run already finished', async () => {
		const storyId = await seedStory(3);
		await priceModel();
		await configure({ spendCapUsd: 1.5 });
		await reviewStoryScenes(db, { userId, storyId, jobId: 'cap-9' }, provider());

		// The writer continues it, and that run finishes the story.
		await configure({ spendCapUsd: 10 });
		const finish = await reviewStoryScenes(
			db,
			{ userId, storyId, jobId: 'cap-10' },
			{ provider: provider().provider }
		);
		expect(finish.reviewed).toBe(3);

		// Weeks later a fresh review must read every scene again, not carry the
		// capped run's scenes forward a second time.
		const fresh = provider();
		const result = await reviewStoryScenes(
			db,
			{ userId, storyId, jobId: 'cap-11' },
			{ provider: fresh.provider }
		);
		expect(fresh.seen).toHaveLength(3);
		expect(result.reviewed).toBe(3);
	});

	// A continuation saves its own uncapped row as soon as it starts, so a
	// continuation that never finished must not hide the capped run behind it.
	it('carries on from a continuation that threw part-way', async () => {
		const storyId = await seedStory(4);
		await priceModel();
		await configure({ spendCapUsd: 1.5 });
		await reviewStoryScenes(db, { userId, storyId, jobId: 'cap-12' }, provider());
		const capped = await loadReviewRun(db, 'cap-12');
		expect(capped?.completed).toHaveLength(2);

		// What the continuation's row holds when it throws after one more scene:
		// its job completes and the row stays in the scene phase.
		const ids = await db
			.select({ id: scenes.id })
			.from(scenes)
			.where(eq(scenes.storyId, storyId))
			.orderBy(asc(scenes.globalPosition));
		await saveReviewRun(db, {
			jobId: 'cap-13',
			userId,
			state: {
				...capped!,
				phase: 'scenes',
				completed: ids.slice(0, 3).map((row) => row.id),
				reviewed: 3,
				capped: false,
				spentUsd: 0,
				carriedForward: true
			}
		});

		await configure({ spendCapUsd: 10 });
		const next = provider();
		const result = await reviewStoryScenes(
			db,
			{ userId, storyId, jobId: 'cap-14' },
			{ provider: next.provider }
		);
		expect(next.seen).toHaveLength(1);
		expect(next.seen[0].map((m) => m.content).join('\n')).toContain('Review the scene "Scene 4"');
		expect(result.reviewed).toBe(4);
	});

	it('carries on from a continuation that was cancelled', async () => {
		const storyId = await seedStory(4);
		await priceModel();
		await configure({ spendCapUsd: 1.5 });
		await reviewStoryScenes(db, { userId, storyId, jobId: 'cap-15' }, provider());

		// The continuation is cancelled after it reviews one more scene.
		await configure({ spendCapUsd: 10 });
		const controller = new AbortController();
		const cancelled = cancelledAfterOneScene(controller);
		const stopped = await reviewStoryScenes(
			db,
			{ userId, storyId, jobId: 'cap-16', signal: controller.signal },
			{ provider: cancelled.provider }
		);
		expect(stopped.aborted).toBe(true);
		const row = await loadReviewRun(db, 'cap-16');
		expect(row?.completed.length).toBeGreaterThanOrEqual(2);

		const next = provider();
		const result = await reviewStoryScenes(
			db,
			{ userId, storyId, jobId: 'cap-17' },
			{ provider: next.provider }
		);
		expect(next.seen).toHaveLength(4 - row!.completed.length);
		expect(result.reviewed).toBe(4);
	});

	it('does not adopt a fresh run that was cancelled', async () => {
		const storyId = await seedStory(3);
		const controller = new AbortController();
		const cancelled = cancelledAfterOneScene(controller);
		await reviewStoryScenes(
			db,
			{ userId, storyId, jobId: 'cap-18', signal: controller.signal },
			{ provider: cancelled.provider }
		);

		const next = provider();
		await reviewStoryScenes(db, { userId, storyId, jobId: 'cap-19' }, { provider: next.provider });
		expect(next.seen).toHaveLength(3);
	});

	it('does not adopt a continuation that went on to finish', async () => {
		const storyId = await seedStory(4);
		await priceModel();
		await configure({ spendCapUsd: 1.5 });
		await reviewStoryScenes(db, { userId, storyId, jobId: 'cap-20' }, provider());

		// The first continuation is cancelled, the second picks it up and finishes.
		await configure({ spendCapUsd: 10 });
		const controller = new AbortController();
		const cancelled = cancelledAfterOneScene(controller);
		await reviewStoryScenes(
			db,
			{ userId, storyId, jobId: 'cap-21', signal: controller.signal },
			{ provider: cancelled.provider }
		);
		const finish = await reviewStoryScenes(
			db,
			{ userId, storyId, jobId: 'cap-22' },
			{ provider: provider().provider }
		);
		expect(finish.reviewed).toBe(4);

		const fresh = provider();
		await reviewStoryScenes(db, { userId, storyId, jobId: 'cap-23' }, { provider: fresh.provider });
		expect(fresh.seen).toHaveLength(4);
	});

	it('says so when the model has no price, rather than skipping the cap in silence', async () => {
		const storyId = await seedStory(2);
		await configure({ spendCapUsd: 0.5 });
		const { provider: p } = provider();
		const result = await reviewStoryScenes(db, { userId, storyId }, { provider: p });

		expect(result.capped).toBeUndefined();
		expect(result.reviewed).toBe(2);
		expect(result.failures.map((f) => f.message)).toContain(
			'A spend cap is set but the model has no known price, so it was not applied.'
		);
	});

	it("does not repeat the earlier run's own messages when it continues", async () => {
		const storyId = await seedStory(3);
		await priceModel();
		await configure({ spendCapUsd: 1.5 });
		await reviewStoryScenes(db, { userId, storyId, jobId: 'msg-1' }, provider());
		const capped = await loadReviewRun(db, 'msg-1');
		const [first] = await db
			.select({ id: scenes.id })
			.from(scenes)
			.where(eq(scenes.storyId, storyId))
			.orderBy(asc(scenes.globalPosition))
			.limit(1);
		// The capped run's summary phase hit the cap too, and one scene failed.
		await saveReviewRun(db, {
			jobId: 'msg-1',
			userId,
			state: {
				...capped!,
				failures: [
					{ message: SUMMARIES_CAPPED_MESSAGE },
					{ message: CAP_NOT_APPLIED_MESSAGE },
					{ sceneId: first.id, sceneTitle: 'Scene 1', message: 'Scene one broke' }
				]
			}
		});

		await configure({ spendCapUsd: 10 });
		const result = await reviewStoryScenes(
			db,
			{ userId, storyId, jobId: 'msg-2' },
			{ provider: provider().provider }
		);
		expect(result.capped).toBeUndefined();
		expect(result.failures.map((f) => f.message)).toEqual(['Scene one broke']);
		const run = await loadReviewRun(db, 'msg-2');
		expect(run?.failures.map((f) => f.message)).toEqual(['Scene one broke']);
	});

	it('lists a cap it could not apply once when the same job runs again', async () => {
		const storyId = await seedStory(2);
		await configure({ spendCapUsd: 0.5 });
		// The first attempt stops after one scene, as a worker restart would.
		const controller = new AbortController();
		const first = await reviewStoryScenes(
			db,
			{ userId, storyId, jobId: 'np-1', signal: controller.signal },
			{ provider: cancelledAfterOneScene(controller).provider }
		);
		expect(first.failures.map((f) => f.message)).toEqual([CAP_NOT_APPLIED_MESSAGE]);
		const again = await reviewStoryScenes(
			db,
			{ userId, storyId, jobId: 'np-1' },
			{ provider: provider().provider }
		);
		expect(again.failures.map((f) => f.message)).toEqual([CAP_NOT_APPLIED_MESSAGE]);
	});

	it('spends one ceiling across the summary phase and the scene passes', async () => {
		const storyId = await seedStory(3);
		// No summaries at all, so the run must write them before it reviews.
		await db.update(scenes).set({ summaryMd: null }).where(eq(scenes.storyId, storyId));
		await priceModel();
		await configure({ spendCapUsd: 1.5 });
		const { provider: p } = provider();
		const result = await reviewStoryScenes(db, { userId, storyId }, { provider: p });

		// The summary phase spends the ceiling first, so no scene is reviewed.
		expect(result.reviewed).toBe(0);
		expect(result.capped).toBe(true);
	});
});

describe('a capped run saved before categories were part of its key', () => {
	// What the release before the upgrade stored: the key had no categories.
	async function legacyRun(
		storyId: string,
		jobId: string,
		opts: {
			capped: boolean;
			scenes: number;
			phase?: 'scenes' | 'done';
			carriedForward?: boolean;
		}
	): Promise<void> {
		const ids = await db
			.select({ id: scenes.id })
			.from(scenes)
			.where(eq(scenes.storyId, storyId))
			.orderBy(asc(scenes.globalPosition));
		await saveReviewRun(db, {
			jobId,
			userId,
			state: {
				...emptyReviewRun(),
				phase: opts.phase ?? 'done',
				scope: `full:${storyId}`,
				total: ids.length,
				completed: ids.slice(0, opts.scenes).map((row) => row.id),
				reviewed: opts.scenes,
				capped: opts.capped,
				...(opts.carriedForward ? { carriedForward: true } : {})
			}
		});
	}

	async function continueReview(
		storyId: string,
		categories: ReviewCategory[],
		jobCategories: (jobId: string) => Promise<ReviewCategory[] | null>,
		jobId = 'after-upgrade'
	) {
		const p = provider();
		const result = await reviewStoryScenes(
			db,
			{ userId, storyId, categories, jobId, legacyJobCategories: jobCategories },
			{ provider: p.provider }
		);
		return { result, sent: p.seen.length };
	}

	it('continues it when its job checked the same categories', async () => {
		const storyId = await seedStory(3);
		await legacyRun(storyId, 'legacy-1', { capped: true, scenes: 2 });
		const asked: string[] = [];
		const { result, sent } = await continueReview(storyId, ['prose'], async (jobId) => {
			asked.push(jobId);
			return ['prose'];
		});

		expect(asked).toEqual(['legacy-1']);
		expect(sent).toBe(1);
		expect(result.reviewed).toBe(3);
	});

	it('reviews every scene when its job checked other categories', async () => {
		const storyId = await seedStory(3);
		await legacyRun(storyId, 'legacy-2', { capped: true, scenes: 2 });
		const { sent } = await continueReview(storyId, ['prose'], async () => ['mechanics']);
		expect(sent).toBe(3);
	});

	it('reviews every scene when its job is no longer known', async () => {
		const storyId = await seedStory(3);
		await legacyRun(storyId, 'legacy-3', { capped: true, scenes: 2 });
		const { sent } = await continueReview(storyId, [], async () => null);
		expect(sent).toBe(3);
	});

	it('reviews every scene when a later run over the old key finished', async () => {
		const storyId = await seedStory(3);
		await legacyRun(storyId, 'legacy-4', { capped: true, scenes: 2 });
		await legacyRun(storyId, 'legacy-5', { capped: false, scenes: 3 });
		const { sent } = await continueReview(storyId, [], async () => []);
		expect(sent).toBe(3);
	});

	it('continues from a legacy continuation that never finished', async () => {
		const storyId = await seedStory(3);
		await legacyRun(storyId, 'legacy-7', { capped: true, scenes: 1 });
		await legacyRun(storyId, 'legacy-8', {
			capped: false,
			scenes: 2,
			phase: 'scenes',
			carriedForward: true
		});
		const { sent } = await continueReview(storyId, [], async () => []);
		expect(sent).toBe(1);
	});

	it('is passed over once a run under the new key exists', async () => {
		const storyId = await seedStory(3);
		await legacyRun(storyId, 'legacy-6', { capped: true, scenes: 2 });
		const first = await continueReview(storyId, [], async () => []);
		expect(first.sent).toBe(1);

		// That run finished, so the next one starts over.
		const second = await continueReview(storyId, [], async () => [], 'later');
		expect(second.sent).toBe(3);
	});
});

describe('spend settings normalisation (#549)', () => {
	it('keeps positive figures and drops anything else', async () => {
		await configure({ spendCapUsd: 3.5, spendWarnUsd: 0.75 });
		let view = await accountLlmView(db, userId);
		expect(view.spendCapUsd).toBe(3.5);
		expect(view.spendWarnUsd).toBe(0.75);

		await configure({ spendCapUsd: null, spendWarnUsd: null });
		view = await accountLlmView(db, userId);
		expect(view.spendCapUsd).toBeUndefined();
		expect(view.spendWarnUsd).toBeUndefined();
	});

	it('rejects a stored figure that is not a positive number', async () => {
		await db
			.update(users)
			.set({
				llmConfig: sql`${users.llmConfig} || '{"spendCapUsd": -2, "spendWarnUsd": "lots"}'::jsonb`
			})
			.where(eq(users.id, userId));
		const view = await accountLlmView(db, userId);

		expect(view.spendCapUsd).toBeUndefined();
		expect(view.spendWarnUsd).toBeUndefined();
	});
});

describe('spend cap on the standalone summaries job (#622)', () => {
	// Blank summaries, so every scene needs one and each costs a dollar.
	async function seedUnsummarised(sceneCount: number): Promise<string> {
		const storyId = await seedStory(sceneCount);
		await db.update(scenes).set({ summaryMd: null }).where(eq(scenes.storyId, storyId));
		return storyId;
	}

	it('stops between summaries once the cap is spent', async () => {
		const storyId = await seedUnsummarised(3);
		await priceModel();
		await configure({ spendCapUsd: 1.5 });
		const { provider: p, seen } = provider();
		const result = await summariseStory(db, { userId, storyId }, { provider: p });

		expect(seen).toHaveLength(2);
		expect(result.scenes).toBe(2);
		expect(result.capped).toBe(true);
		expect(result.spentUsd).toBeCloseTo(2, 6);
		const rows = await db
			.select({ summaryMd: scenes.summaryMd })
			.from(scenes)
			.where(eq(scenes.storyId, storyId))
			.orderBy(asc(scenes.globalPosition));
		expect(rows[2].summaryMd).toBeNull();
	});

	it('runs to the end with no cap set', async () => {
		const storyId = await seedUnsummarised(3);
		await priceModel();
		const { provider: p } = provider();
		const result = await summariseStory(db, { userId, storyId }, { provider: p });

		expect(result.scenes).toBe(3);
		expect(result.capped).toBeUndefined();
		expect(result.capNotApplied).toBeUndefined();
	});

	it('says the cap could not be applied when the model has no price', async () => {
		const storyId = await seedUnsummarised(2);
		await configure({ spendCapUsd: 1.5 });
		const { provider: p } = provider();
		const result = await summariseStory(db, { userId, storyId }, { provider: p });

		expect(result.scenes).toBe(2);
		expect(result.capped).toBeUndefined();
		expect(result.capNotApplied).toBe(CAP_NOT_APPLIED_MESSAGE);
	});
});
