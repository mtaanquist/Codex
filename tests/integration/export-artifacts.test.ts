import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import { unzipSync } from 'fflate';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import { exportArtifacts, scenes, stories, universes, users } from '../../src/lib/server/db/schema';
import {
	artifactForDownload,
	generateEditionArtifacts,
	listEditionArtifacts,
	setDownloadsPublic,
	type ArtifactDeps
} from '../../src/lib/server/export-artifacts';
import { publishStory } from '../../src/lib/server/publish';
import { inMemoryAsset } from '../../src/lib/server/export';
import { purgeAccount } from '../../src/lib/server/account-deletion';
import type { AssetObjectStore } from '../../src/lib/server/assets';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

let pool: pg.Pool;
let db: Database;
let ownerId: string;
let otherId: string;
let storyId: string;

// An in-memory stand-in for the S3 bucket, so the bookkeeping is testable
// without one. The PDF renderer is faked the same way; the real one needs a
// browser and is exercised in the Docker image.
function memoryStore() {
	const objects = new Map<string, Buffer>();
	const store: AssetObjectStore = {
		async put(key, body) {
			objects.set(key, Buffer.from(body));
		},
		async upload(key, body) {
			const parts: Buffer[] = [];
			for await (const chunk of body) parts.push(Buffer.from(chunk));
			objects.set(key, Buffer.concat(parts));
		},
		async get(key) {
			const body = objects.get(key);
			if (!body) throw new Error(`missing object: ${key}`);
			return Readable.from(body);
		},
		async remove(key) {
			objects.delete(key);
		}
	};
	return { objects, store };
}

function deps(store: AssetObjectStore): ArtifactDeps {
	return {
		store,
		prefix: 'test',
		loadAssets: async () => [],
		renderPdf: async () => new Uint8Array([0x25, 0x50, 0x44, 0x46])
	};
}

async function publish(): Promise<string> {
	const result = await publishStory(db, ownerId, storyId);
	if (!result.ok) throw new Error(result.reason);
	return result.publicationId;
}

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await pool.query(
		'truncate table export_artifacts, publication_assets, publications, scenes, chapters, stories, universes, auth_tokens, users cascade'
	);
	const [owner] = await db
		.insert(users)
		.values({
			email: 'author@example.com',
			displayName: 'Author',
			passwordHash: 'x',
			role: 'user',
			handle: 'author',
			publicArchiveEnabled: true
		})
		.returning({ id: users.id });
	ownerId = owner.id;
	const [other] = await db
		.insert(users)
		.values({ email: 'other@example.com', displayName: 'Other', passwordHash: 'x', role: 'user' })
		.returning({ id: users.id });
	otherId = other.id;
	const [universe] = await db
		.insert(universes)
		.values({ ownerId, name: 'U' })
		.returning({ id: universes.id });
	const [story] = await db
		.insert(stories)
		.values({ universeId: universe.id, ownerId, title: 'Book of Ash', visibility: 'public' })
		.returning({ id: stories.id });
	storyId = story.id;
	await db.insert(scenes).values({ storyId, globalPosition: 1, bodyMd: 'The gate opened.' });
});

afterAll(async () => {
	await pool.end();
});

