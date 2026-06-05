import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { strFromU8, unzipSync } from 'fflate';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import { chapters, scenes, stories, universes, users } from '../../src/lib/server/db/schema';
import { buildStoryZip, gatherStory, type ExportStory } from '../../src/lib/server/export';
import { buildEpub } from '../../src/lib/server/epub';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

let pool: pg.Pool;
let db: Database;
let story: ExportStory & { coverAssetId: string | null };

const ASSET_ID = '0b154c2d-13ef-4f3c-9a85-2f1c0a9d8e11';
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

const loader = async (ids: string[]) =>
	ids
		.filter((id) => id === ASSET_ID)
		.map((id) => ({ id, contentType: 'image/png', bytes: new Uint8Array(PNG) }));

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
	await pool.query('truncate table scenes, chapters, stories, universes, users cascade');

	const [owner] = await db
		.insert(users)
		.values({ email: 'exp@example.com', displayName: 'E', passwordHash: 'x', role: 'user' })
		.returning();
	const [universe] = await db
		.insert(universes)
		.values({ ownerId: owner.id, name: 'U' })
		.returning();
	const [storyRow] = await db
		.insert(stories)
		.values({
			universeId: universe.id,
			ownerId: owner.id,
			title: 'Book of Ash',
			author: 'A. Vane',
			brief: 'A toll-road story.'
		})
		.returning();
	story = storyRow;
	const [chapter] = await db
		.insert(chapters)
		.values({ storyId: story.id, title: 'The Caravan', position: 1 })
		.returning();
	await db.insert(scenes).values([
		{
			storyId: story.id,
			chapterId: chapter.id,
			globalPosition: 1,
			title: 'Departure',
			bodyMd: `The gate *opened*.\n\n![gate](/assets/${ASSET_ID})`
		},
		{
			storyId: story.id,
			globalPosition: 2,
			title: 'Loose end',
			bodyMd: 'An unfiled thought.'
		}
	]);
});

afterAll(async () => {
	await pool.end();
});

describe('buildStoryZip', () => {
	it('lays out front-mattered files, bundles assets, and rewrites links', async () => {
		const { filename, bytes } = await buildStoryZip(story, await gatherStory(db, story), loader);
		expect(filename).toBe('book-of-ash.zip');
		const entries = unzipSync(bytes);
		const names = Object.keys(entries).sort();
		expect(names).toEqual([
			`book-of-ash/assets/${ASSET_ID}.png`,
			'book-of-ash/chapters/01-the-caravan/01-departure.md',
			'book-of-ash/story.md',
			'book-of-ash/unfiled/01-loose-end.md'
		]);

		const storyFile = strFromU8(entries['book-of-ash/story.md']);
		expect(storyFile).toContain('title: "Book of Ash"');
		expect(storyFile).toContain('author: "A. Vane"');

		const sceneFile = strFromU8(entries['book-of-ash/chapters/01-the-caravan/01-departure.md']);
		expect(sceneFile).toContain('title: "Departure"');
		expect(sceneFile).toContain(`![gate](../../assets/${ASSET_ID}.png)`);
		expect(Buffer.from(entries[`book-of-ash/assets/${ASSET_ID}.png`]).equals(PNG)).toBe(true);
	});
});

describe('buildEpub', () => {
	it('produces a structurally sound EPUB with rendered chapters', async () => {
		const { filename, bytes } = await buildEpub(story, await gatherStory(db, story), loader, null);
		expect(filename).toContain('.epub');
		const entries = unzipSync(bytes);

		// The mimetype entry must exist with the exact contents; fflate
		// preserves insertion order, so it is the first local file too.
		expect(strFromU8(entries['mimetype'])).toBe('application/epub+zip');
		expect(Object.keys(entries)[0]).toBe('mimetype');
		expect(strFromU8(entries['META-INF/container.xml'])).toContain('OEBPS/content.opf');

		const opf = strFromU8(entries['OEBPS/content.opf']);
		expect(opf).toContain('<dc:title>Book of Ash</dc:title>');
		expect(opf).toContain('<dc:creator>A. Vane</dc:creator>');
		expect(opf).toContain(`urn:uuid:${story.id}`);
		expect(opf).toContain('<itemref idref="ch1"/>');
		expect(opf).toContain('<itemref idref="unfiled"/>');
		expect(opf).toContain(`images/${ASSET_ID}.png`);

		const chapter = strFromU8(entries['OEBPS/ch1.xhtml']);
		expect(chapter).toContain('<h1>The Caravan</h1>');
		expect(chapter).toContain('<em>opened</em>');
		expect(chapter).toContain(`src="images/${ASSET_ID}.png"`);
		expect(entries[`OEBPS/images/${ASSET_ID}.png`]).toBeDefined();

		const nav = strFromU8(entries['OEBPS/nav.xhtml']);
		expect(nav).toContain('<a href="ch1.xhtml">The Caravan</a>');
	});
});
