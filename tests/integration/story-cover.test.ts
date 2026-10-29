import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import type pg from 'pg';
import { stories, universes, users } from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/auth';
import { CATEGORY_PALETTE } from '../../src/lib/entity-color';
import { ensureTestDatabase } from './test-db';

// The story settings action reads the app's db; point it at the test database.
vi.mock('#lib/server/db', async () => {
	const { default: pgModule } = await import('pg');
	const { drizzle } = await import('drizzle-orm/node-postgres');
	const schemaModule = await import('../../src/lib/server/db/schema');
	const { TEST_DATABASE_URL } = await import('./test-db');
	const testPool = new pgModule.Pool({ connectionString: TEST_DATABASE_URL });
	return { db: drizzle(testPool, { schema: schemaModule }), pool: testPool };
});

const { db, pool } = (await import('#lib/server/db')) as unknown as {
	db: Database;
	pool: pg.Pool;
};
const { createStoryInUniverse } = await import('../../src/lib/server/story-create');
const settings = await import('../../src/routes/stories/[id]/settings/[[section]]/+page.server');

let user: { id: string };
let universeId: string;

beforeAll(async () => {
	await ensureTestDatabase();
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await pool.query('truncate table stories, universes, users cascade');
	[user] = await db
		.insert(users)
		.values({ email: 'cover@example.com', displayName: 'C', passwordHash: 'x', role: 'user' })
		.returning();
	const [universe] = await db
		.insert(universes)
		.values({ ownerId: user.id, name: 'Ardenfall', slug: 'ardenfall' })
		.returning();
	universeId = universe.id;
});

afterAll(async () => {
	await pool.end();
});

function saveDetails(storyId: string, fields: Record<string, string>) {
	const form = new FormData();
	for (const [key, value] of Object.entries(fields)) form.set(key, value);
	return settings.actions.update({
		params: { id: storyId },
		locals: { user, session: null },
		request: new Request('http://localhost/', { method: 'POST', body: form })
	} as never);
}

async function storedColor(storyId: string) {
	const [row] = await db
		.select({ coverColor: stories.coverColor })
		.from(stories)
		.where(eq(stories.id, storyId));
	return row.coverColor;
}

describe('story cover colour', () => {
	it('gives a new story a palette colour', async () => {
		const story = await createStoryInUniverse(db, user.id, universeId, 'The Toll');
		expect(CATEGORY_PALETTE).toContain(story.coverColor);
	});

	it('saves a palette colour from story settings', async () => {
		const story = await createStoryInUniverse(db, user.id, universeId, 'The Toll');
		const result = await saveDetails(story.id, {
			title: 'The Toll',
			coverColor: 'var(--cat-rose)'
		});
		expect(result).toMatchObject({ saved: true });
		expect(await storedColor(story.id)).toBe('var(--cat-rose)');
	});

	it('rejects a colour outside the palette and keeps the stored one', async () => {
		const story = await createStoryInUniverse(db, user.id, universeId, 'The Toll');
		const before = await storedColor(story.id);
		const result = await saveDetails(story.id, {
			title: 'The Toll',
			coverColor: 'red; background: url(https://example.com/x)'
		});
		expect(result).toMatchObject({ status: 400 });
		expect(await storedColor(story.id)).toBe(before);
	});

	it('leaves the colour alone when the form has no colour field', async () => {
		const story = await createStoryInUniverse(db, user.id, universeId, 'The Toll');
		const before = await storedColor(story.id);
		await saveDetails(story.id, { title: 'The Toll', brief: 'A brief.' });
		expect(await storedColor(story.id)).toBe(before);
	});
});
