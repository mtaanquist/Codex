import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { asc, eq } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import { scenes, stories, universes, users } from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

process.env.APP_SECRET = process.env.APP_SECRET || 'review-progress-test-secret';

import type { ChatMessage, Provider } from '../../src/lib/server/llm/providers/types';

const { saveAccountLlmConfig } = await import('../../src/lib/server/llm/config');
const { reviewStoryScenes } = await import('../../src/lib/server/llm/scene-review');
const { loadReviewRun, saveReviewRun, emptyReviewRun } =
	await import('../../src/lib/server/review-runs');

let pool: pg.Pool;
let db: Database;
let userId: string;
let universeId: string;

// Answers every request with plain text, recording what was asked. onRequest can
// throw to make one turn fail (the failure paths under test).
function provider(onRequest?: (messages: ChatMessage[]) => void): {
	provider: Provider;
	seen: ChatMessage[][];
} {
	const seen: ChatMessage[][] = [];
	return {
		seen,
		provider: {
			async *chatStream() {
				yield { type: 'done' };
			},
			async respond(req) {
				seen.push(req.messages);
				onRequest?.(req.messages);
				return { content: 'no notes', toolCalls: [] };
			},
			async listModels() {
				return [];
			}
		}
	};
}

const asked = (messages: ChatMessage[]) => messages.map((m) => m.content).join('\n');

// The instruction line that names the scene under review, so a test can fail one
// scene without matching the scene listings that ride in every request.
const reviewing = (messages: ChatMessage[], title: string) =>
	asked(messages).includes(`Review the scene "${title}"`);

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
		.values({ email: 'p@example.com', displayName: 'Pia', passwordHash: 'x', role: 'user' })
		.returning({ id: users.id });
	userId = user.id;
	const [universe] = await db
		.insert(universes)
		.values({ ownerId: userId, name: 'U' })
		.returning({ id: universes.id });
	universeId = universe.id;
	await saveAccountLlmConfig(db, userId, {
		enabled: true,
		assistantName: '',
		persona: 'balanced',
		endpoint: 'https://api.example.com/v1',
		apiKey: 'sk',
		models: { reviewer: 'review-model' },
		toolCallBudget: 8
	});
});

afterAll(async () => {
	await pool.end();
});

// Scenes carry a summary with no generated-at watermark (the writer's own), so
// nothing is stale and the summary phase is skipped unless a test asks for it.
async function seedStory(sceneCount: number, opts: { summaries?: boolean } = {}): Promise<string> {
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
			summaryMd: opts.summaries === false ? null : `Summary of scene ${i + 1}.`
		});
	}
	return story.id;
}

const sceneIds = async (storyId: string) =>
	(
		await db
			.select({ id: scenes.id })
			.from(scenes)
			.where(eq(scenes.storyId, storyId))
			.orderBy(asc(scenes.globalPosition))
	).map((row) => row.id);

describe('review failures (#528)', () => {
	it('names the scene and the error for each failed pass, and reviews the rest', async () => {
		const storyId = await seedStory(3);
		const { provider: p } = provider((messages) => {
			if (reviewing(messages, 'Scene 2')) throw new Error('The endpoint refused the request.');
		});
		const result = await reviewStoryScenes(db, { userId, storyId }, { provider: p });

		expect(result.reviewed).toBe(2);
		expect(result.failed).toBe(1);
		expect(result.failures).toHaveLength(1);
		expect(result.failures[0].sceneTitle).toBe('Scene 2');
		expect(result.failures[0].message).toBe('The endpoint refused the request.');
	});

	it('records a pass that was cut short even though it did not throw', async () => {
		const storyId = await seedStory(1);
		// A budget of zero withdraws the tools before the first turn, so the pass
		// answers but is reported as stopped.
		await saveAccountLlmConfig(db, userId, {
			enabled: true,
			assistantName: '',
			persona: 'balanced',
			endpoint: 'https://api.example.com/v1',
			apiKey: 'sk',
			models: { reviewer: 'review-model' },
			toolCallBudget: 0
		});
		const { provider: p } = provider();
		const result = await reviewStoryScenes(db, { userId, storyId }, { provider: p });

		expect(result.reviewed).toBe(1);
		expect(result.failed).toBe(0);
		expect(result.failures).toHaveLength(1);
		expect(result.failures[0].message).toContain('Stopped early');
	});

	it('a cancelled run stops rather than counting the rest as failures', async () => {
		const storyId = await seedStory(3);
		const controller = new AbortController();
		const { provider: p } = provider(() => controller.abort());
		const result = await reviewStoryScenes(
			db,
			{ userId, storyId, signal: controller.signal },
			{ provider: p }
		);

		expect(result.aborted).toBe(true);
		expect(result.failed).toBe(0);
		expect(result.failures).toHaveLength(0);
	});
});

