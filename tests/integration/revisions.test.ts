import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import {
	characters,
	reviewThreads,
	revisions,
	scenes,
	stories,
	universes,
	users
} from '../../src/lib/server/db/schema';
import {
	createCheckpoint,
	getRevision,
	listRevisions,
	recordRevision,
	restoreRevision,
	storyTimeline,
	thinRevisions,
	universeRevisionCount,
	universeTimeline
} from '../../src/lib/server/revisions';
import { saveCharacter } from '../../src/lib/server/characters';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

let pool: pg.Pool;
let db: Database;
let ownerId: string;
let strangerId: string;
let universeId: string;
let storyId: string;
let sceneId: string;
let aliceId: string;

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
	await pool.query(
		'truncate table revisions, scenes, chapters, characters, stories, universes, users cascade'
	);

	const [owner] = await db
		.insert(users)
		.values({ email: 'rev@example.com', displayName: 'Rev', passwordHash: 'x', role: 'user' })
		.returning();
	ownerId = owner.id;
	const [stranger] = await db
		.insert(users)
		.values({ email: 'rev2@example.com', displayName: 'Rev2', passwordHash: 'x', role: 'user' })
		.returning();
	strangerId = stranger.id;
	const [universe] = await db.insert(universes).values({ ownerId, name: 'U' }).returning();
	universeId = universe.id;
	const [story] = await db.insert(stories).values({ universeId, ownerId, title: 'S' }).returning();
	storyId = story.id;
	const [scene] = await db
		.insert(scenes)
		.values({ storyId, globalPosition: 1, title: 'Opening', bodyMd: 'First draft.' })
		.returning();
	sceneId = scene.id;
	const [alice] = await db
		.insert(characters)
		.values({ universeId, ownerId, name: 'Alice', bodyMd: 'A smuggler.' })
		.returning();
	aliceId = alice.id;
});

afterAll(async () => {
	await pool.end();
});

describe('recordRevision', () => {
	it('coalesces a changed autosave into the latest, and skips an unchanged one', async () => {
		expect(await recordRevision(db, 'scene', sceneId, 'First draft.')).toEqual({
			recorded: true
		});
		expect(await recordRevision(db, 'scene', sceneId, 'First draft.')).toEqual({
			recorded: false
		});
		expect(await recordRevision(db, 'scene', sceneId, 'Second draft.')).toEqual({
			recorded: true
		});
		// The change rolled the single autosave entry forward rather than adding one.
		const rows = await listRevisions(db, 'scene', sceneId);
		expect(rows).toHaveLength(1);
		const body = await getRevision(db, rows[0].id, 'scene', sceneId);
		expect(body?.bodyMd).toBe('Second draft.');
	});

	it('always records a checkpoint, even on unchanged text', async () => {
		expect(
			await recordRevision(db, 'scene', sceneId, 'Second draft.', 'checkpoint', {
				label: 'Before edits'
			})
		).toEqual({ recorded: true });
		const rows = await listRevisions(db, 'scene', sceneId);
		expect(rows[0]).toMatchObject({ reason: 'checkpoint', label: 'Before edits' });
	});

	it('starts a new autosave entry once the coalesce window has passed', async () => {
		const id = randomUUID();
		await recordRevision(db, 'scene', id, 'A.');
		// Age the entry well past the coalesce window.
		await db
			.update(revisions)
			.set({ createdAt: sql`now() - interval '10 minutes'` })
			.where(eq(revisions.entityId, id));
		await recordRevision(db, 'scene', id, 'B.');
		expect(await listRevisions(db, 'scene', id)).toHaveLength(2);
	});

	it('stores the word count of each body, including a coalesced one', async () => {
		const id = randomUUID();
		const wordsOf = async () =>
			(
				await db
					.select({ wordCount: revisions.wordCount })
					.from(revisions)
					.where(eq(revisions.entityId, id))
			).map((row) => row.wordCount);
		await recordRevision(db, 'scene', id, 'One two three.');
		expect(await wordsOf()).toEqual([3]);
		await recordRevision(db, 'scene', id, 'One two three four five.');
		expect(await wordsOf()).toEqual([5]);
		await recordRevision(db, 'scene', id, 'Six.', 'checkpoint');
		expect((await wordsOf()).sort()).toEqual([1, 5]);
	});

	it('does not coalesce an autosave into a preceding checkpoint', async () => {
		const id = randomUUID();
		await recordRevision(db, 'scene', id, 'A.');
		await recordRevision(db, 'scene', id, 'A.', 'checkpoint', { label: 'Mark' });
		await recordRevision(db, 'scene', id, 'B.');
		expect(await listRevisions(db, 'scene', id)).toHaveLength(3);
	});
});

