import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { and, eq, isNull } from 'drizzle-orm';
import { isHttpError } from '@sveltejs/kit';
import type pg from 'pg';
import {
	characters,
	characterStoryMemberships,
	entityCategories,
	entityRelationships,
	loreEntries,
	mentionPins,
	notes,
	places,
	relationTypes,
	revisions,
	sceneMarkers,
	scenes,
	stories,
	universes,
	users
} from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/auth';
import { ensureBuiltInRelationTypes, ensureTestDatabase } from './test-db';

// Authorization lives in the route handlers, so these tests call the real
// handlers as user B with user A's ids and expect a refusal that leaves the
// database untouched. Each route also has one call as user A that succeeds,
// which proves the payload would have passed validation.

// The handlers import the app's db; point it at the test database.
vi.mock('$lib/server/db', async () => {
	const { default: pgModule } = await import('pg');
	const { drizzle } = await import('drizzle-orm/node-postgres');
	const schemaModule = await import('../../src/lib/server/db/schema');
	const { TEST_DATABASE_URL } = await import('./test-db');
	const testPool = new pgModule.Pool({ connectionString: TEST_DATABASE_URL });
	return { db: drizzle(testPool, { schema: schemaModule }), pool: testPool };
});

// Queueing would start pg-boss, email and S3 would reach the network; stub
// every function export and keep the constants.
async function stubFunctions<T extends Record<string, unknown>>(load: () => Promise<T>) {
	const actual = await load();
	return Object.fromEntries(
		Object.entries(actual).map(([key, value]) => [
			key,
			typeof value === 'function' ? vi.fn(async () => undefined) : value
		])
	);
}
vi.mock('$lib/server/jobs', (importOriginal) => stubFunctions(importOriginal));
vi.mock('$lib/server/email', (importOriginal) => stubFunctions(importOriginal));
vi.mock('$lib/server/s3-client', (importOriginal) => stubFunctions(importOriginal));

const { db, pool } = (await import('$lib/server/db')) as unknown as {
	db: Database;
	pool: pg.Pool;
};
const { resetRateLimits } = await import('$lib/server/rate-limit');
const { ownedScene } = await import('$lib/server/scene-access');

const sceneRoute = await import('../../src/routes/api/scenes/[id=uuid]/+server');
const sceneMarkersRoute = await import('../../src/routes/api/scenes/[id=uuid]/markers/+server');
const sceneSplitRoute = await import('../../src/routes/api/scenes/[id=uuid]/split/+server');
const revisionsRoute = await import('../../src/routes/api/revisions/+server');
const restoreRoute = await import('../../src/routes/api/revisions/[id=uuid]/restore/+server');
const notesRoute = await import('../../src/routes/api/notes/+server');
const noteRoute = await import('../../src/routes/api/notes/[id=uuid]/+server');
const characterRoute = await import('../../src/routes/api/characters/[id=uuid]/+server');
const placeRoute = await import('../../src/routes/api/places/[id=uuid]/+server');
const loreRoute = await import('../../src/routes/api/lore/[id=uuid]/+server');
const markerRoute = await import('../../src/routes/api/markers/[id=uuid]/+server');
const relationshipsRoute = await import('../../src/routes/api/relationships/+server');
const relationshipRoute = await import('../../src/routes/api/relationships/[id=uuid]/+server');
const duplicateRoute = await import('../../src/routes/api/stories/[id]/duplicate-scene/+server');
const mergeRoute = await import('../../src/routes/api/stories/[id]/merge-scenes/+server');
const sceneOrderRoute = await import('../../src/routes/api/stories/[id]/scene-order/+server');
const membersRoute = await import('../../src/routes/api/stories/[id]/members/+server');
const mentionPinsRoute = await import('../../src/routes/api/stories/[id]/mention-pins/+server');
const storyEntitiesRoute = await import('../../src/routes/api/stories/[id]/entities/+server');
const proposalRoute = await import('../../src/routes/api/stories/[id]/assistant-proposal/+server');
const proseReplaceRoute = await import('../../src/routes/api/universes/[id]/prose-replace/+server');
const cardRoute = await import('../../src/routes/api/entities/[id=uuid]/card/+server');
const reviewRoute = await import('../../src/routes/api/assistant/review/+server');
const recapRoute = await import('../../src/routes/api/assistant/recap/+server');
const adminPage = await import('../../src/routes/admin/[[section]]/+page.server');

