import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { Readable as ReadableStream } from 'node:stream';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { JobWithMetadata } from 'pg-boss';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import {
	assets,
	notifications,
	reviewComments,
	reviewers,
	reviewInvitations,
	reviewThreads,
	scenes,
	stories,
	universes,
	users
} from '../../src/lib/server/db/schema';
import {
	assetMigrationResult,
	assetMigrationSource,
	saveAssetStorage,
	type AssetConfig,
	type AssetObjectStore
} from '../../src/lib/server/assets';
import { buildReviewerDigest } from '../../src/lib/server/notification-digest';
import { reserveToken, revokeTokens } from '../../src/lib/server/tokens';
import type { EmailMessage } from '../../src/lib/server/email';
import type { StoryReviewResult } from '../../src/lib/server/llm/scene-review';
import type { Database } from '../../src/lib/server/auth';
import { NOTIFICATION_DIGEST_QUEUE } from '../../src/lib/server/queues';
import { createHandlers, type WorkerDeps, type WorkerServices } from '../../src/worker/handlers';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

// The worker's job handlers run here without pg-boss: jobs are plain objects
// and the boss is a stand-in that records what was queued. The Assistant,
// SMTP and the bucket are swapped per test; everything else hits Postgres.

let pool: pg.Pool;
let db: Database;

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
	process.env.APP_SECRET = process.env.APP_SECRET || 'worker-handlers-test-secret';
});

beforeEach(async () => {
	await pool.query(
		'truncate table app_settings, assets, notifications, stories, universes, users cascade'
	);
});

afterAll(async () => {
	await pool.end();
});

type JobState = { state: 'active' | 'retry'; startedOn: Date } | null;

function harness(services: Partial<WorkerServices> = {}, current: JobState = null) {
	const sent: { queue: string; data: unknown }[] = [];
	const boss = {
		async send(queue: string, data: unknown) {
			sent.push({ queue, data });
			return null;
		},
		async getJobById() {
			return current;
		}
	} as unknown as WorkerDeps['boss'];
	const handlers = createHandlers({ db, boss, origin: 'https://codex.test', services });
	return { handlers, sent };
}

const STARTED = new Date('2026-01-01T00:00:00Z');

function job<T>(data: T): JobWithMetadata<T> {
	return {
		id: randomUUID(),
		data,
		signal: new AbortController().signal,
		startedOn: STARTED,
		retryCount: 0,
		retryLimit: 2
	} as JobWithMetadata<T>;
}

async function makeUser(email: string) {
	const [user] = await db
		.insert(users)
		.values({ email, displayName: email.split('@')[0], passwordHash: 'x', role: 'user' })
		.returning();
	return user;
}

async function seedStory() {
	const owner = await makeUser('owner@example.com');
	const [universe] = await db
		.insert(universes)
		.values({ ownerId: owner.id, name: 'Mythos' })
		.returning();
	const [story] = await db
		.insert(stories)
		.values({ universeId: universe.id, ownerId: owner.id, title: 'Halden' })
		.returning();
	return { owner, universe, story };
}

async function titles(userId: string): Promise<string[]> {
	const rows = await db.select().from(notifications).where(eq(notifications.userId, userId));
	return rows.map((row) => (row.payload as { title: string }).title);
}

function reviewResult(overrides: Partial<StoryReviewResult>): StoryReviewResult {
	return { reviewed: 3, failed: 0, notes: 0, failures: [], total: 3, ...overrides };
}

function neverCalled(): never {
	throw new Error('the Assistant was called for a run that should have been skipped');
}

describe('assistant jobs re-check ownership at run time', () => {
	it('skips a story review once the story has changed hands', async () => {
		const { owner, story } = await seedStory();
		const other = await makeUser('other@example.com');
		await db.update(stories).set({ ownerId: other.id }).where(eq(stories.id, story.id));
		const { handlers } = harness({ reviewStoryScenes: neverCalled });

		await handlers.assistantReview([job({ userId: owner.id, storyId: story.id })]);

		expect(await titles(owner.id)).toEqual([]);
	});

	it('skips a story review once the story is gone', async () => {
		const { owner, story } = await seedStory();
		await db.delete(stories).where(eq(stories.id, story.id));
		const { handlers } = harness({ reviewStoryContinuity: neverCalled });

		await handlers.assistantReview([
			job({ userId: owner.id, storyId: story.id, mode: 'continuity' as const })
		]);

		expect(await titles(owner.id)).toEqual([]);
	});

	it('skips a universe continuity pass for someone who does not own the universe', async () => {
		const { universe } = await seedStory();
		const other = await makeUser('other@example.com');
		const { handlers } = harness({ reviewUniverseContinuity: neverCalled });

		await handlers.assistantReview([
			job({ userId: other.id, universeId: universe.id, mode: 'continuity' as const })
		]);

		expect(await titles(other.id)).toEqual([]);
	});

	it('skips summaries for someone who does not own the story', async () => {
		const { story } = await seedStory();
		const other = await makeUser('other@example.com');
		const { handlers } = harness({ summariseStory: neverCalled });

		await handlers.assistantSummaries([job({ userId: other.id, storyId: story.id })]);

		expect(await titles(other.id)).toEqual([]);
	});
});

