import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import {
	assets,
	chapters,
	publications,
	scenes,
	stories,
	universes,
	users
} from '../../src/lib/server/db/schema';
import {
	isPublicAsset,
	isPublicAvatar,
	listPublications,
	publicEdition,
	publicProfile,
	publicShelf,
	publishStory,
	takedownPublication,
	type EditionContent
} from '../../src/lib/server/publish';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

let pool: pg.Pool;
let db: Database;
let authorId: string;
let universeId: string;
let storyId: string;
let sceneId: string;

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
	await pool.query(
		'truncate table publication_assets, publications, assets, scenes, chapters, stories, universes, users cascade'
	);

	const [author] = await db
		.insert(users)
		.values({
			email: 'pub@example.com',
			displayName: 'Pub',
			passwordHash: 'x',
			role: 'user',
			handle: 'inkwright',
			publicArchiveEnabled: false
		})
		.returning();
	authorId = author.id;
	const [universe] = await db
		.insert(universes)
		.values({ ownerId: authorId, name: 'U' })
		.returning();
	universeId = universe.id;
	const [story] = await db
		.insert(stories)
		.values({
			universeId: universe.id,
			ownerId: authorId,
			title: 'Book of Ash',
			author: 'A. Vane',
			visibility: 'public'
		})
		.returning();
	storyId = story.id;
	const [chapter] = await db
		.insert(chapters)
		.values({ storyId, title: 'The Caravan', position: 1 })
		.returning();
	const [scene] = await db
		.insert(scenes)
		.values({
			storyId,
			chapterId: chapter.id,
			globalPosition: 1,
			title: 'Departure',
			bodyMd: 'The gate opened.'
		})
		.returning();
	sceneId = scene.id;
});

afterAll(async () => {
	await pool.end();
});

describe('publishStory', () => {
	it('is gated on the admin-granted archive and a handle', async () => {
		expect(await publishStory(db, authorId, storyId)).toMatchObject({
			ok: false,
			reason: 'the site admin has not enabled your public archive'
		});
		await db.update(users).set({ publicArchiveEnabled: true }).where(eq(users.id, authorId));
	});

	it('freezes the prose into an edition', async () => {
		const result = await publishStory(db, authorId, storyId, 'First edition');
		expect(result).toMatchObject({ ok: true });

		const edition = await publicEdition(db, 'inkwright', storyId);
		expect(edition).toMatchObject({ title: 'Book of Ash', versionLabel: 'First edition' });
		const content = edition!.content as EditionContent;
		expect(content.chapters[0].title).toBe('The Caravan');
		expect(content.chapters[0].scenes[0].bodyMd).toBe('The gate opened.');
	});

	it('keeps the edition frozen while the draft moves on, until republish', async () => {
		await db.update(scenes).set({ bodyMd: 'The gate stayed shut.' }).where(eq(scenes.id, sceneId));
		let edition = await publicEdition(db, 'inkwright', storyId);
		expect((edition!.content as EditionContent).chapters[0].scenes[0].bodyMd).toBe(
			'The gate opened.'
		);

		const again = await publishStory(db, authorId, storyId);
		expect(again).toMatchObject({ ok: true });
		edition = await publicEdition(db, 'inkwright', storyId);
		expect((edition!.content as EditionContent).chapters[0].scenes[0].bodyMd).toBe(
			'The gate stayed shut.'
		);
		// Exactly one current edition.
		const all = await listPublications(db);
		expect(all.filter((row) => row.isCurrent)).toHaveLength(1);
		expect(all).toHaveLength(2);
	});
});

describe('shelf and visibility', () => {
	it('lists public stories on the shelf; unlisted stays direct-link only', async () => {
		expect(await publicShelf(db, 'inkwright')).toHaveLength(1);

		await db.update(stories).set({ visibility: 'unlisted' }).where(eq(stories.id, storyId));
		expect(await publicShelf(db, 'inkwright')).toHaveLength(0);
		expect(await publicEdition(db, 'inkwright', storyId)).not.toBeNull();

		await db.update(stories).set({ visibility: 'private' }).where(eq(stories.id, storyId));
		expect(await publicEdition(db, 'inkwright', storyId)).toBeNull();
		await db.update(stories).set({ visibility: 'public' }).where(eq(stories.id, storyId));
	});
});

