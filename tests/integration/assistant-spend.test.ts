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

const { accountLlmView, saveAccountLlmConfig, saveModelPricing } =
	await import('../../src/lib/server/llm/config');
const { reviewStoryScenes } = await import('../../src/lib/server/llm/scene-review');
const { estimateStoryReview } = await import('../../src/lib/server/llm/estimate');
const { loadReviewRun } = await import('../../src/lib/server/review-runs');

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