describe('save paths record revisions', () => {
	it('saveCharacter writes a revision for a body change only', async () => {
		await saveCharacter(db, aliceId, ownerId, {
			name: 'Alice',
			aliases: [],
			summaryMd: null,
			bodyMd: 'A smuggler with debts.'
		});
		expect(await listRevisions(db, 'character', aliceId)).toHaveLength(1);
		// A name-only save changes the snapshot, so it registers in History
		// even though the body is untouched; it coalesces into the recent
		// autosave entry rather than appending.
		await saveCharacter(db, aliceId, ownerId, {
			name: 'Alice Vane',
			aliases: [],
			summaryMd: null,
			bodyMd: 'A smuggler with debts.'
		});
		const rows = await listRevisions(db, 'character', aliceId);
		expect(rows).toHaveLength(1);
		const revision = await getRevision(db, rows[0].id, 'character', aliceId);
		expect(revision?.snapshot?.name).toBe('Alice Vane');
	});
});

describe('createCheckpoint', () => {
	it('snapshots the current body with a label and checks ownership', async () => {
		const ok = await createCheckpoint(db, ownerId, 'scene', sceneId, 'Plotted');
		expect(ok).toMatchObject({ ok: true });
		const rows = await listRevisions(db, 'scene', sceneId);
		expect(rows[0]).toMatchObject({ reason: 'checkpoint', label: 'Plotted' });
		const revision = await getRevision(db, rows[0].id, 'scene', sceneId);
		// The checkpoint snapshots the stored scene body, untouched by the
		// revision rows the earlier cases recorded.
		expect(revision?.bodyMd).toBe('First draft.');

		expect(await createCheckpoint(db, strangerId, 'scene', sceneId)).toMatchObject({
			ok: false
		});
	});
});

describe('restoreRevision', () => {
	it('restores the text and stacks a new revision on top', async () => {
		// Checkpoints never coalesce, so they give a deterministic older revision
		// to restore regardless of how the autosaves above collapsed.
		await recordRevision(db, 'scene', sceneId, 'Older body here.', 'checkpoint', {
			label: 'Older'
		});
		await recordRevision(db, 'scene', sceneId, 'Newer body now.', 'checkpoint', {
			label: 'Newer'
		});
		const timeline = await listRevisions(db, 'scene', sceneId);
		const older = timeline.find((row) => row.label === 'Older')!;
		const result = await restoreRevision(db, ownerId, older.id, 'scene', sceneId);
		expect(result).toMatchObject({ ok: true });

		const [scene] = await db.select().from(scenes).where(eq(scenes.id, sceneId));
		expect(scene.bodyMd).toBe('Older body here.');
		expect(scene.wordCount).toBe(3);

		const after = await listRevisions(db, 'scene', sceneId);
		expect(after).toHaveLength(timeline.length + 1);
		expect(after[0]).toMatchObject({ reason: 'restore' });
	});

	it('rejects a revision belonging to another entity', async () => {
		const [aliceRevision] = await listRevisions(db, 'character', aliceId);
		const result = await restoreRevision(db, ownerId, aliceRevision.id, 'scene', sceneId);
		expect(result).toMatchObject({ ok: false, reason: 'revision not found' });
	});

	it('rejects another user', async () => {
		const [revision] = await listRevisions(db, 'scene', sceneId);
		expect(await restoreRevision(db, strangerId, revision.id, 'scene', sceneId)).toMatchObject({
			ok: false,
			reason: 'entity not found'
		});
	});
});

describe('timelines', () => {
	it('story timeline lists scene revisions with names', async () => {
		const rows = await storyTimeline(db, storyId);
		const types = new Set(rows.map((row) => row.entityType));
		expect(types).toEqual(new Set(['scene']));
		expect(rows.find((row) => row.entityType === 'scene')?.entityName).toBe('Opening');
		// Newest first.
		const times = rows.map((row) => row.createdAt.getTime());
		expect([...times].sort((a, b) => b - a)).toEqual(times);
	});

	it('universe timeline spans entities and scenes, with story context', async () => {
		const rows = await universeTimeline(db, universeId);
		const types = new Set(rows.map((row) => row.entityType));
		expect(types).toEqual(new Set(['character', 'scene']));
		const character = rows.find((row) => row.entityType === 'character');
		expect(character?.entityName).toBe('Alice Vane');
		expect(character?.storyTitle ?? null).toBe(null);
		const scene = rows.find((row) => row.entityType === 'scene');
		expect(scene?.entityName).toBe('Opening');
		expect(scene?.storyTitle).toBeTruthy();
		expect(scene?.storySlug).toBeTruthy();
	});
});

