import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import * as schema from '../../src/lib/server/db/schema';
import {
	chapters,
	characters,
	scenes,
	stories,
	universes,
	users
} from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';
import { findRunningAssistantJobs, stopAssistantJob } from '../../src/lib/server/running-jobs';
import {
	ASSISTANT_DRAFT_QUEUE,
	ASSISTANT_ENRICH_QUEUE,
	ASSISTANT_QUEUE_OPTIONS,
	ASSISTANT_REVIEW_QUEUE,
	ASSISTANT_SUMMARIES_QUEUE,
	LEGACY_ASSISTANT_REVIEW_QUEUE,
	LEGACY_ASSISTANT_SUMMARIES_QUEUE
} from '../../src/lib/server/queues';

// Against a real pg-boss, because the list reads its job table directly: this
// pins the query to the installed version's table, columns and states.
const ASSISTANT_QUEUES = [
	ASSISTANT_REVIEW_QUEUE,
	ASSISTANT_SUMMARIES_QUEUE,
	ASSISTANT_ENRICH_QUEUE,
	ASSISTANT_DRAFT_QUEUE
];
let pool: pg.Pool;

// The queues are exclusive, so each job here is given its own singleton key.
function send(queue: string, data: object, options: { retryLimit?: number } = {}) {
	return boss.send(queue, data, { singletonKey: randomUUID(), ...options });
}
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
	for (const queue of ASSISTANT_QUEUES) {
		await boss.deleteQueue(queue);
		await boss.createQueue(queue, ASSISTANT_QUEUE_OPTIONS);
	}
	await boss.createQueue(LEGACY_ASSISTANT_REVIEW_QUEUE);
	await boss.createQueue(LEGACY_ASSISTANT_SUMMARIES_QUEUE);
});

