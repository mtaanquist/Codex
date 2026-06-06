import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { eq } from 'drizzle-orm';
import * as schema from '../../src/lib/server/db/schema';
import {
	characters,
	entityCategories,
	entityMentions,
	entityRelationships,
	loreEntries,
	places,
	relationTypes,
	revisions,
	scenes,
	stories,
	universes,
	users
} from '../../src/lib/server/db/schema';
import {
	entityHeat,
	isValidTimezone,
	relationshipLinks,
	storyProgress,
	writingActivity
} from '../../src/lib/server/insights';
import { addDays } from '../../src/lib/insights';
import type { Database } from '../../src/lib/server/auth';
import { ensureBuiltInRelationTypes, ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

let pool: pg.Pool;
let db: Database;
let universeId: string;
let storyAId: string;
let storyBId: string;
let scene2Id: string;
let scene3Id: string;
let aliceId: string;
let harborId: string;
let veilId: string;

// Times anchored mid-day so a revision never straddles a UTC day boundary.
const now = new Date();
const todayNoon = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12));
function daysAgo(days: number, hour = 12): Date {
	const date = new Date(todayNoon.getTime() - days * 24 * 60 * 60 * 1000);
	date.setUTCHours(hour);
	return date;
}
function prose(words: number): string {
	return 'word '.repeat(words).trim();
}

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
	await pool.query(
		'truncate table entity_relationships, revisions, entity_mentions, scenes, chapters, lore_entries, places, characters, entity_categories, stories, universes, users cascade'
	);
	await ensureBuiltInRelationTypes(pool);

	const [owner] = await db
		.insert(users)
		.values({ email: 'insights@example.com', displayName: 'I', passwordHash: 'x', role: 'user' })
		.returning();
	const [universe] = await db
		.insert(universes)
		.values({ ownerId: owner.id, name: 'U' })
		.returning();
	universeId = universe.id;
	const [storyA] = await db
		.insert(stories)
		.values({ universeId, ownerId: owner.id, title: 'Alpha', positionInSeries: 1 })
		.returning();
	storyAId = storyA.id;
	const [storyB] = await db
		.insert(stories)
		.values({ universeId, ownerId: owner.id, title: 'Beta', positionInSeries: 2 })
		.returning();
	storyBId = storyB.id;

	const sceneRows = await db
		.insert(scenes)
		.values([
			{ storyId: storyAId, globalPosition: 1, status: 'outline', wordCount: 0 },
			{ storyId: storyAId, globalPosition: 2, status: 'draft', wordCount: 1200 },
			{ storyId: storyAId, globalPosition: 3, status: 'final', wordCount: 800 }
		])
		.returning();
	scene2Id = sceneRows[1].id;
	scene3Id = sceneRows[2].id;

	const [category] = await db
		.insert(entityCategories)
		.values({ universeId, ownerId: owner.id, name: 'Cast', color: '#aa3366', sortOrder: 0 })
		.returning();
	const [alice] = await db
		.insert(characters)
		.values({
			universeId,
			ownerId: owner.id,
			name: 'Alice',
			bodyMd: 'A sailor.',
			categoryId: category.id
		})
		.returning();
	aliceId = alice.id;
	const [harbor] = await db
		.insert(places)
		.values({ universeId, ownerId: owner.id, name: 'Harbor', bodyMd: '  ' })
		.returning();
	harborId = harbor.id;
	const [veil] = await db
		.insert(loreEntries)
		.values({
			universeId,
			ownerId: owner.id,
			categoryId: category.id,
			title: 'The Veil',
			bodyMd: 'Thin here.'
		})
		.returning();
	veilId = veil.id;

	await db.insert(entityMentions).values([
		{
			sourceType: 'scene',
			sourceId: scene2Id,
			targetType: 'character',
			targetId: aliceId,
			position: 0,
			surroundingText: 'Alice'
		},
		{
			sourceType: 'scene',
			sourceId: scene2Id,
			targetType: 'character',
			targetId: aliceId,
			position: 40,
			surroundingText: 'Alice'
		},
		{
			sourceType: 'scene',
			sourceId: scene3Id,
			targetType: 'character',
			targetId: aliceId,
			position: 5,
			surroundingText: 'Alice'
		},
		{
			sourceType: 'scene',
			sourceId: scene3Id,
			targetType: 'lore_entry',
			targetId: veilId,
			position: 12,
			surroundingText: 'the Veil'
		}
	]);

	// Alice lives in Harbor, for the relationship web.
	const [livesIn] = await db
		.select({ id: relationTypes.id })
		.from(relationTypes)
		.where(eq(relationTypes.key, 'lives_in'));
	await db.insert(entityRelationships).values({
		universeId,
		ownerId: owner.id,
		fromType: 'character',
		fromId: aliceId,
		toType: 'place',
		toId: harborId,
		relationTypeId: livesIn.id
	});

	// Scene 2's history: a baseline from before the 30-day window, two saves
	// yesterday (only the later one counts for the day), one today. Scene 3
	// first appears inside the window.
	await db.insert(revisions).values([
		{ entityType: 'scene', entityId: scene2Id, bodyMd: prose(100), createdAt: daysAgo(40) },
		{ entityType: 'scene', entityId: scene2Id, bodyMd: prose(150), createdAt: daysAgo(1, 10) },
		{ entityType: 'scene', entityId: scene2Id, bodyMd: prose(180), createdAt: daysAgo(1, 11) },
		{ entityType: 'scene', entityId: scene2Id, bodyMd: prose(200), createdAt: daysAgo(0) },
		{ entityType: 'scene', entityId: scene3Id, bodyMd: prose(50), createdAt: daysAgo(0) }
	]);
});