describe('review progress (#530)', () => {
	it('records the phase, the scenes done, and the failures as it runs', async () => {
		const storyId = await seedStory(2);
		const { provider: p } = provider((messages) => {
			if (reviewing(messages, 'Scene 1')) throw new Error('No route to the endpoint.');
		});
		await reviewStoryScenes(db, { userId, storyId, jobId: 'job-1' }, { provider: p });

		const run = await loadReviewRun(db, 'job-1');
		expect(run?.phase).toBe('done');
		expect(run?.total).toBe(2);
		expect(run?.completed).toHaveLength(2);
		expect(run?.reviewed).toBe(1);
		expect(run?.failed).toBe(1);
		expect(run?.failures[0].message).toBe('No route to the endpoint.');
	});

	it('is only readable by the user who started the run', async () => {
		const storyId = await seedStory(1);
		const { provider: p } = provider();
		await reviewStoryScenes(db, { userId, storyId, jobId: 'job-2' }, { provider: p });

		expect(await loadReviewRun(db, 'job-2', userId)).not.toBeNull();
		expect(await loadReviewRun(db, 'job-2', universeId)).toBeNull();
	});

	it('a retry skips the scenes the earlier attempt already handled', async () => {
		const storyId = await seedStory(2);
		const ids = await sceneIds(storyId);
		await saveReviewRun(db, {
			jobId: 'job-3',
			userId,
			state: {
				...emptyReviewRun(),
				phase: 'scenes',
				total: 2,
				completed: [ids[0]],
				reviewed: 1,
				notes: 3
			}
		});
		const { provider: p, seen } = provider();
		const result = await reviewStoryScenes(
			db,
			{ userId, storyId, jobId: 'job-3' },
			{ provider: p }
		);

		expect(seen).toHaveLength(1);
		expect(reviewing(seen[0], 'Scene 2')).toBe(true);
		// The first attempt's work carries over rather than being repeated.
		expect(result.reviewed).toBe(2);
		expect(result.notes).toBe(3);
	});
});

describe('summary maintenance before a review (#541)', () => {
	it('writes the missing summaries first and says so', async () => {
		const storyId = await seedStory(1, { summaries: false });
		const { provider: p } = provider();
		const result = await reviewStoryScenes(db, { userId, storyId }, { provider: p });

		expect(result.summariesRefreshed).toBe(true);
		const [scene] = await db.select({ summaryMd: scenes.summaryMd }).from(scenes);
		expect(scene.summaryMd).toBe('no notes');
	});

	it('does not enter the summary pass when every summary is current', async () => {
		const storyId = await seedStory(2);
		const { provider: p, seen } = provider();
		const result = await reviewStoryScenes(db, { userId, storyId }, { provider: p });

		expect(result.summariesRefreshed).toBeUndefined();
		// One turn per scene, and nothing else.
		expect(seen).toHaveLength(2);
	});

	it('a summary failure is reported and the review still runs', async () => {
		const storyId = await seedStory(1, { summaries: false });
		const { provider: p } = provider((messages) => {
			if (asked(messages).includes('Summarise')) throw new Error('Summary turn failed.');
		});
		const result = await reviewStoryScenes(db, { userId, storyId }, { provider: p });

		expect(result.reviewed).toBe(1);
		expect(result.failures.some((f) => f.message.includes('summar'))).toBe(true);
	});
});