type TestUser = { id: string; email: string; role: 'user' | 'admin' };
type Seed = Awaited<ReturnType<typeof seed>>;

let s: Seed;
let A: TestUser;
let B: TestUser;

beforeAll(async () => {
	await ensureTestDatabase();
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await pool.query('truncate table users cascade');
	await ensureBuiltInRelationTypes(pool);
	resetRateLimits();
	s = await seed();
	A = s.userA;
	B = s.userB;
});

afterAll(async () => {
	await pool.end();
});

async function seed() {
	const [a] = await db
		.insert(users)
		.values({ email: 'authz-a@example.com', displayName: 'A', passwordHash: 'x', role: 'user' })
		.returning();
	const [b] = await db
		.insert(users)
		.values({ email: 'authz-b@example.com', displayName: 'B', passwordHash: 'x', role: 'user' })
		.returning();
	const userA: TestUser = { id: a.id, email: a.email, role: 'user' };
	const userB: TestUser = { id: b.id, email: b.email, role: 'user' };

	const [universeA] = await db
		.insert(universes)
		.values({ ownerId: a.id, name: 'UA', slug: 'ua' })
		.returning();
	const [universeB] = await db
		.insert(universes)
		.values({ ownerId: b.id, name: 'UB', slug: 'ub' })
		.returning();
	const [storyA] = await db
		.insert(stories)
		.values({ universeId: universeA.id, ownerId: a.id, title: 'SA', slug: 'sa' })
		.returning();
	const [storyB] = await db
		.insert(stories)
		.values({ universeId: universeB.id, ownerId: b.id, title: 'SB', slug: 'sb' })
		.returning();
	const [sceneA1] = await db
		.insert(scenes)
		.values({ storyId: storyA.id, globalPosition: 1, bodyMd: 'Alpha walks in. Second part here.' })
		.returning();
	const [sceneA2] = await db
		.insert(scenes)
		.values({ storyId: storyA.id, globalPosition: 2, bodyMd: 'Alpha leaves.' })
		.returning();
	const [sceneB1] = await db
		.insert(scenes)
		.values({ storyId: storyB.id, globalPosition: 1, bodyMd: 'B prose. More B prose.' })
		.returning();
	const [categoryA] = await db
		.insert(entityCategories)
		.values({ universeId: universeA.id, ownerId: a.id, name: 'Lore', sortOrder: 0 })
		.returning();
	const [charA1] = await db
		.insert(characters)
		.values({ universeId: universeA.id, ownerId: a.id, name: 'Alpha', bodyMd: 'A body' })
		.returning();
	const [charA2] = await db
		.insert(characters)
		.values({ universeId: universeA.id, ownerId: a.id, name: 'Beta', bodyMd: 'B body' })
		.returning();
	const [charB] = await db
		.insert(characters)
		.values({ universeId: universeB.id, ownerId: b.id, name: 'Gamma', bodyMd: 'G body' })
		.returning();
	const [placeA] = await db
		.insert(places)
		.values({ universeId: universeA.id, ownerId: a.id, name: 'Harbour', bodyMd: 'Wet' })
		.returning();
	const [loreA] = await db
		.insert(loreEntries)
		.values({
			universeId: universeA.id,
			ownerId: a.id,
			categoryId: categoryA.id,
			title: 'Old law',
			bodyMd: 'Rules'
		})
		.returning();
	const [noteA] = await db
		.insert(notes)
		.values({ ownerId: a.id, universeId: universeA.id, storyId: storyA.id, bodyMd: 'A note' })
		.returning();
	const [markerA] = await db
		.insert(sceneMarkers)
		.values({ sceneId: sceneA1.id, ownerId: a.id, anchorStart: 0, anchorEnd: 5 })
		.returning();
	const [friendOf] = await db
		.select()
		.from(relationTypes)
		.where(and(eq(relationTypes.key, 'friend_of'), isNull(relationTypes.universeId)));
	const [rivalOf] = await db
		.select()
		.from(relationTypes)
		.where(and(eq(relationTypes.key, 'rival_of'), isNull(relationTypes.universeId)));
	const [relationshipA] = await db
		.insert(entityRelationships)
		.values({
			universeId: universeA.id,
			ownerId: a.id,
			fromType: 'character',
			fromId: charA1.id,
			toType: 'character',
			toId: charA2.id,
			relationTypeId: friendOf.id
		})
		.returning();
	const [revisionA] = await db
		.insert(revisions)
		.values({ entityType: 'scene', entityId: sceneA1.id, bodyMd: 'An older draft.' })
		.returning();
	await db.insert(characterStoryMemberships).values({ characterId: charA1.id, storyId: storyA.id });
	await db
		.insert(mentionPins)
		.values({ storyId: storyA.id, name: 'Al', targetType: 'character', targetId: charA1.id });

	return {
		userA,
		userB,
		universeA,
		universeB,
		storyA,
		storyB,
		sceneA1,
		sceneA2,
		sceneB1,
		charA1,
		charA2,
		charB,
		placeA,
		loreA,
		noteA,
		markerA,
		relationshipA,
		revisionA,
		friendOf,
		rivalOf
	};
}