describe('universe timeline limits', () => {
	it('returns the newest rows across entities when one has a long history', async () => {
		const [busy] = await db
			.insert(scenes)
			.values({ storyId, globalPosition: 50, title: 'Busy', bodyMd: '' })
			.returning();
		const [quiet] = await db
			.insert(characters)
			.values({ universeId, ownerId, name: 'Quiet', bodyMd: '' })
			.returning();
		const hour = 60 * 60 * 1000;
		const base = Date.now() + 1000 * hour;
		// Ten older scene saves, then one newer character save, then one newest
		// scene save: the top three must interleave the two entities.
		await db.insert(revisions).values([
			...Array.from({ length: 10 }, (_, i) => ({
				entityType: 'scene' as const,
				entityId: busy.id,
				bodyMd: `old ${i}`,
				reason: 'autosave',
				createdAt: new Date(base + i * hour)
			})),
			{
				entityType: 'character',
				entityId: quiet.id,
				bodyMd: 'q',
				reason: 'autosave',
				createdAt: new Date(base + 20 * hour)
			},
			{
				entityType: 'scene',
				entityId: busy.id,
				bodyMd: 'newest',
				reason: 'autosave',
				createdAt: new Date(base + 30 * hour)
			}
		]);
		const rows = await universeTimeline(db, universeId, 3);
		expect(rows.map((row) => [row.entityName, row.createdAt.getTime()])).toEqual([
			['Busy', base + 30 * hour],
			['Quiet', base + 20 * hour],
			['Busy', base + 9 * hour]
		]);
		expect((await storyTimeline(db, storyId, 2)).map((row) => row.createdAt.getTime())).toEqual([
			base + 30 * hour,
			base + 9 * hour
		]);
	});

	it('counts every revision in the universe', async () => {
		const [{ total }] = (
			await pool.query(
				`select count(*)::int as total from revisions r
				where r.entity_id in (select s.id from scenes s join stories st on st.id = s.story_id
					where st.universe_id = $1)
				or r.entity_id in (select id from characters where universe_id = $1)`,
				[universeId]
			)
		).rows;
		expect(total).toBeGreaterThan(0);
		expect(await universeRevisionCount(db, universeId)).toBe(total);
	});
});

describe('thinRevisions', () => {
	it('keeps recent history, checkpoints, pinned bases and the last autosave of each old day', async () => {
		const [scene] = await db
			.insert(scenes)
			.values({ storyId, globalPosition: 60, title: 'Old', bodyMd: '' })
			.returning();
		const day = 24 * 60 * 60 * 1000;
		const old = new Date(Date.now() - 200 * day);
		old.setUTCHours(10, 0, 0, 0);
		const at = (offsetMs: number) => new Date(old.getTime() + offsetMs);
		const minute = 60 * 1000;
		const recentDay = new Date(Date.now() - 2 * day);
		const rows = await db
			.insert(revisions)
			.values([
				// An old day: three autosaves, a checkpoint, and a pinned autosave.
				{
					entityType: 'scene',
					entityId: scene.id,
					bodyMd: 'a1',
					reason: 'autosave',
					createdAt: at(0)
				},
				{
					entityType: 'scene',
					entityId: scene.id,
					bodyMd: 'a2',
					reason: 'autosave',
					createdAt: at(10 * minute)
				},
				{
					entityType: 'scene',
					entityId: scene.id,
					bodyMd: 'pin',
					reason: 'autosave',
					createdAt: at(20 * minute)
				},
				{
					entityType: 'scene',
					entityId: scene.id,
					bodyMd: 'cp',
					reason: 'checkpoint',
					createdAt: at(30 * minute)
				},
				{
					entityType: 'scene',
					entityId: scene.id,
					bodyMd: 'a3',
					reason: 'autosave',
					createdAt: at(40 * minute)
				},
				// The next old day: a single autosave.
				{
					entityType: 'scene',
					entityId: scene.id,
					bodyMd: 'b1',
					reason: 'autosave',
					createdAt: at(day)
				},
				// Recent: every autosave stays.
				{
					entityType: 'scene',
					entityId: scene.id,
					bodyMd: 'r1',
					reason: 'autosave',
					createdAt: recentDay
				},
				{
					entityType: 'scene',
					entityId: scene.id,
					bodyMd: 'r2',
					reason: 'autosave',
					createdAt: new Date(recentDay.getTime() + minute)
				}
			])
			.returning({ id: revisions.id, bodyMd: revisions.bodyMd });
		const pinned = rows.find((row) => row.bodyMd === 'pin')!;
		await db
			.insert(reviewThreads)
			.values({ storyId, sceneId: scene.id, baseRevisionId: pinned.id });

		expect(await thinRevisions(db)).toBe(2);
		const left = await db
			.select({ bodyMd: revisions.bodyMd })
			.from(revisions)
			.where(eq(revisions.entityId, scene.id));
		expect(left.map((row) => row.bodyMd).sort()).toEqual(
			['a3', 'b1', 'cp', 'pin', 'r1', 'r2'].sort()
		);
		// A second run finds nothing more to do.
		expect(await thinRevisions(db)).toBe(0);
	});
});
