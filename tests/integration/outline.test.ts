import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import { chapters, scenes, stories, universes, users } from '../../src/lib/server/db/schema';
import {
	applyOutlineOrder,
	createOutlineNode,
	deleteOutlineNode,
	listOutline,
	moveOutlineNode,
	saveOutlineNode
} from '../../src/lib/server/outline';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

let pool: pg.Pool;
let db: Database;
let ownerId: string;
let strangerId: string;
let storyId: string;
let sceneId: string;
let actOne: string;
let actTwo: string;
let beatA: string;

async function titles() {
	return (await listOutline(db, storyId)).map((node) => `${'-'.repeat(node.depth)}${node.title}`);
}

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
	await pool.query(
		'truncate table outline_nodes, scenes, chapters, stories, universes, users cascade'
	);

	const [owner] = await db
		.insert(users)
		.values({ email: 'out@example.com', displayName: 'Out', passwordHash: 'x', role: 'user' })
		.returning();
	ownerId = owner.id;
	const [stranger] = await db
		.insert(users)
		.values({ email: 'out2@example.com', displayName: 'Out2', passwordHash: 'x', role: 'user' })
		.returning();
	strangerId = stranger.id;
	const [universe] = await db.insert(universes).values({ ownerId, name: 'U' }).returning();
	const [story] = await db
		.insert(stories)
		.values({ universeId: universe.id, ownerId, title: 'S' })
		.returning();
	storyId = story.id;
	const [scene] = await db
		.insert(scenes)
		.values({ storyId, globalPosition: 1, title: 'Opening' })
		.returning();
	sceneId = scene.id;
});

afterAll(async () => {
	await pool.end();
});

describe('outline tree', () => {
	it('creates root nodes in order', async () => {
		actOne = (await createOutlineNode(db, storyId, 'Act one')).id;
		actTwo = (await createOutlineNode(db, storyId, 'Act two')).id;
		expect(await titles()).toEqual(['Act one', 'Act two']);
	});

	it('creates children under a parent and lists depth-first', async () => {
		beatA = (await createOutlineNode(db, storyId, 'The gate', actOne)).id;
		await createOutlineNode(db, storyId, 'The toll', actOne);
		expect(await titles()).toEqual(['Act one', '-The gate', '-The toll', 'Act two']);
	});

	it('saves title, body, and a scene link, validating the scene', async () => {
		const saved = await saveOutlineNode(db, beatA, ownerId, {
			title: 'The gate opens',
			bodyMd: 'Alice pays.',
			linkedSceneId: sceneId
		});
		expect(saved).toMatchObject({ ok: true });
		const [node] = await listOutline(db, storyId).then((nodes) =>
			nodes.filter((candidate) => candidate.id === beatA)
		);
		expect(node).toMatchObject({ title: 'The gate opens', linkedSceneId: sceneId });

		const foreignScene = await saveOutlineNode(db, beatA, ownerId, {
			title: 'X',
			bodyMd: '',
			linkedSceneId: crypto.randomUUID()
		});
		expect(foreignScene).toMatchObject({ ok: false, reason: 'linked scene not found' });

		const [chapter] = await db
			.insert(chapters)
			.values({ storyId, title: 'Ch 1', position: 1 })
			.returning();
		const both = await saveOutlineNode(db, beatA, ownerId, {
			title: 'X',
			bodyMd: '',
			linkedSceneId: sceneId,
			linkedChapterId: chapter.id
		});
		expect(both).toMatchObject({ ok: false });

		const stranger = await saveOutlineNode(db, beatA, strangerId, {
			title: 'X',
			bodyMd: ''
		});
		expect(stranger).toMatchObject({ ok: false, reason: 'outline node not found' });
	});

	it('reorders siblings and rejects a partial order', async () => {
		const children = (await listOutline(db, storyId)).filter((node) => node.parentId === actOne);
		const reversed = children.map((node) => node.id).reverse();
		expect(await applyOutlineOrder(db, storyId, actOne, reversed)).toMatchObject({ ok: true });
		expect(await titles()).toEqual(['Act one', '-The toll', '-The gate opens', 'Act two']);

		expect(await applyOutlineOrder(db, storyId, actOne, [reversed[0]])).toMatchObject({
			ok: false
		});
	});

	it('indents under the previous sibling and refuses with none', async () => {
		expect(await moveOutlineNode(db, actTwo, ownerId, 'indent')).toMatchObject({ ok: true });
		expect(await titles()).toEqual(['Act one', '-The toll', '-The gate opens', '-Act two']);
		expect(await moveOutlineNode(db, actOne, ownerId, 'indent')).toMatchObject({
			ok: false,
			reason: 'nothing to indent under'
		});
	});

	it('outdents back to just after the parent', async () => {
		expect(await moveOutlineNode(db, actTwo, ownerId, 'outdent')).toMatchObject({ ok: true });
		expect(await titles()).toEqual(['Act one', '-The toll', '-The gate opens', 'Act two']);
		expect(await moveOutlineNode(db, actTwo, ownerId, 'outdent')).toMatchObject({
			ok: false,
			reason: 'already at the top level'
		});
	});

	it('promotes children when a node is deleted', async () => {
		expect(await deleteOutlineNode(db, actOne, strangerId)).toBe(false);
		expect(await deleteOutlineNode(db, actOne, ownerId)).toBe(true);
		expect(await titles()).toEqual(['Act two', 'The toll', 'The gate opens']);
	});
});
