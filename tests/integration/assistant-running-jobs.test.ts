import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import * as schema from '../../src/lib/server/db/schema';
import { chapters, stories, universes, users } from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';
import { findRunningAssistantJobs } from '../../src/lib/server/running-jobs';
import { ASSISTANT_REVIEW_QUEUE, ASSISTANT_SUMMARIES_QUEUE } from '../../src/lib/server/queues';

// Against a real pg-boss, because the list leans on its job states and its
// payload matching (findJobs with data).
let pool: pg.Pool;
let db: Database;
let boss: PgBoss;
let userId: string;
let otherId: string;
let universeId: string;
let storyId: string;

async function user(email: string): Promise<string> {
	const [row] = await db
		.insert(users)
		.values({ email, displayName: 'P', passwordHash: 'x', role: 'user' })
		.returning({ id: users.id });
	return row.id;
}

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
	boss = new PgBoss({ connectionString: TEST_DATABASE_URL, supervise: false, schedule: false });
	boss.on('error', (error) => console.error(error));
	await boss.start();
	await boss.createQueue(ASSISTANT_REVIEW_QUEUE);
	await boss.createQueue(ASSISTANT_SUMMARIES_QUEUE);
});

beforeEach(async () => {
	await boss.deleteAllJobs(ASSISTANT_REVIEW_QUEUE);
	await boss.deleteAllJobs(ASSISTANT_SUMMARIES_QUEUE);
	await pool.query('truncate table chapters, stories, universes, users cascade');
	userId = await user('p@example.com');
	otherId = await user('o@example.com');
	const [universe] = await db
		.insert(universes)
		.values({ ownerId: userId, name: 'Hollow Coast' })
		.returning({ id: universes.id });
	universeId = universe.id;
	const [story] = await db
		.insert(stories)
		.values({ universeId, ownerId: userId, title: 'Saltglass' })
		.returning({ id: stories.id });
	storyId = story.id;
});

afterAll(async () => {
	await boss.stop({ graceful: false });
	await pool.end();
});

describe('findRunningAssistantJobs', () => {
	it('lists queued and running review and summary jobs with their names', async () => {
		const queued = await boss.send(ASSISTANT_REVIEW_QUEUE, {
			userId,
			storyId,
			categories: []
		});
		const summaries = await boss.send(ASSISTANT_SUMMARIES_QUEUE, { userId, storyId });
		await boss.fetch(ASSISTANT_SUMMARIES_QUEUE);
		const universePass = await boss.send(ASSISTANT_REVIEW_QUEUE, {
			userId,
			universeId,
			categories: [],
			mode: 'continuity'
		});

		const jobs = await findRunningAssistantJobs(boss, db, userId);
		expect(jobs).toHaveLength(3);
		expect(jobs).toContainEqual({
			id: queued,
			kind: 'review',
			mode: 'full',
			storyId,
			chapterId: null,
			universeId: null,
			title: 'Saltglass'
		});
		expect(jobs.find((j) => j.id === summaries)).toMatchObject({
			kind: 'summaries',
			storyId,
			title: 'Saltglass'
		});
		expect(jobs.find((j) => j.id === universePass)).toMatchObject({
			kind: 'review',
			mode: 'continuity',
			storyId: null,
			universeId,
			title: 'Hollow Coast'
		});
	});

	it('names a chapter review after its chapter', async () => {
		const [chapter] = await db
			.insert(chapters)
			.values({ storyId, position: 1, title: 'The Tidewall' })
			.returning({ id: chapters.id });
		await boss.send(ASSISTANT_REVIEW_QUEUE, {
			userId,
			storyId,
			chapterId: chapter.id,
			categories: []
		});

		const [job] = await findRunningAssistantJobs(boss, db, userId);
		expect(job).toMatchObject({ storyId, chapterId: chapter.id, title: 'The Tidewall' });
	});

	it('leaves out settled jobs', async () => {
		const done = await boss.send(ASSISTANT_REVIEW_QUEUE, { userId, storyId, categories: [] });
		await boss.fetch(ASSISTANT_REVIEW_QUEUE);
		await boss.complete(ASSISTANT_REVIEW_QUEUE, done!);
		const failed = await boss.send(
			ASSISTANT_SUMMARIES_QUEUE,
			{ userId, storyId },
			{ retryLimit: 0 }
		);
		await boss.fetch(ASSISTANT_SUMMARIES_QUEUE);
		await boss.fail(ASSISTANT_SUMMARIES_QUEUE, failed!);

		expect(await findRunningAssistantJobs(boss, db, userId)).toEqual([]);
	});

	it("leaves out another writer's jobs, and jobs over deleted work", async () => {
		await boss.send(ASSISTANT_REVIEW_QUEUE, { userId: otherId, storyId, categories: [] });
		const [gone] = await db
			.insert(stories)
			.values({ universeId, ownerId: userId, title: 'Gone' })
			.returning({ id: stories.id });
		await db.update(stories).set({ deletedAt: new Date() }).where(eq(stories.id, gone.id));
		await boss.send(ASSISTANT_SUMMARIES_QUEUE, { userId, storyId: gone.id });

		expect(await findRunningAssistantJobs(boss, db, userId)).toEqual([]);
		expect(await findRunningAssistantJobs(boss, db, otherId)).toEqual([]);
	});
});