// Every row of every application table, so a refused call can be shown to
// have written nothing anywhere.
async function snapshot(): Promise<string[]> {
	const { rows: tables } = await pool.query<{ name: string }>(
		`select table_name as name from information_schema.tables
		 where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`
	);
	const union = tables
		.map(({ name }) => `select '${name}' as t, to_jsonb(x)::text as r from "${name}" x`)
		.join(' union all ');
	const { rows } = await pool.query<{ t: string; r: string }>(union);
	return rows.map((row) => `${row.t} ${row.r}`).sort();
}

type Handler = (event: never) => unknown;

function event(
	user: TestUser | null,
	options: {
		params?: Record<string, string>;
		body?: unknown;
		method?: string;
		path?: string;
		form?: FormData;
	} = {}
) {
	const url = new URL(`http://localhost${options.path ?? '/'}`);
	const method = options.method ?? 'POST';
	const init: RequestInit = { method };
	if (options.form) {
		init.body = options.form;
	} else if (options.body !== undefined) {
		init.body = JSON.stringify(options.body);
		init.headers = { 'content-type': 'application/json' };
	}
	return {
		params: options.params ?? {},
		url,
		request: new Request(url, init),
		locals: { user, session: null },
		cookies: { get: vi.fn(), set: vi.fn(), delete: vi.fn(), getAll: vi.fn(() => []) },
		getClientAddress: () => '127.0.0.1'
	};
}

// The HTTP status a handler answered with, whether it returned a Response or
// threw a SvelteKit HttpError.
async function statusOf(handler: Handler, ev: ReturnType<typeof event>): Promise<number> {
	try {
		const result = await handler(ev as never);
		if (result instanceof Response) return result.status;
		throw new Error(`handler returned ${JSON.stringify(result)} instead of a Response`);
	} catch (err) {
		if (isHttpError(err)) return err.status;
		throw err;
	}
}

async function expectRefused(handler: Handler, ev: ReturnType<typeof event>, status = 404) {
	const before = await snapshot();
	expect(await statusOf(handler, ev)).toBe(status);
	expect(await snapshot()).toEqual(before);
}

async function expectAllowed(handler: Handler, ev: ReturnType<typeof event>, status = 200) {
	expect(await statusOf(handler, ev)).toBe(status);
}

