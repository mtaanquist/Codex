import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PgBoss } from 'pg-boss';
import pg from 'pg';
import {
	ASSISTANT_DRAFT_QUEUE,
	ASSISTANT_QUEUE_OPTIONS,
	ASSISTANT_REVIEW_QUEUE,
	ASSISTANT_SUMMARIES_QUEUE,
	LEGACY_ASSISTANT_REVIEW_QUEUE
} from '../../src/lib/server/queues';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

// The Assistant queues rely on their policy, not the singletonKey alone, to
// turn a repeat request into the job already queued or running (the 409 the
// client shows). The queueing functions run against a real pg-boss on the test
// database; its maintenance timers are turned off so the file can stop it.
const bosses: PgBoss[] = [];
vi.mock('pg-boss', async (importOriginal) => {
	const actual = await importOriginal<typeof import('pg-boss')>();
	class TestBoss extends actual.PgBoss {
		constructor(connectionString: string) {
			super({ connectionString, supervise: false, schedule: false });
			bosses.push(this);
		}
	}
	return { ...actual, PgBoss: TestBoss };
});
vi.mock('$app/env/private', async () => ({
	DATABASE_URL: (await import('./test-db')).TEST_DATABASE_URL
}));
vi.mock('#lib/server/db', () => ({ db: {} }));

const QUEUE = 'assistant-queue-policy-test';
let boss: PgBoss;
let pool: pg.Pool;

const jobs = await import('../../src/lib/server/jobs');

async function unfinished(queue: string): Promise<number> {
	const { rows } = await pool.query(
		`select count(*)::int as n from pgboss.job where name = $1 and state < 'completed'`,
		[queue]
	);
	return rows[0].n;
}

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	boss = new PgBoss(TEST_DATABASE_URL);
	boss.on('error', (error) => console.error(error));
	await boss.start();
	// Start from no queues, so the app creates them with the policy it declares
	// rather than inheriting one another test file made.
	for (const queue of [
		QUEUE,
		ASSISTANT_REVIEW_QUEUE,
		ASSISTANT_SUMMARIES_QUEUE,
		ASSISTANT_DRAFT_QUEUE
	]) {
		await boss.deleteQueue(queue);
	}
	await boss.createQueue(QUEUE, ASSISTANT_QUEUE_OPTIONS);
});

afterAll(async () => {
	for (const queue of [
		QUEUE,
		ASSISTANT_REVIEW_QUEUE,
		ASSISTANT_SUMMARIES_QUEUE,
		ASSISTANT_DRAFT_QUEUE
	]) {
		await boss.deleteQueue(queue);
	}
	for (const b of bosses) await b.stop({ graceful: false });
	await pool.end();
});

