import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { asc, eq } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import {
	revisions,
	sceneMarkers,
	scenes,
	stories,
	universes,
	users
} from '../../src/lib/server/db/schema';
import { saveSceneBody, type SceneSave } from '../../src/lib/server/scene-save';
import { textHash } from '../../src/lib/text-hash';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

let pool: pg.Pool;
let db: Database;
let ownerId: string;
let storyId: string;
let sceneId: string;

const START = 'The gate opened.';

function save(overrides: Partial<SceneSave>): SceneSave {
	return {
		title: null,
		bodyMd: START,
		anchors: null,
		baseHashes: [textHash(START)],
		overwrite: false,
		...overrides
	};
}

async function stored() {
	const [row] = await db.select().from(scenes).where(eq(scenes.id, sceneId));
	return row;
}

async function history() {
	return await db
		.select({ bodyMd: revisions.bodyMd, reason: revisions.reason })
		.from(revisions)
		.where(eq(revisions.entityId, sceneId))
		.orderBy(asc(revisions.createdAt));
}

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
	await pool.query(
		'truncate table revisions, scene_markers, scenes, stories, universes, users cascade'
	);
	const [owner] = await db
		.insert(users)
		.values({ email: 'save@example.com', displayName: 'Save', passwordHash: 'x', role: 'user' })
		.returning();
	ownerId = owner.id;
	const [universe] = await db.insert(universes).values({ ownerId, name: 'U' }).returning();
	const [story] = await db
		.insert(stories)
		.values({ universeId: universe.id, ownerId, title: 'S' })
		.returning();
	storyId = story.id;
});

beforeEach(async () => {
	await pool.query('truncate table revisions, scene_markers, scenes cascade');
	const [scene] = await db
		.insert(scenes)
		.values({ storyId, globalPosition: 1, title: 'Gate', bodyMd: START })
		.returning();
	sceneId = scene.id;
});

afterAll(async () => {
	await pool.end();
});

describe('saveSceneBody', () => {
	it('saves when the editor saw the stored text', async () => {
		const result = await saveSceneBody(db, sceneId, save({ bodyMd: 'The gate opened wide.' }));
		expect(result).toEqual({ ok: true, wordCount: 4 });
		expect((await stored()).bodyMd).toBe('The gate opened wide.');
		expect(await history()).toEqual([{ bodyMd: 'The gate opened wide.', reason: 'autosave' }]);
	});

	it('refuses a save from an editor that has not seen the newer text', async () => {
		// Another device wrote 500 words; this tab still holds the old text.
		await saveSceneBody(db, sceneId, save({ bodyMd: 'Newer words from the desktop.' }));
		const stale = await saveSceneBody(db, sceneId, save({ bodyMd: 'The gate opened!' }));
		expect(stale).toEqual({
			ok: false,
			conflict: { bodyMd: 'Newer words from the desktop.', title: null }
		});
		expect((await stored()).bodyMd).toBe('Newer words from the desktop.');
		// The newer text is still the latest revision.
		const rows = await history();
		expect(rows.at(-1)?.bodyMd).toBe('Newer words from the desktop.');
	});

	it('accepts either fingerprint while an earlier save is still in flight', async () => {
		const inFlight = 'The gate opened, slowly.';
		const closing = 'The gate opened, slowly, at dawn.';
		const bases = [textHash(START), textHash(inFlight)];
		// The close-tab save lands first, then the older one arrives.
		expect(await saveSceneBody(db, sceneId, save({ bodyMd: closing, baseHashes: bases }))).toEqual(
			expect.objectContaining({ ok: true })
		);
		expect(await saveSceneBody(db, sceneId, save({ bodyMd: inFlight }))).toMatchObject({
			ok: false
		});
		expect((await stored()).bodyMd).toBe(closing);
	});

	it('keeps the replaced text in History when the writer keeps their own version', async () => {
		await saveSceneBody(db, sceneId, save({ bodyMd: 'Desktop text.' }));
		const result = await saveSceneBody(
			db,
			sceneId,
			save({ bodyMd: 'Laptop text.', baseHashes: [textHash('Desktop text.')], overwrite: true })
		);
		expect(result).toMatchObject({ ok: true });
		expect((await stored()).bodyMd).toBe('Laptop text.');
		const bodies = (await history()).map((row) => row.bodyMd);
		expect(bodies).toContain('Desktop text.');
		expect(bodies.at(-1)).toBe('Laptop text.');
	});

	it('lets a save through when the text already matches, whatever the fingerprint', async () => {
		const result = await saveSceneBody(db, sceneId, save({ baseHashes: ['stale'] }));
		expect(result).toMatchObject({ ok: true });
	});

	it('reports a scene that is gone', async () => {
		const result = await saveSceneBody(db, crypto.randomUUID(), save({}));
		expect(result).toEqual({ ok: false, missing: true });
	});

	it('skips the check for a save without fingerprints', async () => {
		await saveSceneBody(db, sceneId, save({ bodyMd: 'Elsewhere.' }));
		const result = await saveSceneBody(db, sceneId, save({ bodyMd: 'Old tab.', baseHashes: null }));
		expect(result).toMatchObject({ ok: true });
		expect((await stored()).bodyMd).toBe('Old tab.');
	});

	it('leaves marker anchors alone when none are sent, and moves them when they are', async () => {
		const [marker] = await db
			.insert(sceneMarkers)
			.values({ sceneId, ownerId, anchorStart: 4, anchorEnd: 8 })
			.returning();
		await saveSceneBody(db, sceneId, save({ bodyMd: 'The gate opened at last.' }));
		let [row] = await db.select().from(sceneMarkers).where(eq(sceneMarkers.id, marker.id));
		expect([row.anchorStart, row.anchorEnd]).toEqual([4, 8]);

		await saveSceneBody(
			db,
			sceneId,
			save({
				bodyMd: 'A gate opened at last.',
				baseHashes: [textHash('The gate opened at last.')],
				anchors: [{ id: marker.id, anchorStart: 2, anchorEnd: 6 }]
			})
		);
		[row] = await db.select().from(sceneMarkers).where(eq(sceneMarkers.id, marker.id));
		expect([row.anchorStart, row.anchorEnd]).toEqual([2, 6]);
	});
});
