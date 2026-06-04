import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import { chapters, scenes, stories, universes, users } from '../../src/lib/server/db/schema';
import {
	isPublishedCover,
	listPublications,
	publicEdition,
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
let storyId: string;
let sceneId: string;

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
	await pool.query(
		'truncate table publications, scenes, chapters, stories, universes, users cascade'
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
		expect(await isPublishedCover(db, coverId)).toBe(false);
		await publishStory(db, authorId, storyId);
		expect(await isPublishedCover(db, coverId)).toBe(true);
	});
});