describe('takedown and covers', () => {
	it('an admin takedown hides the edition without touching the source', async () => {
		const [current] = (await listPublications(db)).filter((row) => row.isCurrent);
		expect(await takedownPublication(db, current.id)).toBe(true);
		expect(await takedownPublication(db, current.id)).toBe(false);
		expect(await publicEdition(db, 'inkwright', storyId)).toBeNull();
		expect(await publicShelf(db, 'inkwright')).toHaveLength(0);
		const [scene] = await db.select().from(scenes).where(eq(scenes.id, sceneId));
		expect(scene.bodyMd).toBe('The gate stayed shut.');
	});

	it('treats a cover as public only while an edition is readable', async () => {
		const coverId = crypto.randomUUID();
		await db.update(stories).set({ coverAssetId: coverId }).where(eq(stories.id, storyId));
		// The only current edition is taken down.
		expect(await isPublicAsset(db, coverId)).toBe(false);
		await publishStory(db, authorId, storyId);
		expect(await isPublicAsset(db, coverId)).toBe(true);

		// Making the story private must stop the cover serving, matching
		// publicEdition; unlisted stays reachable by direct link.
		await db.update(stories).set({ visibility: 'private' }).where(eq(stories.id, storyId));
		expect(await isPublicAsset(db, coverId)).toBe(false);
		await db.update(stories).set({ visibility: 'unlisted' }).where(eq(stories.id, storyId));
		expect(await isPublicAsset(db, coverId)).toBe(true);
	});

	it('serves inline images of a readable edition, and stops on takedown', async () => {
		const [asset] = await db
			.insert(assets)
			.values({
				ownerId: authorId,
				universeId,
				kind: 'inline',
				filename: 'sketch.png',
				contentType: 'image/png',
				byteSize: 8,
				storageKey: 'codex-assets/sketch'
			})
			.returning();
		const [inlineStory] = await db
			.insert(stories)
			.values({ universeId, ownerId: authorId, title: 'Illustrated', visibility: 'public' })
			.returning();
		await db.insert(scenes).values({
			storyId: inlineStory.id,
			globalPosition: 1,
			bodyMd: `A picture: ![sketch](/assets/${asset.id})`
		});

		// Unreferenced until published.
		expect(await isPublicAsset(db, asset.id)).toBe(false);
		expect(await publishStory(db, authorId, inlineStory.id)).toMatchObject({ ok: true });
		expect(await isPublicAsset(db, asset.id)).toBe(true);

		const [current] = (await listPublications(db)).filter(
			(row) => row.title === 'Illustrated' && row.isCurrent
		);
		await takedownPublication(db, current.id);
		expect(await isPublicAsset(db, asset.id)).toBe(false);
	});
});

describe('public profile and avatar', () => {
	it('exposes the profile only while it is listed publicly', async () => {
		await db
			.update(users)
			.set({
				bioMd: 'Writes about salt and sea.',
				penName: 'A. Vane',
				links: [{ label: 'Site', url: 'https://vane.test' }],
				commissionsOpen: true,
				commissionsMd: 'Short fiction.',
				profilePublic: false
			})
			.where(eq(users.id, authorId));
		expect(await publicProfile(db, 'inkwright')).toBeNull();

		await db.update(users).set({ profilePublic: true }).where(eq(users.id, authorId));
		const profile = await publicProfile(db, 'inkwright');
		expect(profile).toMatchObject({
			penName: 'A. Vane',
			bioMd: 'Writes about salt and sea.',
			commissionsOpen: true,
			commissionsMd: 'Short fiction.'
		});
		expect(profile!.links).toEqual([{ label: 'Site', url: 'https://vane.test' }]);
	});

	it('serves the current avatar only while the profile is public', async () => {
		const [avatar] = await db
			.insert(assets)
			.values({
				ownerId: authorId,
				kind: 'avatar',
				filename: 'me.png',
				contentType: 'image/png',
				byteSize: 8,
				storageKey: 'codex-assets/me'
			})
			.returning();
		await db.update(users).set({ avatarAssetId: avatar.id }).where(eq(users.id, authorId));

		// profilePublic is true from the previous test.
		expect(await isPublicAvatar(db, avatar.id)).toBe(true);
		await db.update(users).set({ profilePublic: false }).where(eq(users.id, authorId));
		expect(await isPublicAvatar(db, avatar.id)).toBe(false);
		// A stale id (no longer the current avatar) never serves.
		await db
			.update(users)
			.set({ profilePublic: true, avatarAssetId: null })
			.where(eq(users.id, authorId));
		expect(await isPublicAvatar(db, avatar.id)).toBe(false);
	});
});

describe('concurrent publish', () => {
	it('the partial index forbids two current editions of one story', async () => {
		const [story] = await db
			.insert(stories)
			.values({ universeId, ownerId: authorId, title: 'Solo', visibility: 'public' })
			.returning();
		const row = {
			storyId: story.id,
			ownerId: authorId,
			handle: 'inkwright',
			title: 'Solo',
			content: { chapters: [], unfiled: [] },
			isCurrent: true
		};
		await db.insert(publications).values(row);
		// A second current row for the same story is the race the partial
		// unique index exists to stop.
		await expect(db.insert(publications).values(row)).rejects.toMatchObject({
			cause: { code: '23505' }
		});
	});
});