describe('assistant review notices', () => {
	async function reviewTitle(outcome: () => Promise<StoryReviewResult>): Promise<string> {
		const { owner, story } = await seedStory();
		const { handlers } = harness({ reviewStoryScenes: outcome });
		await handlers.assistantReview([job({ userId: owner.id, storyId: story.id })]);
		const [title] = await titles(owner.id);
		return title;
	}

	it('says where a capped run stopped and what it spent', async () => {
		const title = await reviewTitle(async () =>
			reviewResult({ reviewed: 2, total: 5, notes: 3, capped: true, spentUsd: 1.5 })
		);
		expect(title).toBe(
			'The review of "Halden" stopped after 2 of 5 scenes at about $1.50. Raise the cap in settings or run the review again to continue.'
		);
	});

	it('says an aborted run was stopped', async () => {
		const title = await reviewTitle(async () => reviewResult({ reviewed: 1, aborted: true }));
		expect(title).toBe('The review of "Halden" was stopped before it finished.');
	});

	it('names the problem when every scene failed', async () => {
		const title = await reviewTitle(async () =>
			reviewResult({
				reviewed: 0,
				failed: 3,
				failures: [{ message: 'The endpoint did not answer.' }]
			})
		);
		expect(title).toBe('The Assistant could not review "Halden": The endpoint did not answer.');
	});

	it('counts the failed scenes after a partly successful run', async () => {
		const title = await reviewTitle(async () =>
			reviewResult({
				reviewed: 2,
				failed: 1,
				notes: 1,
				failures: [{ message: 'The endpoint did not answer.' }]
			})
		);
		expect(title).toBe(
			'The Assistant left 1 note on "Halden". 1 scene failed: The endpoint did not answer.'
		);
	});

	it('still tells the writer when the review throws', async () => {
		const title = await reviewTitle(async () => {
			throw new Error('No Assistant endpoint is configured.');
		});
		expect(title).toBe(
			'The Assistant could not review "Halden": No Assistant endpoint is configured.'
		);
	});

	it('words a capped story continuity pass with the notes it left', async () => {
		const { owner, story } = await seedStory();
		const { handlers } = harness({
			reviewStoryContinuity: async () => ({
				scenes: 4,
				notes: 2,
				ran: true,
				capped: true,
				spentUsd: 0.25
			})
		});
		await handlers.assistantReview([
			job({ userId: owner.id, storyId: story.id, mode: 'continuity' as const })
		]);
		expect(await titles(owner.id)).toEqual([
			'The continuity pass on "Halden" stopped at about $0.25, with 2 notes left. Raise the cap in settings or run the review again to continue.'
		]);
	});

	it('tells the writer when summaries could not be written', async () => {
		const { owner, story } = await seedStory();
		const { handlers } = harness({
			summariseStory: async () => ({ scenes: 0, chapters: 0, failed: 2 })
		});
		await handlers.assistantSummaries([job({ userId: owner.id, storyId: story.id })]);
		expect(await titles(owner.id)).toEqual([
			'The Assistant could not summarise "Halden". Check the endpoint in your settings.'
		]);
	});

	it('says where a capped summaries run stopped and what it spent', async () => {
		const { owner, story } = await seedStory();
		const { handlers } = harness({
			summariseStory: async () => ({
				scenes: 2,
				chapters: 1,
				failed: 0,
				capped: true,
				spentUsd: 0.4,
				capNotApplied: 'The cap could not be checked.'
			})
		});
		await handlers.assistantSummaries([job({ userId: owner.id, storyId: story.id })]);
		expect(await titles(owner.id)).toEqual([
			'The Assistant stopped summarising "Halden" at about $0.40, after 3 summaries. Raise the cap in settings or run it again to continue. The cap could not be checked.'
		]);
	});

	it('leaves the notice to the retry when pg-boss has already re-queued the job', async () => {
		const { owner, story } = await seedStory();
		const { handlers, sent } = harness(
			{ reviewStoryScenes: async () => reviewResult({ notes: 1 }) },
			{ state: 'retry', startedOn: STARTED }
		);
		await handlers.assistantReview([job({ userId: owner.id, storyId: story.id })]);
		expect(await titles(owner.id)).toEqual([]);
		expect(sent).toEqual([]);
	});

	it('queues the owner digest alongside the notice', async () => {
		const { owner, story } = await seedStory();
		const { handlers, sent } = harness({
			reviewStoryScenes: async () => reviewResult({ notes: 1 })
		});
		await handlers.assistantReview([job({ userId: owner.id, storyId: story.id })]);
		expect(await titles(owner.id)).toEqual(['The Assistant left 1 note on "Halden".']);
		expect(sent).toEqual([{ queue: NOTIFICATION_DIGEST_QUEUE, data: { userId: owner.id } }]);
	});
});