afterAll(async () => {
	await pool.end();
});

describe('storyProgress', () => {
	it('aggregates words and status counts per story, in series order', async () => {
		const progress = await storyProgress(db, universeId);
		expect(progress.map((story) => story.title)).toEqual(['Alpha', 'Beta']);
		expect(progress[0]).toMatchObject({
			id: storyAId,
			sceneCount: 3,
			words: 2000,
			status: { outline: 1, draft: 1, revised: 0, final: 1 }
		});
		expect(progress[1]).toMatchObject({
			id: storyBId,
			sceneCount: 0,
			words: 0,
			status: { outline: 0, draft: 0, revised: 0, final: 0 }
		});
	});
});

describe('entityHeat', () => {
	it('counts mentions and scenes per entity, most mentioned first', async () => {
		const heat = await entityHeat(db, universeId);
		expect(heat.map((entity) => entity.name)).toEqual(['Alice', 'The Veil', 'Harbor']);
		expect(heat[0]).toMatchObject({
			id: aliceId,
			type: 'character',
			color: '#aa3366',
			hasBody: true,
			mentionCount: 3,
			sceneCount: 2
		});
		expect(heat[1]).toMatchObject({ id: veilId, type: 'lore_entry', mentionCount: 1 });
		expect(heat[2]).toMatchObject({
			id: harborId,
			type: 'place',
			color: null,
			hasBody: false,
			mentionCount: 0,
			sceneCount: 0
		});
	});
});

describe('writingActivity', () => {
	it('nets words per day against the pre-window baseline', async () => {
		const activity = await writingActivity(db, universeId, 'UTC');
		expect(activity.daily).toHaveLength(30);
		const yesterday = addDays(activity.today, -1);
		const byDay = new Map(activity.daily.map((d) => [d.day, d.words]));
		// Yesterday: scene 2 went 100 -> 180 (the later save wins the day).
		expect(byDay.get(yesterday)).toBe(80);
		// Today: scene 2 added 20, scene 3 appeared with 50.
		expect(byDay.get(activity.today)).toBe(70);
		// A quiet in-window day is zero-filled.
		expect(byDay.get(addDays(activity.today, -5))).toBe(0);
	});

	it('computes streaks from the year of revisions', async () => {
		const activity = await writingActivity(db, universeId, 'UTC');
		// Yesterday and today are consecutive; the 40-days-ago baseline day
		// stands alone.
		expect(activity.streak).toEqual({ current: 2, longest: 2 });
	});

	it('narrows to one story when asked', async () => {
		// The revisions all belong to story A, so its filter matches the
		// universe total and story B sees nothing.
		const storyA = await writingActivity(db, universeId, 'UTC', 1, storyAId);
		expect(storyA.daily.at(-1)?.words).toBe(70);
		const storyB = await writingActivity(db, universeId, 'UTC', 1, storyBId);
		expect(storyB.daily.at(-1)?.words).toBe(0);
	});

	it('an unknown universe yields an empty, zero-filled window', async () => {
		const activity = await writingActivity(db, '00000000-0000-0000-0000-000000000000', 'UTC');
		expect(activity.daily).toHaveLength(30);
		expect(activity.daily.every((d) => d.words === 0)).toBe(true);
		expect(activity.streak).toEqual({ current: 0, longest: 0 });
	});
});

describe('relationshipLinks', () => {
	it('returns the universe relationships with their type label and category', async () => {
		const links = await relationshipLinks(db, universeId);
		expect(links).toHaveLength(1);
		expect(links[0]).toMatchObject({
			fromId: aliceId,
			toId: harborId,
			label: 'lives in',
			category: 'geography'
		});
	});

	it('another universe sees nothing', async () => {
		expect(await relationshipLinks(db, '00000000-0000-0000-0000-000000000000')).toEqual([]);
	});
});

describe('isValidTimezone', () => {
	it('accepts IANA names and rejects junk', () => {
		expect(isValidTimezone('Europe/Copenhagen')).toBe(true);
		expect(isValidTimezone('UTC')).toBe(true);
		expect(isValidTimezone('Not/AZone')).toBe(false);
		expect(isValidTimezone('')).toBe(false);
	});
});