beforeEach(async () => {
	for (const queue of [
		...ASSISTANT_QUEUES,
		LEGACY_ASSISTANT_REVIEW_QUEUE,
		LEGACY_ASSISTANT_SUMMARIES_QUEUE
	]) {
		await boss.deleteAllJobs(queue);
	}
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
	it('lists a details read as its own kind, named for the entry', async () => {
		const id = await send(ASSISTANT_ENRICH_QUEUE, {
			userId,
			universeId,
			read: { entityId: randomUUID(), name: 'The Lantern Guild', storyId, mode: 'scenes' }
		});
		const jobs = await findRunningAssistantJobs(db, userId);
		expect(jobs).toMatchObject([
			{ id, kind: 'details', universeId, storyId: null, title: 'The Lantern Guild' }
		]);
		// When it was queued, for the list of background work.
		const queued = Date.parse(jobs[0].startedAt);
		expect(Math.abs(Date.now() - queued)).toBeLessThan(60_000);
	});

	it('lists a scene draft as its own kind, named for the scene', async () => {
		const [scene] = await db
			.insert(scenes)
			.values({ storyId, globalPosition: 1, title: 'The Crossing' })
			.returning({ id: scenes.id });
		const [untitled] = await db
			.insert(scenes)
			.values({ storyId, globalPosition: 2 })
			.returning({ id: scenes.id });
		const id = await send(ASSISTANT_DRAFT_QUEUE, {
			userId,
			storyId,
			sceneId: scene.id,
			draftId: randomUUID()
		});
		const second = await send(ASSISTANT_DRAFT_QUEUE, {
			userId,
			storyId,
			sceneId: untitled.id,
			draftId: randomUUID()
		});
		const jobs = await findRunningAssistantJobs(db, userId);
		expect(jobs.find((j) => j.id === id)).toMatchObject({
			kind: 'draft',
			storyId,
			sceneId: scene.id,
			universeId: null,
			title: 'The Crossing'
		});
		// An untitled scene is named for its story.
		expect(jobs.find((j) => j.id === second)).toMatchObject({ kind: 'draft', title: 'Saltglass' });

		// A draft over a scene since trashed, or another writer's, is left out.
		await db.update(scenes).set({ deletedAt: new Date() }).where(eq(scenes.id, scene.id));
		expect((await findRunningAssistantJobs(db, userId)).map((j) => j.id)).toEqual([second]);
		expect(await findRunningAssistantJobs(db, otherId)).toEqual([]);

		// Stop works on it like any Assistant job, for its writer only.
		expect(await stopAssistantJob(db, boss, otherId, second!)).toBe(false);
		expect(await stopAssistantJob(db, boss, userId, second!)).toBe(true);
		expect((await boss.getJobById(ASSISTANT_DRAFT_QUEUE, second!))?.state).toBe('cancelled');
	});

	it('lists a character arc as its own kind, named for the character', async () => {
		const [character] = await db
			.insert(characters)
			.values({ universeId, ownerId: userId, name: 'Bram' })
			.returning({ id: characters.id });
		const id = await send(ASSISTANT_ENRICH_QUEUE, {
			userId,
			universeId,
			characterId: character.id
		});
		const jobs = await findRunningAssistantJobs(db, userId);
		expect(jobs).toMatchObject([{ id, kind: 'arc', universeId, title: 'Bram' }]);
	});

	it('lists an enrichment pass under its universe', async () => {
		const id = await send(ASSISTANT_ENRICH_QUEUE, { userId, universeId });
		const jobs = await findRunningAssistantJobs(db, userId);
		expect(jobs).toEqual([
			{
				id,
				kind: 'enrich',
				mode: 'full',
				storyId: null,
				chapterId: null,
				sceneId: null,
				universeId,
				title: 'Hollow Coast',
				startedAt: expect.any(String)
			}
		]);
	});

	it('lists queued and running review and summary jobs with their names', async () => {
		const queued = await send(ASSISTANT_REVIEW_QUEUE, {
			userId,
			storyId,
			categories: []
		});
		const summaries = await send(ASSISTANT_SUMMARIES_QUEUE, { userId, storyId });
		await boss.fetch(ASSISTANT_SUMMARIES_QUEUE);
		const universePass = await send(ASSISTANT_REVIEW_QUEUE, {
			userId,
			universeId,
			categories: [],
			mode: 'continuity'
		});

		const jobs = await findRunningAssistantJobs(db, userId);
		expect(jobs).toHaveLength(3);
		expect(jobs).toContainEqual({
			id: queued,
			kind: 'review',
			mode: 'full',
			storyId,
			chapterId: null,
			sceneId: null,
			universeId: null,
			title: 'Saltglass',
			startedAt: expect.any(String)
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
		await send(ASSISTANT_REVIEW_QUEUE, {
			userId,
			storyId,
			chapterId: chapter.id,
			categories: []
		});

		const [job] = await findRunningAssistantJobs(db, userId);
		expect(job).toMatchObject({ storyId, chapterId: chapter.id, title: 'Saltglass: The Tidewall' });
	});

	it('keeps the story title when the chapter belongs to another story', async () => {
		const [elsewhere] = await db
			.insert(stories)
			.values({ universeId, ownerId: userId, title: 'Elsewhere' })
			.returning({ id: stories.id });
		const [chapter] = await db
			.insert(chapters)
			.values({ storyId: elsewhere.id, position: 1, title: 'Wrong' })
			.returning({ id: chapters.id });
		await send(ASSISTANT_REVIEW_QUEUE, {
			userId,
			storyId,
			chapterId: chapter.id,
			categories: []
		});

		const [job] = await findRunningAssistantJobs(db, userId);
		expect(job.title).toBe('Saltglass');
	});

	it('lists a job waiting to retry after a failed attempt', async () => {
		const id = await boss.send(
			ASSISTANT_REVIEW_QUEUE,
			{ userId, storyId, categories: [] },
			{ retryLimit: 2, retryDelay: 60 }
		);
		await boss.fetch(ASSISTANT_REVIEW_QUEUE);
		await boss.fail(ASSISTANT_REVIEW_QUEUE, id!);
		const [job] = await boss.findJobs(ASSISTANT_REVIEW_QUEUE, { id: id! });
		expect(job.state).toBe('retry');

		expect((await findRunningAssistantJobs(db, userId)).map((j) => j.id)).toEqual([id]);
	});

	it('finds a running job past many settled ones', async () => {
		for (let i = 0; i < 120; i++) {
			const id = await send(ASSISTANT_SUMMARIES_QUEUE, { userId, storyId });
			await boss.fetch(ASSISTANT_SUMMARIES_QUEUE);
			await boss.complete(ASSISTANT_SUMMARIES_QUEUE, id!);
		}
		const running = await send(ASSISTANT_SUMMARIES_QUEUE, { userId, storyId });
		await boss.fetch(ASSISTANT_SUMMARIES_QUEUE);

		expect((await findRunningAssistantJobs(db, userId)).map((j) => j.id)).toEqual([running]);
	});

	it('leaves out settled jobs', async () => {
		const done = await send(ASSISTANT_REVIEW_QUEUE, { userId, storyId, categories: [] });
		await boss.fetch(ASSISTANT_REVIEW_QUEUE);
		await boss.complete(ASSISTANT_REVIEW_QUEUE, done!);
		const failed = await boss.send(
			ASSISTANT_SUMMARIES_QUEUE,
			{ userId, storyId },
			{ retryLimit: 0 }
		);
		await boss.fetch(ASSISTANT_SUMMARIES_QUEUE);
		await boss.fail(ASSISTANT_SUMMARIES_QUEUE, failed!);

		expect(await findRunningAssistantJobs(db, userId)).toEqual([]);
	});

	// LEGACY (#1041): jobs queued on the old queues before the upgrade.
	it('lists review and summary jobs still on the old queues', async () => {
		const review = await boss.send(LEGACY_ASSISTANT_REVIEW_QUEUE, {
			userId,
			storyId,
			categories: []
		});
		const summaries = await boss.send(LEGACY_ASSISTANT_SUMMARIES_QUEUE, { userId, storyId });

		const jobs = await findRunningAssistantJobs(db, userId);
		expect(jobs.find((j) => j.id === review)).toMatchObject({ kind: 'review', storyId });
		expect(jobs.find((j) => j.id === summaries)).toMatchObject({ kind: 'summaries', storyId });
	});

	it("leaves out another writer's jobs, and jobs over deleted work", async () => {
		const [otherUniverse] = await db
			.insert(universes)
			.values({ ownerId: otherId, name: 'Theirs' })
			.returning({ id: universes.id });
		const [otherStory] = await db
			.insert(stories)
			.values({ universeId: otherUniverse.id, ownerId: otherId, title: 'Theirs' })
			.returning({ id: stories.id });
		await send(ASSISTANT_REVIEW_QUEUE, {
			userId: otherId,
			storyId: otherStory.id,
			categories: []
		});
		// A job naming this writer's story under someone else's id is not theirs either.
		await send(ASSISTANT_REVIEW_QUEUE, { userId: otherId, storyId, categories: [] });
		const [gone] = await db
			.insert(stories)
			.values({ universeId, ownerId: userId, title: 'Gone' })
			.returning({ id: stories.id });
		await db.update(stories).set({ deletedAt: new Date() }).where(eq(stories.id, gone.id));
		await send(ASSISTANT_SUMMARIES_QUEUE, { userId, storyId: gone.id });

		expect(await findRunningAssistantJobs(db, userId)).toEqual([]);
		expect((await findRunningAssistantJobs(db, otherId)).map((j) => j.title)).toEqual(['Theirs']);
	});
});

describe('stopAssistantJob (#1045)', () => {
	it("cancels the writer's running job, which frees its scope for a new one", async () => {
		const key = randomUUID();
		const id = await boss.send(
			ASSISTANT_SUMMARIES_QUEUE,
			{ userId, storyId },
			{ singletonKey: key }
		);
		await boss.fetch(ASSISTANT_SUMMARIES_QUEUE);
		expect(
			await boss.send(ASSISTANT_SUMMARIES_QUEUE, { userId, storyId }, { singletonKey: key })
		).toBeNull();

		expect(await stopAssistantJob(db, boss, userId, id!)).toBe(true);
		expect((await boss.getJobById(ASSISTANT_SUMMARIES_QUEUE, id!))?.state).toBe('cancelled');
		expect(await findRunningAssistantJobs(db, userId)).toEqual([]);
		expect(
			await boss.send(ASSISTANT_SUMMARIES_QUEUE, { userId, storyId }, { singletonKey: key })
		).not.toBeNull();
	});

	it("leaves another writer's job alone", async () => {
		const id = await send(ASSISTANT_REVIEW_QUEUE, { userId, storyId, categories: [] });
		expect(await stopAssistantJob(db, boss, otherId, id!)).toBe(false);
		expect((await boss.getJobById(ASSISTANT_REVIEW_QUEUE, id!))?.state).toBe('created');
	});

	it('does nothing for a job that has settled, or an id that is not a job', async () => {
		const id = await send(ASSISTANT_ENRICH_QUEUE, { userId, universeId });
		await boss.fetch(ASSISTANT_ENRICH_QUEUE);
		await boss.complete(ASSISTANT_ENRICH_QUEUE, id!);
		expect(await stopAssistantJob(db, boss, userId, id!)).toBe(false);
		expect(await stopAssistantJob(db, boss, userId, 'not-a-job')).toBe(false);
		expect(await stopAssistantJob(db, boss, userId, randomUUID())).toBe(false);
	});
});