describe('the email queue', () => {
	function recordingSend() {
		const messages: EmailMessage[] = [];
		const sendEmail = async (_db: Database, message: EmailMessage) => {
			messages.push(message);
		};
		return { messages, sendEmail };
	}

	it('writes the link into a token email at send time', async () => {
		const me = await makeUser('me@example.com');
		const tokenId = await reserveToken(db, me.id, 'password_reset', 60);
		const { messages, sendEmail } = recordingSend();
		const { handlers } = harness({ sendEmail });

		await handlers.email([job({ tokenId, to: me.email, origin: 'https://codex.test' })]);

		expect(messages).toHaveLength(1);
		expect(messages[0].to).toBe(me.email);
		expect(messages[0].text).toMatch(/https:\/\/codex\.test\/reset-password\?token=\S+/);
	});

	it('does not send a token email whose link was revoked', async () => {
		const me = await makeUser('me@example.com');
		const tokenId = await reserveToken(db, me.id, 'email_change', 60);
		await revokeTokens(db, me.id, 'email_change');
		const { messages, sendEmail } = recordingSend();
		const { handlers } = harness({ sendEmail });

		await handlers.email([job({ tokenId, to: me.email, origin: 'https://codex.test' })]);

		expect(messages).toEqual([]);
	});

	it('sends a finished message as it is', async () => {
		const message = { to: 'me@example.com', subject: 'Hi', text: 'Body' };
		const { messages, sendEmail } = recordingSend();
		const { handlers } = harness({ sendEmail });

		await handlers.email([job(message)]);

		expect(messages).toEqual([message]);
	});
});

describe('digests are marked before they are sent', () => {
	const failingSend = async () => {
		throw new Error('SMTP is down');
	};

	it('does not resend a user digest on retry after a failed send', async () => {
		const me = await makeUser('me@example.com');
		await db.insert(notifications).values({
			userId: me.id,
			kind: 'review_activity',
			payload: { title: 'Maren commented on "Halden"' },
			emailWanted: true
		});

		const failing = harness({ sendEmail: failingSend });
		await expect(failing.handlers.notificationDigest([job({ userId: me.id })])).rejects.toThrow(
			'SMTP is down'
		);

		let sends = 0;
		const retry = harness({
			sendEmail: async () => {
				sends += 1;
			}
		});
		await retry.handlers.notificationDigest([job({ userId: me.id })]);
		expect(sends).toBe(0);
	});

	it('advances the reviewer watermark even when the send fails', async () => {
		const { owner, story } = await seedStory();
		const [scene] = await db
			.insert(scenes)
			.values({ storyId: story.id, globalPosition: 1, bodyMd: 'Text.' })
			.returning();
		const [invitation] = await db
			.insert(reviewInvitations)
			.values({ storyId: story.id, createdBy: owner.id, tokenHash: 'hash' })
			.returning();
		const [guest] = await db
			.insert(reviewers)
			.values({ invitationId: invitation.id, displayName: 'Maren', email: 'maren@example.com' })
			.returning();
		const [thread] = await db
			.insert(reviewThreads)
			.values({ storyId: story.id, sceneId: scene.id })
			.returning();
		await db.insert(reviewComments).values([
			{ threadId: thread.id, authorReviewerId: guest.id, bodyMd: 'Pacing drags.' },
			{ threadId: thread.id, authorUserId: owner.id, bodyMd: 'Will tighten.' }
		]);
		expect(await buildReviewerDigest(db, guest.id, 'https://codex.test')).not.toBeNull();

		const { handlers } = harness({ sendEmail: failingSend });
		await expect(handlers.reviewerDigest([job({ reviewerId: guest.id })])).rejects.toThrow(
			'SMTP is down'
		);

		expect(await buildReviewerDigest(db, guest.id, 'https://codex.test')).toBeNull();
	});
});