describe('ownedScene', () => {
	it('returns the scene to its owner', async () => {
		const row = await ownedScene(db, A.id, s.sceneA1.id);
		expect(row?.id).toBe(s.sceneA1.id);
	});

	it('returns null for another user', async () => {
		expect(await ownedScene(db, B.id, s.sceneA1.id)).toBeNull();
	});

	it('returns null for a trashed scene unless asked for the trash', async () => {
		await db.update(scenes).set({ deletedAt: new Date() }).where(eq(scenes.id, s.sceneA1.id));
		expect(await ownedScene(db, A.id, s.sceneA1.id)).toBeNull();
		expect((await ownedScene(db, A.id, s.sceneA1.id, { deleted: true }))?.id).toBe(s.sceneA1.id);
		expect(await ownedScene(db, B.id, s.sceneA1.id, { deleted: true })).toBeNull();
	});

	it('returns null for a live scene when asked for the trash', async () => {
		expect(await ownedScene(db, A.id, s.sceneA1.id, { deleted: true })).toBeNull();
	});

	it('returns null for an unknown id', async () => {
		expect(await ownedScene(db, A.id, '00000000-0000-4000-8000-000000000000')).toBeNull();
	});
});

describe('scene routes refuse another user', () => {
	it('PUT /api/scenes/[id]', async () => {
		const body = { title: 'Taken', bodyMd: 'Overwritten by B.' };
		await expectRefused(
			sceneRoute.PUT,
			event(B, { method: 'PUT', params: { id: s.sceneA1.id }, body })
		);
		await expectAllowed(
			sceneRoute.PUT,
			event(A, { method: 'PUT', params: { id: s.sceneA1.id }, body })
		);
	});

	it('PATCH /api/scenes/[id]', async () => {
		const body = { status: 'final' };
		await expectRefused(
			sceneRoute.PATCH,
			event(B, { method: 'PATCH', params: { id: s.sceneA1.id }, body })
		);
		await expectAllowed(
			sceneRoute.PATCH,
			event(A, { method: 'PATCH', params: { id: s.sceneA1.id }, body })
		);
	});

	it('POST /api/scenes/[id]/markers', async () => {
		const body = { anchorStart: 0, anchorEnd: 5, bodyMd: 'check' };
		await expectRefused(sceneMarkersRoute.POST, event(B, { params: { id: s.sceneA1.id }, body }));
		await expectAllowed(
			sceneMarkersRoute.POST,
			event(A, { params: { id: s.sceneA1.id }, body }),
			201
		);
	});

	it('POST /api/scenes/[id]/split', async () => {
		const offset = 'Alpha walks in. '.length;
		// The offset path maps every split failure, a foreign scene included, to
		// 400; it is still refused before any write.
		await expectRefused(
			sceneSplitRoute.POST,
			event(B, { params: { id: s.sceneA1.id }, body: { offset } }),
			400
		);
		await expectRefused(
			sceneSplitRoute.POST,
			event(B, { params: { id: s.sceneA1.id }, body: { before: 'Second part here.' } })
		);
		await expectAllowed(
			sceneSplitRoute.POST,
			event(A, { params: { id: s.sceneA1.id }, body: { offset } })
		);
	});
});

describe('revision routes refuse another user', () => {
	it('POST /api/revisions', async () => {
		const targets = [
			{ entityType: 'scene', entityId: s.sceneA1.id },
			{ entityType: 'character', entityId: s.charA1.id },
			{ entityType: 'place', entityId: s.placeA.id },
			{ entityType: 'lore_entry', entityId: s.loreA.id },
			{ entityType: 'note', entityId: s.noteA.id }
		];
		for (const target of targets) {
			await expectRefused(revisionsRoute.POST, event(B, { body: { ...target, label: 'Mine' } }));
		}
		await expectAllowed(
			revisionsRoute.POST,
			event(A, { body: { ...targets[0], label: 'Mine' } }),
			201
		);
	});

	it('POST /api/revisions/[id]/restore', async () => {
		await expectRefused(
			restoreRoute.POST,
			event(B, {
				params: { id: s.revisionA.id },
				body: { entityType: 'scene', entityId: s.sceneA1.id }
			})
		);
		// A's revision cannot be restored onto B's own scene either.
		await expectRefused(
			restoreRoute.POST,
			event(B, {
				params: { id: s.revisionA.id },
				body: { entityType: 'scene', entityId: s.sceneB1.id }
			})
		);
		await expectAllowed(
			restoreRoute.POST,
			event(A, {
				params: { id: s.revisionA.id },
				body: { entityType: 'scene', entityId: s.sceneA1.id }
			})
		);
	});
});

