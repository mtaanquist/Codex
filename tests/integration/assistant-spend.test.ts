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

const { accountLlmView, saveAccountLlmConfig, saveModelPricing } =
	await import('../../src/lib/server/llm/config');
const { estimateStoryReview } = await import('../../src/lib/server/llm/estimate');

let pool: pg.Pool;
let db: Database;
let userId: string;
let universeId: string;

const MODEL = 'review-model';
const PRICE_PER_TOKEN = 0.001;

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
