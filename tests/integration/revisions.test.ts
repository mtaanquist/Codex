import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import {
	characters,
	outlineNodes,
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
let nodeId: string;

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
	await pool.query(
		'truncate table revisions, outline_nodes, scenes, chapters, characters, stories, universes, users cascade'
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
	const [node] = await db
		.insert(outlineNodes)
		.values({ storyId, position: 1, title: 'Act one', bodyMd: 'Beats.' })
		.returning();
	nodeId = node.id;
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
			await recordRevision(db, 'scene', sceneId, 'Second draft.', 'checkpoint', 'Before edits')
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

	it('does not coalesce an autosave into a preceding checkpoint', async () => {
		const id = randomUUID();
		await recordRevision(db, 'scene', id, 'A.');
		await recordRevision(db, 'scene', id, 'A.', 'checkpoint', 'Mark');
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
		// A name-only save leaves the body unchanged: no new revision.
		await saveCharacter(db, aliceId, ownerId, {
			name: 'Alice Vane',
			aliases: [],
			summaryMd: null,
			bodyMd: 'A smuggler with debts.'
		});
		expect(await listRevisions(db, 'character', aliceId)).toHaveLength(1);
	});
});

describe('createCheckpoint', () => {
	it('snapshots the current body with a label and checks ownership', async () => {
		const ok = await createCheckpoint(db, ownerId, 'outline_node', nodeId, 'Plotted');
		expect(ok).toMatchObject({ ok: true });
		const rows = await listRevisions(db, 'outline_node', nodeId);
		expect(rows[0]).toMatchObject({ reason: 'checkpoint', label: 'Plotted' });
		const revision = await getRevision(db, rows[0].id, 'outline_node', nodeId);
		expect(revision?.bodyMd).toBe('Beats.');

		expect(await createCheckpoint(db, strangerId, 'outline_node', nodeId)).toMatchObject({
			ok: false
		});
	});
});

describe('restoreRevision', () => {
	it('restores the text and stacks a new revision on top', async () => {
		// Checkpoints never coalesce, so they give a deterministic older revision
		// to restore regardless of how the autosaves above collapsed.
		await recordRevision(db, 'scene', sceneId, 'Older body here.', 'checkpoint', 'Older');
		await recordRevision(db, 'scene', sceneId, 'Newer body now.', 'checkpoint', 'Newer');
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
	it('story timeline spans scenes and outline nodes with names', async () => {
		const rows = await storyTimeline(db, storyId);
		const types = new Set(rows.map((row) => row.entityType));
		expect(types).toEqual(new Set(['scene', 'outline_node']));
		expect(rows.find((row) => row.entityType === 'scene')?.entityName).toBe('Opening');
		expect(rows.find((row) => row.entityType === 'outline_node')?.entityName).toBe('Act one');
		// Newest first.
		const times = rows.map((row) => row.createdAt.getTime());
		expect([...times].sort((a, b) => b - a)).toEqual(times);
	});

	it('universe timeline lists entity revisions', async () => {
		const rows = await universeTimeline(db, universeId);
		expect(rows.length).toBeGreaterThan(0);
		expect(rows.every((row) => row.entityType === 'character')).toBe(true);
		expect(rows[0].entityName).toBe('Alice Vane');
	});
});