describe('note routes refuse another user', () => {
	it('POST /api/notes', async () => {
		await expectRefused(
			notesRoute.POST,
			event(B, { body: { storyId: s.storyA.id, title: 'Jot', bodyMd: 'B was here' } })
		);
		// B's own story with A's scene is refused as a scene outside the story.
		await expectRefused(
			notesRoute.POST,
			event(B, { body: { storyId: s.storyB.id, sceneId: s.sceneA1.id, bodyMd: 'B was here' } }),
			400
		);
		await expectAllowed(
			notesRoute.POST,
			event(A, { body: { storyId: s.storyA.id, sceneId: s.sceneA1.id, bodyMd: 'A jot' } })
		);
	});

	it('PUT /api/notes/[id]', async () => {
		const body = { title: 'Taken', bodyMd: 'Overwritten by B.' };
		await expectRefused(
			noteRoute.PUT,
			event(B, { method: 'PUT', params: { id: s.noteA.id }, body })
		);
		await expectAllowed(
			noteRoute.PUT,
			event(A, { method: 'PUT', params: { id: s.noteA.id }, body })
		);
	});
});

describe('entity routes refuse another user', () => {
	const cases = [
		{ name: 'characters', route: () => characterRoute.PUT, id: () => s.charA1.id, tags: 'aliases' },
		{ name: 'places', route: () => placeRoute.PUT, id: () => s.placeA.id, tags: 'aliases' },
		{ name: 'lore', route: () => loreRoute.PUT, id: () => s.loreA.id, tags: 'keywords' }
	];
	for (const entity of cases) {
		it(`PUT /api/${entity.name}/[id]`, async () => {
			const body = { name: 'Renamed', [entity.tags]: ['Ren'], summaryMd: 'S', bodyMd: 'Taken' };
			await expectRefused(
				entity.route(),
				event(B, { method: 'PUT', params: { id: entity.id() }, body })
			);
			await expectAllowed(
				entity.route(),
				event(A, { method: 'PUT', params: { id: entity.id() }, body })
			);
		});
	}

	it('PUT /api/characters/[id] refuses B attaching story notes to A story', async () => {
		await expectRefused(
			characterRoute.PUT,
			event(B, {
				method: 'PUT',
				params: { id: s.charB.id },
				body: { name: 'Gamma', bodyMd: 'G body', storyId: s.storyA.id, storyNotesMd: 'x' }
			})
		);
	});

	it('GET /api/entities/[id]/card', async () => {
		for (const id of [s.charA1.id, s.placeA.id, s.loreA.id]) {
			await expectRefused(cardRoute.GET, event(B, { method: 'GET', params: { id } }));
			await expectAllowed(cardRoute.GET, event(A, { method: 'GET', params: { id } }));
		}
	});
});

describe('marker routes refuse another user', () => {
	it('PUT /api/markers/[id]', async () => {
		const body = { resolved: true };
		await expectRefused(
			markerRoute.PUT,
			event(B, { method: 'PUT', params: { id: s.markerA.id }, body })
		);
		await expectAllowed(
			markerRoute.PUT,
			event(A, { method: 'PUT', params: { id: s.markerA.id }, body })
		);
	});

	it('DELETE /api/markers/[id]', async () => {
		await expectRefused(
			markerRoute.DELETE,
			event(B, { method: 'DELETE', params: { id: s.markerA.id } })
		);
		await expectAllowed(
			markerRoute.DELETE,
			event(A, { method: 'DELETE', params: { id: s.markerA.id } })
		);
	});
});

