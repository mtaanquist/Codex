import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Readable } from 'node:stream';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import {
	chapters,
	characters,
	entityCategories,
	scenes,
	stories,
	universes,
	userExports,
	users
} from '../../src/lib/server/db/schema';
import type { AssetObjectStore } from '../../src/lib/server/assets';
import {
	exportForDownload,
	listUserExports,
	pruneOwnerExports,
	requestExport,
	runUserExport
} from '../../src/lib/server/user-exports';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

let pool: pg.Pool;
let db: Database;
let ownerId: string;
let otherId: string;
let universeId: string;
let storyId: string;

// An in-memory asset bucket; the real one is thin S3 calls.
function memoryStore() {
	const objects = new Map<string, Buffer>();
	const store: AssetObjectStore = {
		async put(key, body) {
			objects.set(key, Buffer.from(body));
		},
		async get(key) {
			const data = objects.get(key);
			if (!data) throw new Error(`missing: ${key}`);
			return Readable.from(data);
		},
		async remove(key) {
			objects.delete(key);
		}
	};
	return { store, objects };
}

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
	await pool.query('truncate table users cascade');

	const [owner] = await db
		.insert(users)
		.values({ email: 'exp-owner@example.com', displayName: 'O', passwordHash: 'x', role: 'user' })
		.returning();
	ownerId = owner.id;
	const [other] = await db
		.insert(users)
		.values({ email: 'exp-other@example.com', displayName: 'X', passwordHash: 'x', role: 'user' })
		.returning();
	otherId = other.id;
	const [universe] = await db
		.insert(universes)
		.values({ ownerId, name: 'Ardenfall', slug: 'ardenfall' })
		.returning();
	universeId = universe.id;
	const [story] = await db
		.insert(stories)
		.values({ universeId, ownerId, title: 'The Toll', slug: 'the-toll' })
		.returning();
	storyId = story.id;
	const [chapter] = await db
		.insert(chapters)
		.values({ storyId, title: 'One', position: 1 })
		.returning();
	await db.insert(scenes).values({
		storyId,
		chapterId: chapter.id,
		globalPosition: 1,
		title: 'Departure',
		bodyMd: 'The gate opened.'
	});
	// Mirror the universe-settings e2e: a category and a character with a
	// summary, so the universe export exercises the same shape it does there.
	const [category] = await db
		.insert(entityCategories)
		.values({ universeId, ownerId, name: 'Mythos', sortOrder: 0 })
		.returning();
	await db.insert(characters).values({
		universeId,
		ownerId,
		name: 'Histor',
		categoryId: category.id,
		summaryMd: 'Keeper of the record.'
	});
});

afterAll(async () => {
	await pool.end();
});

async function build(
	scope: 'account' | 'story' | 'universe',
	format: 'zip' | 'epub',
	targetId?: string
) {
	const requested = await requestExport(db, ownerId, { scope, targetId, format });
	expect(requested.ok).toBe(true);
	const id = (requested as { ok: true; id: string }).id;
	const { store, objects } = memoryStore();
	const ran = await runUserExport(db, id, store);
	return { id, ran, store, objects };
}

describe('requestExport', () => {
	it('refuses a story that is not the owner’s', async () => {
		const result = await requestExport(db, otherId, {
			scope: 'story',
			targetId: storyId,
			format: 'zip'
		});
		expect(result).toMatchObject({ ok: false });
	});

	it('refuses a format that does not fit the scope', async () => {
		expect(await requestExport(db, ownerId, { scope: 'account', format: 'epub' })).toMatchObject({
			ok: false
		});
	});
});

describe('runUserExport', () => {
	it('builds and stores an account zip, then serves it to its owner only', async () => {
		const { id, ran, objects } = await build('account', 'zip');
		expect(ran).toMatchObject({ ok: true, ownerId });

		const [row] = await db.select().from(userExports).where(eq(userExports.id, id));
		expect(row.status).toBe('ready');
		expect(row.contentType).toBe('application/zip');
		expect(row.byteSize).toBeGreaterThan(0);
		// A zip starts with the PK magic bytes.
		expect(objects.get(row.storageKey!)?.subarray(0, 2).toString()).toBe('PK');

		expect(await exportForDownload(db, id, ownerId)).not.toBeNull();
		expect(await exportForDownload(db, id, otherId)).toBeNull();
	});

	it('builds a story zip and a story EPUB', async () => {
		const zip = await build('story', 'zip', storyId);
		expect(zip.ran).toMatchObject({ ok: true });
		const [zipRow] = await db.select().from(userExports).where(eq(userExports.id, zip.id));
		expect(zipRow.contentType).toBe('application/zip');

		const epub = await build('story', 'epub', storyId);
		expect(epub.ran).toMatchObject({ ok: true });
		const [epubRow] = await db.select().from(userExports).where(eq(userExports.id, epub.id));
		expect(epubRow.contentType).toBe('application/epub+zip');
		expect(epubRow.filename).toMatch(/\.epub$/);
	});

	it('builds a universe zip', async () => {
		const { id, ran } = await build('universe', 'zip', universeId);
		expect(ran).toMatchObject({ ok: true });
		const [row] = await db.select().from(userExports).where(eq(userExports.id, id));
		expect(row.status).toBe('ready');
	});

	it('records a failure when the target is gone', async () => {
		const requested = await requestExport(db, ownerId, {
			scope: 'story',
			targetId: storyId,
			format: 'zip'
		});
		const id = (requested as { ok: true; id: string }).id;
		// Detach the target so the build cannot find it.
		await db
			.update(userExports)
			.set({ targetId: '00000000-0000-4000-8000-000000000000' })
			.where(eq(userExports.id, id));
		const ran = await runUserExport(db, id, memoryStore().store);
		expect(ran).toMatchObject({ ok: false });
		const [row] = await db.select().from(userExports).where(eq(userExports.id, id));
		expect(row.status).toBe('failed');
		expect(row.error).toBeTruthy();
	});
});

describe('exportForDownload', () => {
	it('refuses an expired export', async () => {
		const { id } = await build('account', 'zip');
		await db
			.update(userExports)
			.set({ expiresAt: new Date(Date.now() - 1000) })
			.where(eq(userExports.id, id));
		expect(await exportForDownload(db, id, ownerId)).toBeNull();
	});
});

describe('pruneOwnerExports', () => {
	it('removes expired exports and their stored objects', async () => {
		const { id, store, objects } = await build('account', 'zip');
		const [row] = await db.select().from(userExports).where(eq(userExports.id, id));
		expect(objects.has(row.storageKey!)).toBe(true);
		await db
			.update(userExports)
			.set({ expiresAt: new Date(Date.now() - 1000) })
			.where(eq(userExports.id, id));

		await pruneOwnerExports(db, store, ownerId);
		expect(objects.has(row.storageKey!)).toBe(false);
		expect((await db.select().from(userExports).where(eq(userExports.id, id))).length).toBe(0);
	});
});

describe('listUserExports', () => {
	it('lists the owner’s exports for a scope, newest first', async () => {
		const list = await listUserExports(db, ownerId, { scope: 'story', targetId: storyId });
		expect(list.length).toBeGreaterThan(0);
		expect(list.every((row) => row.scope === 'story' && row.targetId === storyId)).toBe(true);
	});
});