describe('generateEditionArtifacts', () => {
	it('looks up each image once for all three formats', async () => {
		const imageId = '11111111-1111-4111-8111-111111111111';
		await db
			.update(scenes)
			.set({ bodyMd: `The gate opened.\n\n![map](/assets/${imageId})` })
			.where(eq(scenes.storyId, storyId));
		const publicationId = await publish();
		const requested: string[] = [];
		const { store } = memoryStore();
		const result = await generateEditionArtifacts(db, publicationId, {
			...deps(store),
			loadAssets: async (ids) => {
				requested.push(...ids);
				return ids.map((id) => inMemoryAsset(id, 'image/png', new Uint8Array([1])));
			}
		});
		expect(result).toMatchObject({ ok: true, failed: [] });
		expect(requested).toEqual([imageId]);
	});

	it('stores all three formats with deterministic keys', async () => {
		const publicationId = await publish();
		const { objects, store } = memoryStore();
		const result = await generateEditionArtifacts(db, publicationId, deps(store));
		expect(result).toMatchObject({ ok: true, stored: ['markdown', 'epub', 'pdf'], failed: [] });

		const rows = await listEditionArtifacts(db, publicationId);
		expect(rows.map((row) => row.format)).toEqual(['epub', 'markdown', 'pdf']);
		for (const row of rows) {
			expect(row.storageKey).toBe(`test/exports/${publicationId}/${row.format}`);
			expect(objects.get(row.storageKey)?.byteLength).toBe(row.byteSize);
		}
		const pdf = rows.find((row) => row.format === 'pdf')!;
		expect(pdf.filename).toBe('book-of-ash.pdf');
		expect(pdf.contentType).toBe('application/pdf');
	});

	it('streams the zip and EPUB to the bucket, reading each image as it is written', async () => {
		const imageId = '22222222-2222-4222-8222-222222222222';
		await db
			.update(scenes)
			.set({ bodyMd: `![map](/assets/${imageId})` })
			.where(eq(scenes.storyId, storyId));
		const publicationId = await publish();
		const { objects, store } = memoryStore();
		const calls: string[] = [];
		const tracked: AssetObjectStore = {
			...store,
			async put(key, body, contentType) {
				calls.push(`put ${key.split('/').pop()}`);
				await store.put(key, body, contentType);
			},
			async upload(key, body, contentType) {
				calls.push(`upload ${key.split('/').pop()}`);
				await store.upload(key, body, contentType);
			}
		};
		const result = await generateEditionArtifacts(db, publicationId, {
			...deps(tracked),
			loadAssets: async (ids) =>
				ids.map((id) => ({
					id,
					contentType: 'image/png',
					open: async () => {
						calls.push('read image');
						return Readable.from([Buffer.from('png')]);
					}
				}))
		});
		expect(result).toMatchObject({ ok: true, failed: [] });
		// The image is read inside each upload, not loaded up front.
		expect(calls).toEqual([
			'upload markdown',
			'read image',
			'upload epub',
			'read image',
			'read image',
			'put pdf'
		]);
		const zip = unzipSync(new Uint8Array(objects.get(`test/exports/${publicationId}/markdown`)!));
		expect(Object.keys(zip).some((name) => name.endsWith(`${imageId}.png`))).toBe(true);
	});

	it('replaces rows in place on regeneration', async () => {
		const publicationId = await publish();
		const { store } = memoryStore();
		await generateEditionArtifacts(db, publicationId, deps(store));
		await generateEditionArtifacts(db, publicationId, deps(store));
		expect(await listEditionArtifacts(db, publicationId)).toHaveLength(3);
	});

	it('keeps the zip and epub when the pdf renderer fails', async () => {
		const publicationId = await publish();
		const { store } = memoryStore();
		const result = await generateEditionArtifacts(db, publicationId, {
			...deps(store),
			renderPdf: async () => {
				throw new Error('no browser here');
			}
		});
		expect(result).toMatchObject({ ok: true, stored: ['markdown', 'epub'] });
		if (result.ok) expect(result.failed).toEqual([{ format: 'pdf', error: 'no browser here' }]);
		expect(await listEditionArtifacts(db, publicationId)).toHaveLength(2);
	});

	it('refuses an unknown or taken-down edition', async () => {
		const { store } = memoryStore();
		expect(await generateEditionArtifacts(db, crypto.randomUUID(), deps(store))).toMatchObject({
			ok: false
		});
		const publicationId = await publish();
		await pool.query('update publications set removed_at = now() where id = $1', [publicationId]);
		expect(await generateEditionArtifacts(db, publicationId, deps(store))).toMatchObject({
			ok: false,
			reason: 'That edition was taken down.'
		});
	});
});

describe('artifactForDownload', () => {
	async function generated() {
		const publicationId = await publish();
		const { store } = memoryStore();
		await generateEditionArtifacts(db, publicationId, deps(store));
		const rows = await listEditionArtifacts(db, publicationId);
		return {
			publicationId,
			epub: rows.find((row) => row.format === 'epub')!,
			markdown: rows.find((row) => row.format === 'markdown')!
		};
	}

	it('always serves the owner, never a stranger by default', async () => {
		const { epub, markdown } = await generated();
		expect(await artifactForDownload(db, epub.id, ownerId)).not.toBeNull();
		expect(await artifactForDownload(db, markdown.id, ownerId)).not.toBeNull();
		// Reader downloads default off.
		expect(await artifactForDownload(db, epub.id, null)).toBeNull();
		expect(await artifactForDownload(db, epub.id, otherId)).toBeNull();
	});

	it('serves readers epub and pdf, but never the markdown zip', async () => {
		const { publicationId, epub, markdown } = await generated();
		expect(await setDownloadsPublic(db, ownerId, publicationId, true)).toBe(true);
		expect(await artifactForDownload(db, epub.id, null)).not.toBeNull();
		expect(await artifactForDownload(db, markdown.id, null)).toBeNull();
	});

	it('stops serving readers on takedown, private visibility, or a newer edition', async () => {
		const { publicationId, epub } = await generated();
		await setDownloadsPublic(db, ownerId, publicationId, true);

		await db.update(stories).set({ visibility: 'private' }).where(eq(stories.id, storyId));
		expect(await artifactForDownload(db, epub.id, null)).toBeNull();
		await db.update(stories).set({ visibility: 'public' }).where(eq(stories.id, storyId));
		expect(await artifactForDownload(db, epub.id, null)).not.toBeNull();

		// A new edition supersedes the old one's public downloads.
		await publish();
		expect(await artifactForDownload(db, epub.id, null)).toBeNull();
		// The owner still reaches the superseded artifact.
		expect(await artifactForDownload(db, epub.id, ownerId)).not.toBeNull();
	});

	it('only the owner can toggle reader downloads', async () => {
		const { publicationId } = await generated();
		expect(await setDownloadsPublic(db, otherId, publicationId, true)).toBe(false);
	});
});

describe('purgeAccount', () => {
	it('removes the stored export objects with the account', async () => {
		const publicationId = await publish();
		const { objects, store } = memoryStore();
		await generateEditionArtifacts(db, publicationId, deps(store));
		expect(objects.size).toBe(3);

		await purgeAccount(db, ownerId, store);
		expect(objects.size).toBe(0);
		expect(
			await db
				.select()
				.from(exportArtifacts)
				.where(eq(exportArtifacts.publicationId, publicationId))
		).toEqual([]);
	});
});
