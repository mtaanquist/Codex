import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { strFromU8, unzipSync } from 'fflate';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import {
	chapters,
	characters,
	scenes,
	stories,
	universes,
	users
} from '../../src/lib/server/db/schema';
import { buildAccountExport, type AssetLoader } from '../../src/lib/server/export';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

let pool: pg.Pool;
let db: Database;
let ownerId: string;

const ASSET_ID = '11111111-1111-1111-1111-111111111111';
const stubLoader: AssetLoader = async (ids) =>
	ids
		.filter((id) => id === ASSET_ID)
		.map((id) => ({ id, contentType: 'image/png', bytes: new Uint8Array([1, 2, 3]) }));

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await pool.query(
		'truncate table scenes, chapters, characters, stories, universes, users cascade'
	);
	const [owner] = await db
		.insert(users)
		.values({ email: 'export@example.com', displayName: 'Ex', passwordHash: 'x', role: 'user' })
		.returning();
	ownerId = owner.id;
});

afterAll(async () => {
	await pool.end();
});

function entries(bytes: Uint8Array) {
	const unzipped = unzipSync(bytes);
	return {
		names: Object.keys(unzipped),
		text: (path: string) => strFromU8(unzipped[path]),
		raw: (path: string) => unzipped[path]
	};
}

describe('buildAccountExport', () => {
	it('archives universes, entities, stories, scenes, and bundled assets', async () => {
		const [universe] = await db
			.insert(universes)
			.values({ ownerId, name: 'Mythos', descriptionMd: 'The world.' })
			.returning();
		await db.insert(characters).values({
			universeId: universe.id,
			ownerId,
			name: 'Alice Vane',
			aliases: ['Mrs. Fenwick'],
			summaryMd: 'A smuggler.',
			bodyMd: 'Long history.'
		});
		const [story] = await db
			.insert(stories)
			.values({ universeId: universe.id, ownerId, title: 'Halden' })
			.returning();
		const [chapter] = await db
			.insert(chapters)
			.values({ storyId: story.id, title: 'One', position: 1 })
			.returning();
		await db.insert(scenes).values({
			storyId: story.id,
			chapterId: chapter.id,
			globalPosition: 1,
			title: 'Departure',
			bodyMd: 'A picture ![x](/assets/11111111-1111-1111-1111-111111111111) here.'
		});

		const { bytes } = await buildAccountExport(db, ownerId, stubLoader);
		const zip = entries(bytes);

		expect(zip.text('universes/mythos/universe.md')).toContain('The world.');
		const character = zip.text('universes/mythos/characters/alice-vane.md');
		expect(character).toContain('"Mrs. Fenwick"');
		expect(character).toContain('A smuggler.');
		expect(character).toContain('Long history.');
		expect(zip.names).toContain('universes/mythos/stories/halden/story.md');

		const sceneFile = zip.names.find(
			(n) => n.includes('/stories/halden/chapters/') && n.endsWith('.md')
		);
		expect(sceneFile).toBeTruthy();
		// The asset link is rewritten to the bundled, depth-relative path.
		expect(zip.text(sceneFile!)).toContain('assets/11111111-1111-1111-1111-111111111111.png');
		expect(zip.raw('assets/11111111-1111-1111-1111-111111111111.png')).toEqual(
			new Uint8Array([1, 2, 3])
		);
	});

	it('produces a readable archive for an empty account', async () => {
		const { bytes } = await buildAccountExport(db, ownerId, stubLoader);
		expect(entries(bytes).names).toEqual(['README.md']);
	});
});