describe('asset migration', () => {
	const STORAGE = {
		endpoint: 'https://s3.example.test',
		region: 'eu-1',
		bucket: 'bucket-a',
		prefix: 'codex-assets',
		accessKeyId: 'key-id',
		secretAccessKey: 'very-secret'
	};

	// One in-memory bucket per configured bucket name.
	function memoryBuckets(seed: Record<string, Record<string, string>>) {
		const buckets = new Map<string, Map<string, Buffer>>();
		for (const [name, objects] of Object.entries(seed)) {
			buckets.set(name, new Map(Object.entries(objects).map(([k, v]) => [k, Buffer.from(v)])));
		}
		const store = (config: AssetConfig): AssetObjectStore => {
			if (!buckets.has(config.bucket)) buckets.set(config.bucket, new Map());
			const objects = buckets.get(config.bucket)!;
			return {
				async put(key, body) {
					objects.set(key, body);
				},
				async upload(key, body) {
					const parts: Buffer[] = [];
					for await (const chunk of body) parts.push(Buffer.from(chunk));
					objects.set(key, Buffer.concat(parts));
				},
				async get(key): Promise<Readable> {
					const body = objects.get(key);
					if (!body) throw new Error(`missing object: ${key}`);
					return ReadableStream.from(body);
				},
				async remove(key) {
					objects.delete(key);
				}
			};
		};
		return { buckets, store };
	}

	async function stashMove() {
		const owner = await makeUser('o@example.com');
		for (const key of ['codex-assets/one', 'codex-assets/two']) {
			await db.insert(assets).values({
				ownerId: owner.id,
				universeId: null,
				kind: 'inline',
				filename: 'pic.png',
				contentType: 'image/png',
				byteSize: 3,
				storageKey: key
			});
		}
		await saveAssetStorage(db, STORAGE);
		await saveAssetStorage(db, { ...STORAGE, bucket: 'bucket-b' });
		expect(await assetMigrationSource(db)).not.toBeNull();
	}

	it('keeps the stashed source when any object failed to copy', async () => {
		await stashMove();
		const { store } = memoryBuckets({ 'bucket-a': { 'codex-assets/one': 'one' } });
		const { handlers } = harness({ s3AssetStore: store });

		await handlers.migrateAssets();

		expect(await assetMigrationResult(db)).toMatchObject({ copied: 1, failed: 1 });
		expect(await assetMigrationSource(db)).not.toBeNull();
	});

	it('clears the stashed source once everything copied', async () => {
		await stashMove();
		const { buckets, store } = memoryBuckets({
			'bucket-a': { 'codex-assets/one': 'one', 'codex-assets/two': 'two' }
		});
		const { handlers } = harness({ s3AssetStore: store });

		await handlers.migrateAssets();

		expect(await assetMigrationResult(db)).toMatchObject({ copied: 2, failed: 0 });
		expect(await assetMigrationSource(db)).toBeNull();
		expect([...buckets.get('bucket-b')!.keys()].sort()).toEqual([
			'codex-assets/one',
			'codex-assets/two'
		]);
	});
});

describe('trash purge', () => {
	const longAgo = () => new Date(Date.now() - 365 * 86_400_000);

	it('purges trashed stories past their window and keeps recent ones', async () => {
		const { owner, universe, story: old } = await seedStory();
		const [recent] = await db
			.insert(stories)
			.values({
				universeId: universe.id,
				ownerId: owner.id,
				title: 'Recent',
				deletedAt: new Date()
			})
			.returning();
		const [live] = await db
			.insert(stories)
			.values({ universeId: universe.id, ownerId: owner.id, title: 'Live' })
			.returning();
		await db.update(stories).set({ deletedAt: longAgo() }).where(eq(stories.id, old.id));
		const { handlers } = harness();

		await handlers.purgeUniverses();

		const left = await db.select({ id: stories.id }).from(stories);
		expect(left.map((row) => row.id).sort()).toEqual([recent.id, live.id].sort());
	});

	it('purges a universe past its window with every story inside', async () => {
		const { universe } = await seedStory();
		await db.update(universes).set({ deletedAt: longAgo() }).where(eq(universes.id, universe.id));
		const { handlers } = harness();

		await handlers.purgeUniverses();

		expect(await db.select().from(universes)).toEqual([]);
		expect(await db.select().from(stories)).toEqual([]);
	});
});
