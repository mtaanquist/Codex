import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
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
	characters,
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
import {
	LEGACY_ASSISTANT_REVIEW_QUEUE,
	NOTIFICATION_DIGEST_QUEUE
} from '../../src/lib/server/queues';
import { createHandlers, type WorkerDeps, type WorkerServices } from '../../src/worker/handlers';
import {
	AssistantDisabledError,
	NoModelError,
	ReplyCutOffError,
	ReplyRefusedError
} from '../../src/lib/server/llm/gateway';
import { EndpointReplyError, stoppedByWriter } from '../../src/lib/server/llm/providers/types';
import { ReviewRunLoadError } from '../../src/lib/server/review-runs';
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

type JobState = { state: 'active' | 'retry' | 'cancelled'; startedOn: Date } | null;

function harness(services: Partial<WorkerServices> = {}, current: JobState = null) {
	const sent: { queue: string; data: unknown }[] = [];
	const completed: { id: string; data: unknown }[] = [];
	const boss = {
		async complete(_queue: string, id: string, data: unknown) {
			completed.push({ id, data });
			return null;
		},
		async send(queue: string, data: unknown) {
			sent.push({ queue, data });
			return null;
		},
		async getJobById() {
			return current;
		}
	} as unknown as WorkerDeps['boss'];
	const handlers = createHandlers({ db, boss, origin: 'https://codex.test', services });
	return { handlers, sent, completed };
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

describe('assistant jobs skip trashed work', () => {
	async function trash(table: typeof stories | typeof universes, id: string) {
		await db.update(table).set({ deletedAt: new Date() }).where(eq(table.id, id));
	}

	it('skips a story review once the story is in the trash', async () => {
		const { owner, story } = await seedStory();
		await trash(stories, story.id);
		const { handlers } = harness({ reviewStoryScenes: neverCalled });

		await handlers.assistantReview([job({ userId: owner.id, storyId: story.id })]);

		expect(await titles(owner.id)).toEqual([]);
	});

	it("skips summaries once the story's universe is in the trash", async () => {
		const { owner, universe, story } = await seedStory();
		await trash(universes, universe.id);
		const { handlers } = harness({ summariseStory: neverCalled });

		await handlers.assistantSummaries([job({ userId: owner.id, storyId: story.id })]);

		expect(await titles(owner.id)).toEqual([]);
	});

	it('skips an enrichment pass once the universe is in the trash, or for someone else', async () => {
		const { owner, universe } = await seedStory();
		const other = await makeUser('other-enrich@example.com');
		const { handlers } = harness({ enrichUniverse: neverCalled });

		await handlers.assistantEnrich([job({ userId: other.id, universeId: universe.id })]);
		await trash(universes, universe.id);
		await handlers.assistantEnrich([job({ userId: owner.id, universeId: universe.id })]);

		expect(await titles(owner.id)).toEqual([]);
		expect(await titles(other.id)).toEqual([]);
	});

	it('skips a universe continuity pass once the universe is in the trash', async () => {
		const { owner, universe } = await seedStory();
		await trash(universes, universe.id);
		const { handlers } = harness({ reviewUniverseContinuity: neverCalled });

		await handlers.assistantReview([
			job({ userId: owner.id, universeId: universe.id, mode: 'continuity' as const })
		]);

		expect(await titles(owner.id)).toEqual([]);
	});
});

async function hrefs(userId: string): Promise<string[]> {
	const rows = await db.select().from(notifications).where(eq(notifications.userId, userId));
	return rows.map((row) => (row.payload as { href: string }).href);
}

describe('assistant notices link by id', () => {
	it('links a story review and summaries to the story id, not its slug', async () => {
		const { owner, story } = await seedStory();
		const { handlers } = harness({
			reviewStoryScenes: async () => reviewResult({}),
			summariseStory: async () => ({ scenes: 1, chapters: 0, failed: 0 })
		});

		await handlers.assistantReview([job({ userId: owner.id, storyId: story.id })]);
		await handlers.assistantSummaries([job({ userId: owner.id, storyId: story.id })]);

		expect((await hrefs(owner.id)).sort()).toEqual(
			[`/stories/${story.id}/review`, `/stories/${story.id}`].sort()
		);
	});

	it('links a character arc to the character in the universe Plan', async () => {
		const { owner, universe } = await seedStory();
		const [character] = await db
			.insert(characters)
			.values({ universeId: universe.id, ownerId: owner.id, name: 'Bram' })
			.returning({ id: characters.id });
		const { handlers } = harness({
			summariseCharacterArc: async () => ({ outcome: 'written' as const }),
			enrichUniverse: neverCalled
		});

		await handlers.assistantEnrich([
			job({ userId: owner.id, universeId: universe.id, characterId: character.id })
		]);

		expect(await hrefs(owner.id)).toEqual([
			`/universes/${universe.id}/plan?entity=${character.id}`
		]);
		expect(await titles(owner.id)).toEqual(['The Assistant wrote the arc for Bram.']);
	});

	it('tells the writer when an arc could not be written, on the last attempt only', async () => {
		const { owner, universe } = await seedStory();
		const [character] = await db
			.insert(characters)
			.values({ universeId: universe.id, ownerId: owner.id, name: 'Bram' })
			.returning({ id: characters.id });
		// Still active while the handler runs, as in pg-boss when a handler throws.
		const { handlers } = harness(
			{
				summariseCharacterArc: async () => {
					throw new Error('endpoint down');
				}
			},
			{ state: 'active', startedOn: STARTED }
		);
		const data = { userId: owner.id, universeId: universe.id, characterId: character.id };

		// Thrown so pg-boss retries, with nothing said yet.
		await expect(handlers.assistantEnrich([job(data)])).rejects.toThrow('endpoint down');
		expect(await titles(owner.id)).toEqual([]);

		// The job fails, so the activity card shows it did not work.
		const last = { ...job(data), retryCount: 2 };
		await expect(handlers.assistantEnrich([last])).rejects.toThrow('endpoint down');
		expect(await titles(owner.id)).toEqual([
			'The Assistant could not write the arc for Bram. Check the endpoint in your settings.'
		]);
	});

	it('says no model is chosen when that stopped an arc, without retrying', async () => {
		const { owner, universe } = await seedStory();
		const [character] = await db
			.insert(characters)
			.values({ universeId: universe.id, ownerId: owner.id, name: 'Bram' })
			.returning({ id: characters.id });
		const { handlers, completed } = harness({
			summariseCharacterArc: async () => {
				throw new NoModelError();
			}
		});

		await handlers.assistantEnrich([
			job({ userId: owner.id, universeId: universe.id, characterId: character.id })
		]);

		expect(await titles(owner.id)).toEqual([
			"No model is chosen for the Assistant, so it did not write the arc for Bram. Pick one under Account, Assistant, Models per role, then try again from the character's entry in Plan."
		]);
		expect(completed.map((c) => c.data)).toEqual([{ failed: true }]);
	});

	it('says why when an arc was cut off at the reply limit, without retrying', async () => {
		const { owner, universe } = await seedStory();
		const [character] = await db
			.insert(characters)
			.values({ universeId: universe.id, ownerId: owner.id, name: 'Bram' })
			.returning({ id: characters.id });
		const { handlers, completed } = harness({
			summariseCharacterArc: async () => {
				throw new ReplyCutOffError('The arc was cut off at the reply limit.');
			}
		});

		// Resolves, so pg-boss does not run the same cut-off again.
		await handlers.assistantEnrich([
			job({ userId: owner.id, universeId: universe.id, characterId: character.id })
		]);

		expect(await titles(owner.id)).toEqual([
			'The Assistant could not write the arc for Bram. The arc was cut off at the reply limit.'
		]);
		// Settled as failed for the activity card.
		expect(completed.map((c) => c.data)).toEqual([{ failed: true }]);
	});

	it("passes a writer's Stop on to the Assistant's requests as a writer stop", async () => {
		const { owner, universe } = await seedStory();
		const [character] = await db
			.insert(characters)
			.values({ universeId: universe.id, ownerId: owner.id, name: 'Bram' })
			.returning({ id: characters.id });
		const controller = new AbortController();
		let seen: AbortSignal | undefined;
		const { handlers } = harness(
			{
				summariseCharacterArc: async (_db, opts) => {
					seen = opts.signal;
					controller.abort();
					await new Promise<void>((resolve) =>
						opts.signal?.addEventListener('abort', () => resolve())
					);
					return { outcome: 'written' as const };
				}
			},
			{ state: 'cancelled', startedOn: STARTED }
		);

		await handlers.assistantEnrich([
			{
				...job({ userId: owner.id, universeId: universe.id, characterId: character.id }),
				signal: controller.signal
			}
		]);

		expect(seen && stoppedByWriter(seen)).toBe(true);
	});

	it('says the model declined an arc, without retrying', async () => {
		const { owner, universe } = await seedStory();
		const [character] = await db
			.insert(characters)
			.values({ universeId: universe.id, ownerId: owner.id, name: 'Bram' })
			.returning({ id: characters.id });
		const { handlers, completed } = harness({
			summariseCharacterArc: async () => {
				throw new ReplyRefusedError();
			}
		});

		// Resolves on the first attempt: a retry would be declined, and billed, again.
		await handlers.assistantEnrich([
			job({ userId: owner.id, universeId: universe.id, characterId: character.id })
		]);

		expect(await titles(owner.id)).toEqual([
			'The model declined to write the arc for Bram, so nothing was saved.'
		]);
		expect(completed.map((c) => c.data)).toEqual([{ failed: true }]);
	});

	it('ends an arc job without retrying when the endpoint sends something other than a reply (#1105)', async () => {
		const { owner, universe } = await seedStory();
		const [character] = await db
			.insert(characters)
			.values({ universeId: universe.id, ownerId: owner.id, name: 'Bram' })
			.returning({ id: characters.id });
		const { handlers, completed } = harness({
			summariseCharacterArc: async () => {
				throw new EndpointReplyError('The endpoint answered with text/html instead of a reply.');
			}
		});

		await handlers.assistantEnrich([
			job({ userId: owner.id, universeId: universe.id, characterId: character.id })
		]);

		expect(await titles(owner.id)).toEqual([
			"The Assistant could not write the arc for Bram: the endpoint did not send a reply. Check the endpoint in your settings, then try again from the character's entry in Plan."
		]);
		expect(completed.map((c) => c.data)).toEqual([{ failed: true }]);
	});

	it('says an arc job stopped at the spend cap (#1105)', async () => {
		const { owner, universe } = await seedStory();
		const [character] = await db
			.insert(characters)
			.values({ universeId: universe.id, ownerId: owner.id, name: 'Bram' })
			.returning({ id: characters.id });
		const { handlers } = harness({
			summariseCharacterArc: async () => ({ outcome: 'capped' as const, spentUsd: 1.25 })
		});

		await handlers.assistantEnrich([
			job({ userId: owner.id, universeId: universe.id, characterId: character.id })
		]);

		expect(await titles(owner.id)).toEqual([
			"The Assistant did not write the arc for Bram: this job reached the spend cap at about $1.25. Raise the cap in settings, then try again from the character's entry in Plan."
		]);
	});

	it('ends an arc job without retrying when the Assistant is turned off', async () => {
		const { owner, universe } = await seedStory();
		const [character] = await db
			.insert(characters)
			.values({ universeId: universe.id, ownerId: owner.id, name: 'Bram' })
			.returning({ id: characters.id });
		const { handlers, completed } = harness({
			summariseCharacterArc: async () => {
				throw new AssistantDisabledError();
			}
		});

		await handlers.assistantEnrich([
			job({ userId: owner.id, universeId: universe.id, characterId: character.id })
		]);

		expect(await titles(owner.id)).toEqual([
			"The Assistant is turned off, so it did not write the arc for Bram. Switch it back on in your settings, then try again from the character's entry in Plan."
		]);
		expect(completed.map((c) => c.data)).toEqual([{ failed: true }]);
	});

	it('words a pass that stopped early before leaving anything', async () => {
		const { owner, universe } = await seedStory();
		const { handlers } = harness({
			enrichUniverse: async () => ({ entities: 0, staged: 0, failed: 0, disabled: true })
		});

		await handlers.assistantEnrich([job({ userId: owner.id, universeId: universe.id })]);

		expect(await titles(owner.id)).toEqual([
			'The Assistant is turned off, so it stopped reading the entries in "Mythos". Switch it back on in your settings, then type /enrich to carry on.'
		]);
	});

	it('counts the entries that failed in a pass that read others', async () => {
		const { owner, universe } = await seedStory();
		const { handlers } = harness({
			enrichUniverse: async () => ({
				entities: 3,
				staged: 2,
				failed: 3,
				cutOff: 'The suggestions were cut off at the reply limit.',
				cutOffs: 1
			})
		});

		await handlers.assistantEnrich([job({ userId: owner.id, universeId: universe.id })]);

		expect(await titles(owner.id)).toEqual([
			'The Assistant left 2 suggestions on the entries in "Mythos". Open an entry in Plan to accept or reject them. 1 entry could not be read: The suggestions were cut off at the reply limit. 2 other entries could not be read. Check the endpoint in your settings.'
		]);
	});

	it('says why a pass stopped after failing several entries in a row', async () => {
		const { owner, universe } = await seedStory();
		const { handlers } = harness({
			enrichUniverse: async () => ({ entities: 1, staged: 1, failed: 3, stoppedFailing: true })
		});

		await handlers.assistantEnrich([job({ userId: owner.id, universeId: universe.id })]);

		expect(await titles(owner.id)).toEqual([
			'The Assistant stopped reading the entries in "Mythos" after 3 in a row could not be read, with 1 suggestion left. Check the endpoint in your settings, then type /enrich to carry on.'
		]);
	});

	it('says the Assistant is turned off when that stopped a pass', async () => {
		const { owner, universe } = await seedStory();
		const { handlers } = harness({
			enrichUniverse: async () => ({ entities: 1, staged: 2, failed: 0, disabled: true })
		});

		await handlers.assistantEnrich([job({ userId: owner.id, universeId: universe.id })]);

		expect(await titles(owner.id)).toEqual([
			'The Assistant is turned off, so it stopped reading the entries in "Mythos", with 2 suggestions left. Switch it back on in your settings, then type /enrich to carry on.'
		]);
	});

	it('says no model is chosen when that stopped a pass', async () => {
		const { owner, universe } = await seedStory();
		const { handlers } = harness({
			enrichUniverse: async () => ({ entities: 1, staged: 2, failed: 0, noModel: true })
		});

		await handlers.assistantEnrich([job({ userId: owner.id, universeId: universe.id })]);

		expect(await titles(owner.id)).toEqual([
			'No model is chosen for the Assistant, so it stopped reading the entries in "Mythos", with 2 suggestions left. Pick one under Account, Assistant, Models per role, then type /enrich to carry on.'
		]);
	});

	// The activity card reads a job completed with a failed output as failed, so
	// a pass that stopped on a problem or read nothing does not show as ready.
	it('settles a pass as failed when it stopped on a problem or could read nothing', async () => {
		const { owner, universe } = await seedStory();
		const stops = [
			{ entities: 1, staged: 2, failed: 0, noModel: true },
			{ entities: 1, staged: 2, failed: 0, disabled: true },
			{ entities: 1, staged: 1, failed: 3, stoppedFailing: true },
			{ entities: 0, staged: 0, failed: 2 }
		];
		for (const stop of stops) {
			const { handlers, completed } = harness({ enrichUniverse: async () => stop });
			await handlers.assistantEnrich([job({ userId: owner.id, universeId: universe.id })]);
			expect(completed.map((c) => c.data)).toEqual([{ failed: true }]);
		}
	});

	it('leaves a pass that finished to settle as done', async () => {
		const { owner, universe } = await seedStory();
		const finished = [
			{ entities: 3, staged: 2, failed: 1 },
			{ entities: 0, unchanged: 2, staged: 0, failed: 1 },
			{ entities: 2, staged: 0, failed: 0 }
		];
		for (const result of finished) {
			const { handlers, completed } = harness({ enrichUniverse: async () => result });
			await handlers.assistantEnrich([job({ userId: owner.id, universeId: universe.id })]);
			expect(completed).toEqual([]);
		}
	});

	it('says why when every entry was cut off at the reply limit', async () => {
		const { owner, universe } = await seedStory();
		const { handlers } = harness({
			enrichUniverse: async () => ({
				entities: 0,
				staged: 0,
				failed: 2,
				cutOff: 'The suggestions were cut off at the reply limit.'
			})
		});

		await handlers.assistantEnrich([job({ userId: owner.id, universeId: universe.id })]);

		expect((await titles(owner.id))[0]).toContain(
			'could not read the entries in "Mythos". The suggestions were cut off at the reply limit.'
		);
	});

	it('does not say it could not read the entries when others were unchanged', async () => {
		const { owner, universe } = await seedStory();
		const { handlers } = harness({
			enrichUniverse: async () => ({ entities: 0, unchanged: 2, staged: 0, failed: 1 })
		});

		await handlers.assistantEnrich([job({ userId: owner.id, universeId: universe.id })]);

		expect(await titles(owner.id)).toEqual([
			'The Assistant found nothing new to suggest for the entries in "Mythos". 1 entry could not be read. Check the endpoint in your settings.'
		]);
	});

	it('links an enrichment pass to the universe Plan by id', async () => {
		const { owner, universe } = await seedStory();
		const { handlers } = harness({
			enrichUniverse: async () => ({ entities: 3, staged: 2, failed: 0 })
		});

		await handlers.assistantEnrich([job({ userId: owner.id, universeId: universe.id })]);

		expect(await hrefs(owner.id)).toEqual([`/universes/${universe.id}/plan`]);
		expect(await titles(owner.id)).toEqual([
			`The Assistant left 2 suggestions on the entries in "${universe.name}". Open an entry in Plan to accept or reject them.`
		]);
	});

	it('links a universe continuity pass to the universe id', async () => {
		const { owner, universe } = await seedStory();
		const { handlers } = harness({
			reviewUniverseContinuity: async () => ({ ran: true, scenes: 2, notes: 0 })
		});

		await handlers.assistantReview([
			job({ userId: owner.id, universeId: universe.id, mode: 'continuity' as const })
		]);

		expect(await hrefs(owner.id)).toEqual([`/universes/${universe.id}/plan`]);
	});
});

describe('a details read for one entry', () => {
	async function seedRead() {
		const { owner, universe, story } = await seedStory();
		const [character] = await db
			.insert(characters)
			.values({ universeId: universe.id, ownerId: owner.id, name: 'Bram' })
			.returning({ id: characters.id });
		const data = {
			userId: owner.id,
			universeId: universe.id,
			read: { entityId: character.id, name: 'Bram', storyId: story.id, mode: 'scenes' as const }
		};
		return { owner, universe, story, character, data };
	}
	const found = (n: number) =>
		Array.from({ length: n }, (_, i) => ({
			id: randomUUID(),
			field: 'alias' as const,
			label: null,
			value: `alias ${i}`
		}));

	it('reads the story it names, as the job, and links to the entry in that story', async () => {
		const { owner, story, character, data } = await seedRead();
		let seen: unknown;
		const { handlers, completed } = harness({
			enrichEntityFromText: async (_db, opts) => {
				seen = opts;
				return { suggestions: found(2), scenes: 4, requests: 1 };
			},
			enrichUniverse: neverCalled,
			summariseCharacterArc: neverCalled
		});
		const queued = job(data);

		await handlers.assistantEnrich([queued]);

		expect(seen).toMatchObject({
			userId: owner.id,
			scope: { storyId: story.id },
			entityId: character.id,
			mode: 'scenes',
			jobId: queued.id
		});
		expect(await titles(owner.id)).toEqual([
			'The Assistant left 2 suggestions for Bram. Open the entry to accept or reject them.'
		]);
		expect(await hrefs(owner.id)).toEqual([`/stories/${story.id}/plan?entity=${character.id}`]);
		expect(completed).toEqual([]);
	});

	it('reads across the universe when no story is named', async () => {
		const { owner, universe, character, data } = await seedRead();
		let scope: unknown;
		const { handlers } = harness({
			enrichEntityFromText: async (_db, opts) => {
				scope = opts.scope;
				return { suggestions: [], scenes: 3, requests: 1 };
			}
		});

		await handlers.assistantEnrich([
			job({ ...data, read: { entityId: character.id, name: 'Bram', mode: 'scenes' as const } })
		]);

		expect(scope).toEqual({ universeId: universe.id });
		expect(await titles(owner.id)).toEqual([
			'The Assistant read 3 scenes and found nothing new to suggest for Bram.'
		]);
		expect(await hrefs(owner.id)).toEqual([
			`/universes/${universe.id}/plan?entity=${character.id}`
		]);
	});

	it('says what a read that stopped partway or at the spend cap left behind', async () => {
		const { owner, data } = await seedRead();
		const results = [
			{ suggestions: found(1), scenes: 9, requests: 2, partial: true },
			{
				suggestions: found(1),
				scenes: 9,
				requests: 2,
				partial: true,
				partialNote: 'Raise Longest reply.'
			},
			{ suggestions: found(3), scenes: 9, requests: 2, capped: true, spentUsd: 1.25 }
		];
		const { handlers } = harness({ enrichEntityFromText: async () => results.shift()! });

		for (let i = 0; i < 3; i++) await handlers.assistantEnrich([job(data)]);

		expect((await titles(owner.id)).sort()).toEqual(
			[
				'The Assistant stopped partway through reading for details about Bram, with 1 suggestion left on the entry. To read the rest, select "Suggest details with the Assistant" on the entry again.',
				'The Assistant stopped partway through reading for details about Bram, with 1 suggestion left on the entry. Raise Longest reply.',
				'The Assistant stopped reading for details about Bram at about $1.25, with 3 suggestions left on the entry. Raise the cap in settings, then select "Suggest details with the Assistant" on the entry again.'
			].sort()
		);
	});

	it("says nothing for an entry that is gone or not the writer's", async () => {
		const { owner, data } = await seedRead();
		const { handlers } = harness({
			enrichEntityFromText: async () => ({
				suggestions: [],
				scenes: 0,
				requests: 0,
				missing: true
			})
		});
		await handlers.assistantEnrich([job(data)]);
		expect(await titles(owner.id)).toEqual([]);
	});

	it('retries a read that failed before finding anything, and reports on the last attempt', async () => {
		const { owner, data } = await seedRead();
		const { handlers } = harness(
			{
				enrichEntityFromText: async () => {
					throw new Error('endpoint down');
				}
			},
			{ state: 'active', startedOn: STARTED }
		);

		await expect(handlers.assistantEnrich([job(data)])).rejects.toThrow('endpoint down');
		expect(await titles(owner.id)).toEqual([]);

		const last = { ...job(data), retryCount: 2 };
		await expect(handlers.assistantEnrich([last])).rejects.toThrow('endpoint down');
		expect(await titles(owner.id)).toEqual([
			'The Assistant could not read for details about Bram. Check the endpoint in your settings.'
		]);
	});

	it('ends without retrying when the reply was cut off, settled as failed', async () => {
		const { owner, data } = await seedRead();
		const { handlers, completed } = harness({
			enrichEntityFromText: async () => {
				throw new ReplyCutOffError('Raise Longest reply.');
			}
		});
		const queued = job(data);

		await handlers.assistantEnrich([queued]);

		expect(completed.map((c) => c.data)).toEqual([{ failed: true }]);
		expect(await titles(owner.id)).toEqual([
			'The Assistant could not read for details about Bram. Raise Longest reply.'
		]);
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

	it('leaves a review that could not read its progress to a retry, and says so on the last attempt (#1113)', async () => {
		const { owner, story } = await seedStory();
		const { handlers } = harness({
			reviewStoryScenes: async () => {
				throw new ReviewRunLoadError(new Error('connection reset'));
			}
		});
		const data = { userId: owner.id, storyId: story.id };

		await expect(handlers.assistantReview([job(data)])).rejects.toBeInstanceOf(ReviewRunLoadError);
		expect(await titles(owner.id)).toEqual([]);

		await handlers.assistantReview([{ ...job(data), retryCount: 2 }]);
		expect(await titles(owner.id)).toEqual([
			'The Assistant could not review "Halden": Could not read the earlier progress of this review. Try again in a moment.'
		]);
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

	it('says a summaries run was stopped (#1045)', async () => {
		const { owner, story } = await seedStory();
		const { handlers } = harness({
			summariseStory: async () => ({ scenes: 1, chapters: 0, failed: 1, aborted: true })
		});
		await handlers.assistantSummaries([job({ userId: owner.id, storyId: story.id })]);
		expect(await titles(owner.id)).toEqual([
			'The Assistant stopped summarising "Halden" before it finished, after 1 summary.'
		]);
	});

	it('says so when every summary changed while it was being written', async () => {
		const { owner, story } = await seedStory();
		const { handlers } = harness({
			summariseStory: async () => ({ scenes: 0, chapters: 0, failed: 0, changed: 2 })
		});
		await handlers.assistantSummaries([job({ userId: owner.id, storyId: story.id })]);
		expect(await titles(owner.id)).toEqual([
			'"Halden" changed while the Assistant was summarising it, so nothing was saved. Run it again to bring the summaries up to date.'
		]);
	});

	it('stops a summaries run with no model chosen and settles it as failed', async () => {
		const { owner, story } = await seedStory();
		const { handlers, completed } = harness({
			summariseStory: async () => ({ scenes: 1, chapters: 0, failed: 0, noModel: true })
		});
		await handlers.assistantSummaries([job({ userId: owner.id, storyId: story.id })]);
		expect(await titles(owner.id)).toEqual([
			'No model is chosen for the Assistant, so it stopped summarising "Halden", after 1 summary. Pick one under Account, Assistant, Models per role, then run it again.'
		]);
		expect(completed).toHaveLength(1);
	});

	it('stops a summaries run with the Assistant turned off', async () => {
		const { owner, story } = await seedStory();
		const { handlers } = harness({
			summariseStory: async () => ({ scenes: 0, chapters: 0, failed: 0, disabled: true })
		});
		await handlers.assistantSummaries([job({ userId: owner.id, storyId: story.id })]);
		expect(await titles(owner.id)).toEqual([
			'The Assistant is turned off, so it stopped summarising "Halden". Switch it back on in your settings, then run it again.'
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

describe('worker logs', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	// Every line goes through logEvent, so the collector can parse it.
	function captureLog() {
		const lines: Record<string, unknown>[] = [];
		const record = (line: string) => lines.push(JSON.parse(line));
		vi.spyOn(console, 'log').mockImplementation(record);
		vi.spyOn(console, 'warn').mockImplementation(record);
		vi.spyOn(console, 'error').mockImplementation(record);
		return lines;
	}

	it('logs a skipped job as a structured event', async () => {
		const { story } = await seedStory();
		const other = await makeUser('other@example.com');
		const { handlers } = harness({ summariseStory: neverCalled });
		const lines = captureLog();

		await handlers.assistantSummaries([job({ userId: other.id, storyId: story.id })]);

		expect(lines).toEqual([
			expect.objectContaining({
				level: 'warn',
				event: 'assistant.summaries_skipped',
				storyId: story.id,
				userId: other.id
			})
		]);
	});

	it('logs a purge as a structured event', async () => {
		const { story } = await seedStory();
		await db
			.update(stories)
			.set({ deletedAt: new Date(Date.now() - 365 * 86_400_000) })
			.where(eq(stories.id, story.id));
		const { handlers } = harness();
		const lines = captureLog();

		await handlers.purgeUniverses();

		expect(lines).toContainEqual(
			expect.objectContaining({ level: 'info', event: 'purge.story', storyId: story.id })
		);
	});
});

describe('continuing a review capped before the upgrade', () => {
	it('reads what the old job checked from the legacy queue', async () => {
		const { owner, story } = await seedStory();
		const asked: { queue: string; id: string }[] = [];
		let lookup: ((jobId: string) => Promise<unknown>) | undefined;
		const boss = {
			async complete() {
				return null;
			},
			async send() {
				return null;
			},
			async getJobById(queue: string, id: string) {
				asked.push({ queue, id });
				return id === 'old-job' ? { data: { categories: ['prose', 'mechanics'] } } : null;
			}
		} as unknown as WorkerDeps['boss'];
		const handlers = createHandlers({
			db,
			boss,
			origin: 'https://codex.test',
			services: {
				reviewStoryScenes: async (_db, opts) => {
					lookup = opts.legacyJobCategories;
					return reviewResult({});
				}
			}
		});

		await handlers.assistantReview([job({ userId: owner.id, storyId: story.id })]);

		expect(await lookup?.('old-job')).toEqual(['mechanics', 'prose']);
		expect(await lookup?.('forgotten')).toBeNull();
		expect(asked.filter((a) => a.id === 'old-job')).toEqual([
			{ queue: LEGACY_ASSISTANT_REVIEW_QUEUE, id: 'old-job' }
		]);
	});
});