describe('relationship routes refuse another user', () => {
	it('POST /api/relationships', async () => {
		const body = {
			fromKind: 'character',
			fromId: s.charA1.id,
			relationTypeId: s.rivalOf.id,
			toId: s.charA2.id
		};
		await expectRefused(relationshipsRoute.POST, event(B, { body }));
		// From B's own character to A's is refused as an unknown target.
		await expectRefused(
			relationshipsRoute.POST,
			event(B, { body: { ...body, fromId: s.charB.id, toId: s.charA1.id } })
		);
		await expectAllowed(relationshipsRoute.POST, event(A, { body }), 201);
	});

	it('DELETE /api/relationships/[id]', async () => {
		const params = { id: s.relationshipA.id };
		await expectRefused(relationshipRoute.DELETE, event(B, { method: 'DELETE', params }));
		await expectAllowed(relationshipRoute.DELETE, event(A, { method: 'DELETE', params }));
	});
});

describe('story routes refuse another user', () => {
	it('POST /api/stories/[id]/duplicate-scene', async () => {
		const body = { sceneId: s.sceneA1.id };
		await expectRefused(duplicateRoute.POST, event(B, { params: { id: s.storyA.id }, body }));
		// B's own story with A's scene: refused (as 400) by the scene lookup.
		await expectRefused(duplicateRoute.POST, event(B, { params: { id: s.storyB.id }, body }), 400);
		await expectAllowed(duplicateRoute.POST, event(A, { params: { id: s.storyA.id }, body }));
	});

	it('POST /api/stories/[id]/merge-scenes', async () => {
		const body = { sceneIds: [s.sceneA1.id, s.sceneA2.id] };
		await expectRefused(mergeRoute.POST, event(B, { params: { id: s.storyA.id }, body }));
		await expectRefused(mergeRoute.POST, event(B, { params: { id: s.storyB.id }, body }), 400);
		await expectAllowed(mergeRoute.POST, event(A, { params: { id: s.storyA.id }, body }));
	});

	it('PUT /api/stories/[id]/scene-order', async () => {
		const body = { chapters: [], orphanSceneIds: [s.sceneA2.id, s.sceneA1.id] };
		await expectRefused(
			sceneOrderRoute.PUT,
			event(B, { method: 'PUT', params: { id: s.storyA.id }, body })
		);
		// A's scenes cannot be pulled into B's own story's order.
		await expectRefused(
			sceneOrderRoute.PUT,
			event(B, {
				method: 'PUT',
				params: { id: s.storyB.id },
				body: { chapters: [], orphanSceneIds: [s.sceneB1.id, s.sceneA1.id] }
			}),
			400
		);
		await expectAllowed(
			sceneOrderRoute.PUT,
			event(A, { method: 'PUT', params: { id: s.storyA.id }, body })
		);
	});

	it('PUT /api/stories/[id]/members', async () => {
		const declare = { kind: 'character', entityId: s.charA2.id, member: true };
		const remove = { kind: 'character', entityId: s.charA1.id, member: false };
		for (const body of [declare, remove]) {
			await expectRefused(
				membersRoute.PUT,
				event(B, { method: 'PUT', params: { id: s.storyA.id }, body })
			);
		}
		await expectRefused(
			membersRoute.PUT,
			event(B, { method: 'PUT', params: { id: s.storyB.id }, body: declare })
		);
		await expectRefused(
			membersRoute.PUT,
			event(B, {
				method: 'PUT',
				params: { id: s.storyB.id },
				body: { kind: 'place', entityId: s.placeA.id, member: true }
			})
		);
		await expectAllowed(
			membersRoute.PUT,
			event(A, { method: 'PUT', params: { id: s.storyA.id }, body: declare })
		);
	});

	it('POST and DELETE /api/stories/[id]/mention-pins', async () => {
		const pin = { name: 'Bet', targetType: 'character', targetId: s.charA2.id };
		await expectRefused(
			mentionPinsRoute.POST,
			event(B, { params: { id: s.storyA.id }, body: pin })
		);
		await expectRefused(
			mentionPinsRoute.POST,
			event(B, { params: { id: s.storyB.id }, body: { ...pin, targetId: s.charA1.id } })
		);
		await expectRefused(
			mentionPinsRoute.DELETE,
			event(B, { method: 'DELETE', params: { id: s.storyA.id }, body: { name: 'Al' } })
		);
		await expectAllowed(
			mentionPinsRoute.POST,
			event(A, { params: { id: s.storyA.id }, body: pin })
		);
		await expectAllowed(
			mentionPinsRoute.DELETE,
			event(A, { method: 'DELETE', params: { id: s.storyA.id }, body: { name: 'Al' } })
		);
	});

	it('POST /api/stories/[id]/entities', async () => {
		const body = { type: 'character', name: 'Planted' };
		await expectRefused(storyEntitiesRoute.POST, event(B, { params: { id: s.storyA.id }, body }));
		await expectAllowed(storyEntitiesRoute.POST, event(A, { params: { id: s.storyA.id }, body }));
	});

	it('POST /api/stories/[id]/assistant-proposal', async () => {
		const body = { sceneId: s.sceneA1.id, before: 'Second part here.', confirmed: null };
		await expectRefused(proposalRoute.POST, event(B, { params: { id: s.storyA.id }, body }));
		await expectAllowed(proposalRoute.POST, event(A, { params: { id: s.storyA.id }, body }));
	});
});