describe('assistant queue policy', () => {
	it('holds one unfinished job per key, and takes a new one once it is done', async () => {
		const first = await boss.send(QUEUE, {}, { singletonKey: 'u1' });
		expect(first).toBeTruthy();
		expect(await boss.send(QUEUE, {}, { singletonKey: 'u1' })).toBeNull();
		expect(await boss.send(QUEUE, {}, { singletonKey: 'arc:c1' })).toBeTruthy();

		// Running counts as unfinished too.
		const running = await boss.fetch(QUEUE, { batchSize: 2 });
		expect(running).toHaveLength(2);
		expect(await boss.send(QUEUE, {}, { singletonKey: 'u1' })).toBeNull();
		await boss.complete(
			QUEUE,
			running.map((j) => j.id)
		);
		expect(await boss.send(QUEUE, {}, { singletonKey: 'u1' })).toBeTruthy();
	});

	it('coalesces a repeat review of the same scope into the queued one', async () => {
		const input = { userId: 'u1', storyId: 's1', categories: [] };
		const first = await jobs.queueAssistantReview(input);
		expect(first).toEqual(expect.any(String));
		expect(first).not.toBe('coalesced');

		expect(await jobs.queueAssistantReview(input)).toBe('coalesced');
		expect(await unfinished(ASSISTANT_REVIEW_QUEUE)).toBe(1);

		// Another scope is its own job.
		await jobs.queueAssistantReview({ ...input, chapterId: 'c1' });
		expect(await unfinished(ASSISTANT_REVIEW_QUEUE)).toBe(2);

		// So is a copyedit of the same story for other categories: it checks
		// different things, and would otherwise never run.
		const prose = await jobs.queueAssistantReview({ ...input, categories: ['prose'] });
		expect(prose).toEqual(expect.any(String));
		expect(prose).not.toBe('coalesced');
		expect(await unfinished(ASSISTANT_REVIEW_QUEUE)).toBe(3);
		await boss.deleteAllJobs(ASSISTANT_REVIEW_QUEUE);
	});

	it('keeps holding the key while a failed job waits to be retried', async () => {
		await boss.deleteAllJobs(QUEUE);
		const first = await boss.send(QUEUE, {}, { singletonKey: 'retry-key', retryLimit: 1 });
		const [job] = await boss.fetch(QUEUE);
		expect(job.id).toBe(first);
		await boss.fail(QUEUE, job.id);
		const { rows } = await pool.query(`select state from pgboss.job where id = $1`, [first]);
		expect(rows[0].state).toBe('retry');

		expect(await boss.send(QUEUE, {}, { singletonKey: 'retry-key' })).toBeNull();
	});

	it('coalesces a repeat summary pass of the same story into the queued one', async () => {
		const input = { userId: 'u1', storyId: 's1' };
		const first = await jobs.queueAssistantSummaries(input);
		expect(first).toEqual(expect.any(String));
		expect(first).not.toBe('coalesced');

		expect(await jobs.queueAssistantSummaries(input)).toBe('coalesced');
		expect(await unfinished(ASSISTANT_SUMMARIES_QUEUE)).toBe(1);

		// Once the pass is done, the writer can ask for another.
		await boss.fetch(ASSISTANT_SUMMARIES_QUEUE);
		await boss.complete(ASSISTANT_SUMMARIES_QUEUE, first as string);
		expect(await jobs.queueAssistantSummaries(input)).toEqual(expect.any(String));
	});

	it('holds one unfinished draft per scene, and reads how its job ended', async () => {
		const data = { userId: 'u1', storyId: 's1', sceneId: 'scene-1', draftId: 'd1' };
		const input = { ...data, jobId: randomUUID() };
		// A job the queue has never seen is told apart from one that finished.
		expect(await jobs.assistantDraftJobState(input.jobId)).toBe('missing');
		// The job takes the id the draft's row was written with.
		const first = await jobs.queueAssistantDraft(input);
		expect(first).toBe(input.jobId);
		expect((await boss.getJobById(ASSISTANT_DRAFT_QUEUE, input.jobId))?.data).toEqual(data);
		expect(await jobs.queueAssistantDraft({ ...input, jobId: randomUUID(), draftId: 'd2' })).toBe(
			'coalesced'
		);
		// Another scene is its own job.
		const other = await jobs.queueAssistantDraft({
			...input,
			jobId: randomUUID(),
			sceneId: 'scene-2'
		});
		expect(other).toEqual(expect.any(String));
		expect(await unfinished(ASSISTANT_DRAFT_QUEUE)).toBe(2);

		expect(await jobs.assistantDraftJobState(first as string)).toBe('running');
		expect(await jobs.getAssistantJobState('draft', first as string)).toBe('running');
		// The writer's Stop is told apart from a job that failed.
		await boss.cancel(ASSISTANT_DRAFT_QUEUE, first as string);
		expect(await jobs.assistantDraftJobState(first as string)).toBe('stopped');
		expect(await jobs.getAssistantJobState('draft', first as string)).toBe('failed');
		// Stopping frees the scene for a new draft.
		expect(await jobs.queueAssistantDraft({ ...input, jobId: randomUUID() })).toEqual(
			expect.any(String)
		);

		const [running] = await boss.fetch(ASSISTANT_DRAFT_QUEUE);
		await boss.complete(ASSISTANT_DRAFT_QUEUE, running.id, { failed: true });
		expect(await jobs.assistantDraftJobState(running.id)).toBe('failed');
		await boss.deleteAllJobs(ASSISTANT_DRAFT_QUEUE);
	});

	it('holds one unfinished chapter draft per chapter, beside the scene drafts', async () => {
		const data = {
			userId: 'u1',
			storyId: 's1',
			chapterId: 'chapter-1',
			draftIds: ['d1', 'd2'],
			brief: 'The chapter.'
		};
		const input = { ...data, jobId: randomUUID() };
		const first = await jobs.queueAssistantChapterDraft(input);
		expect(first).toBe(input.jobId);
		expect(
			await jobs.queueAssistantChapterDraft({ ...input, jobId: randomUUID(), draftIds: ['d3'] })
		).toBe('coalesced');
		expect(
			await jobs.queueAssistantChapterDraft({
				...input,
				jobId: randomUUID(),
				chapterId: 'chapter-2'
			})
		).toEqual(expect.any(String));
		// A scene draft is keyed by its scene, so it queues alongside.
		expect(
			await jobs.queueAssistantDraft({
				jobId: randomUUID(),
				userId: 'u1',
				storyId: 's1',
				sceneId: 'scene-9',
				draftId: 'd9'
			})
		).toEqual(expect.any(String));
		expect(await unfinished(ASSISTANT_DRAFT_QUEUE)).toBe(3);
		expect(await jobs.assistantDraftJobState(first as string)).toBe('running');
		const queued = await boss.getJobById(ASSISTANT_DRAFT_QUEUE, first as string);
		expect(queued?.data).toEqual(data);
		await boss.deleteAllJobs(ASSISTANT_DRAFT_QUEUE);
	});

	it('reads the state of a job queued on the old review queue before the upgrade', async () => {
		await boss.createQueue(LEGACY_ASSISTANT_REVIEW_QUEUE);
		const id = await boss.send(
			LEGACY_ASSISTANT_REVIEW_QUEUE,
			{ userId: 'u1', storyId: 's1' },
			{ retryLimit: 0 }
		);
		expect(await jobs.getAssistantJobState('review', id!)).toBe('running');

		await boss.fetch(LEGACY_ASSISTANT_REVIEW_QUEUE);
		await boss.fail(LEGACY_ASSISTANT_REVIEW_QUEUE, id!);
		expect(await jobs.getAssistantJobState('review', id!)).toBe('failed');
		await boss.deleteAllJobs(LEGACY_ASSISTANT_REVIEW_QUEUE);
	});
});
