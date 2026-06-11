import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import { stories, universes, users } from '../../src/lib/server/db/schema';
import {
	saveStoryPageSetup,
	saveUserPageSetup,
	storyPageSetup,
	storyPageSetupOverrides,
	userPageSetup
} from '../../src/lib/server/page-setup';
import { DEFAULT_PAGE_SETUP } from '../../src/lib/page-setup';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

let pool: pg.Pool;
let db: Database;
let userId: string;
let storyId: string;

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await pool.query('truncate table users cascade');
	const [user] = await db
		.insert(users)
		.values({ email: 'page@example.com', displayName: 'P', passwordHash: 'x', role: 'user' })
		.returning({ id: users.id });
	userId = user.id;
	const [universe] = await db
		.insert(universes)
		.values({ ownerId: userId, name: 'U' })
		.returning({ id: universes.id });
	const [story] = await db
		.insert(stories)
		.values({ universeId: universe.id, ownerId: userId, title: 'S' })
		.returning({ id: stories.id });
	storyId = story.id;
});

afterAll(async () => {
	await pool.end();
});

describe('page setup layering', () => {
	it('an untouched setup is the defaults', async () => {
		expect(await userPageSetup(db, userId)).toEqual(DEFAULT_PAGE_SETUP);
		expect(await storyPageSetup(db, storyId)).toEqual(DEFAULT_PAGE_SETUP);
	});

	it('account values flow into the story, story overrides win', async () => {
		await saveUserPageSetup(db, userId, { pageSize: '6x9', font: 'times' });
		await saveStoryPageSetup(db, storyId, { font: 'sans' });
		const setup = await storyPageSetup(db, storyId);
		expect(setup.pageSize).toBe('6x9');
		expect(setup.font).toBe('sans');
		expect(setup.margins).toBe('normal');
	});

	it('clearing an override falls back to the account setting again', async () => {
		await saveUserPageSetup(db, userId, { margins: 'wide' });
		await saveStoryPageSetup(db, storyId, { margins: 'narrow' });
		expect((await storyPageSetup(db, storyId)).margins).toBe('narrow');
		await saveStoryPageSetup(db, storyId, { margins: null });
		expect((await storyPageSetup(db, storyId)).margins).toBe('wide');
		expect(await storyPageSetupOverrides(db, storyId)).toEqual({});
	});

	it('a blank scene break is a real override, distinct from inherit', async () => {
		await saveUserPageSetup(db, userId, { sceneBreak: '~ ~ ~' });
		await saveStoryPageSetup(db, storyId, { sceneBreak: '' });
		expect((await storyPageSetup(db, storyId)).sceneBreak).toBe('');
		await saveStoryPageSetup(db, storyId, { sceneBreak: null });
		expect((await storyPageSetup(db, storyId)).sceneBreak).toBe('~ ~ ~');
	});

	it('boolean overrides carry false as a value', async () => {
		await saveUserPageSetup(db, userId, { pageNumbers: true });
		await saveStoryPageSetup(db, storyId, { pageNumbers: false });
		expect((await storyPageSetup(db, storyId)).pageNumbers).toBe(false);
	});

	it('junk stored in the columns normalises away', async () => {
		await saveUserPageSetup(db, userId, { pageSize: 'a0' as never });
		expect((await userPageSetup(db, userId)).pageSize).toBe('a4');
	});

	it('round-trips a custom font, custom line spacing, and default alignment', async () => {
		await saveUserPageSetup(db, userId, {
			font: 'custom',
			fontCustom: 'EB Garamond',
			lineSpacing: 'custom',
			lineSpacingCm: 0.85,
			textAlign: 'justify'
		});
		const setup = await userPageSetup(db, userId);
		expect(setup.font).toBe('custom');
		expect(setup.fontCustom).toBe('EB Garamond');
		expect(setup.lineSpacing).toBe('custom');
		expect(setup.lineSpacingCm).toBe(0.85);
		expect(setup.textAlign).toBe('justify');
	});

	it('a story can override the alignment and clear back to the account value', async () => {
		await saveUserPageSetup(db, userId, { textAlign: 'justify' });
		await saveStoryPageSetup(db, storyId, { textAlign: 'center' });
		expect((await storyPageSetup(db, storyId)).textAlign).toBe('center');
		await saveStoryPageSetup(db, storyId, { textAlign: null });
		expect((await storyPageSetup(db, storyId)).textAlign).toBe('justify');
	});
});