describe('universe routes refuse another user', () => {
	it('GET /api/universes/[id]/prose-replace', async () => {
		const params = { id: s.universeA.id };
		const path = '/api/universes/x/prose-replace?q=Alpha';
		await expectRefused(proseReplaceRoute.GET, event(B, { method: 'GET', params, path }));
		await expectAllowed(proseReplaceRoute.GET, event(A, { method: 'GET', params, path }));
	});

	it('POST /api/universes/[id]/prose-replace', async () => {
		const params = { id: s.universeA.id };
		const body = { find: 'Alpha', replace: 'Omega' };
		await expectRefused(proseReplaceRoute.POST, event(B, { params, body }));
		await expectAllowed(proseReplaceRoute.POST, event(A, { params, body }));
	});
});

// Only the refusal is exercised: the ownership check runs before the
// Assistant gate, so no model endpoint is needed. A success call would need one.
describe('assistant routes refuse another user', () => {
	it('POST /api/assistant/review', async () => {
		await expectRefused(reviewRoute.POST, event(B, { body: { sceneId: s.sceneA1.id } }));
	});

	it('POST /api/assistant/recap', async () => {
		await expectRefused(
			recapRoute.POST,
			event(B, { body: { storyId: s.storyA.id, sceneId: s.sceneA1.id } })
		);
	});
});

describe('admin actions refuse a non-admin', () => {
	function adminForm(targetId: string) {
		const form = new FormData();
		form.set('userId', targetId);
		form.set('id', targetId);
		form.set('code', 'ABCD');
		form.set('mode', 'open');
		form.set('allowance', '5');
		form.set('email', 'someone@example.com');
		form.set('policy', 'any');
		return form;
	}

	it('has actions to check', () => {
		expect(Object.keys(adminPage.actions).length).toBeGreaterThan(10);
	});

	for (const [name, action] of Object.entries(adminPage.actions)) {
		it(`${name} refuses a signed-in non-admin and a missing user`, async () => {
			for (const user of [B, null]) {
				await expectRefused(
					action as Handler,
					event(user, { path: `/admin?/${name}`, form: adminForm(A.id) })
				);
			}
		});
	}
});
