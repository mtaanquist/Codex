import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { strFromU8, unzipSync } from 'fflate';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import {
	chapters,
	characters,
	characterStoryNotes,
	entityRelationships,
	places,
	relationTypes,
	reviewComments,
	reviewInvitations,
	reviewers,
	reviewThreads,
	revisions,
	scenes,
	stories,
	universes,
	users
} from '../../src/lib/server/db/schema';
import { buildAccountExport, type AssetLoader } from '../../src/lib/server/export';
import { reviewLoader } from '../../src/lib/server/export-reviews';
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
			(n) => n.includes('/stories/halden/chapters/') && !n.endsWith('chapter.md')
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

	it('archives story notes, relationships, and review feedback', async () => {
		const [universe] = await db.insert(universes).values({ ownerId, name: 'Mythos' }).returning();
		const [alice] = await db
			.insert(characters)
			.values({ universeId: universe.id, ownerId, name: 'Alice Vane' })
			.returning();
		const [corvin] = await db
			.insert(characters)
			.values({ universeId: universe.id, ownerId, name: 'Corvin' })
			.returning();
		await db.insert(places).values({ universeId: universe.id, ownerId, name: 'The Toll Road' });
		const [story] = await db
			.insert(stories)
			.values({ universeId: universe.id, ownerId, title: 'Halden' })
			.returning();
		const body = 'The gate opened on the toll road.';
		const [scene] = await db
			.insert(scenes)
			.values({ storyId: story.id, globalPosition: 1, title: 'Departure', bodyMd: body })
			.returning();

		await db
			.insert(characterStoryNotes)
			.values({ characterId: alice.id, storyId: story.id, notesMd: 'Limps in this book.' });

		// The truncate cascade clears the seeded built-ins, so insert one.
		const [allyOf] = await db
			.insert(relationTypes)
			.values({
				key: 'ally_of',
				forwardLabel: 'ally of',
				bidirectional: true,
				fromType: 'character',
				toType: 'character'
			})
			.returning();
		await db.insert(entityRelationships).values({
			universeId: universe.id,
			ownerId,
			fromType: 'character',
			fromId: alice.id,
			toType: 'character',
			toId: corvin.id,
			relationTypeId: allyOf.id,
			notesMd: 'Since the siege.'
		});

		const [invitation] = await db
			.insert(reviewInvitations)
			.values({ storyId: story.id, createdBy: ownerId, tokenHash: 'hash' })
			.returning();
		const [reviewer] = await db
			.insert(reviewers)
			.values({ invitationId: invitation.id, displayName: 'Maren' })
			.returning();
		const [base] = await db
			.insert(revisions)
			.values({ entityType: 'scene', entityId: scene.id, bodyMd: body })
			.returning();
		const anchorStart = body.indexOf('toll road');
		const [anchored] = await db
			.insert(reviewThreads)
			.values({
				storyId: story.id,
				sceneId: scene.id,
				anchorStart,
				anchorEnd: anchorStart + 'toll road'.length,
				baseRevisionId: base.id,
				resolvedAt: new Date()
			})
			.returning();
		const [wholeScene] = await db
			.insert(reviewThreads)
			.values({ storyId: story.id, sceneId: scene.id })
			.returning();
		await db.insert(reviewComments).values([
			{ threadId: anchored.id, authorReviewerId: reviewer.id, bodyMd: 'Rename this road.' },
			{ threadId: wholeScene.id, authorReviewerId: reviewer.id, bodyMd: 'Pacing drags here.' },
			{ threadId: wholeScene.id, authorUserId: ownerId, bodyMd: 'Will tighten.' }
		]);

		const { bytes } = await buildAccountExport(db, ownerId, stubLoader, reviewLoader(db));
		const zip = entries(bytes);

		const note = zip.text('universes/mythos/stories/halden/notes/characters/alice-vane.md');
		expect(note).toContain('kind: "character"');
		expect(note).toContain('Limps in this book.');

		const relationships = zip.text('universes/mythos/relationships.md');
		expect(relationships.startsWith('# Relationships')).toBe(true);
		expect(relationships).toContain(
			'- Alice Vane (character) - ally of - Corvin (character)\n  Since the siege.'
		);

		const reviews = zip.text('universes/mythos/stories/halden/reviews.md');
		expect(reviews.startsWith('# Review feedback')).toBe(true);
		expect(reviews).toContain('## Departure (resolved)');
		expect(reviews).toContain('> toll road');
		expect(reviews).toContain('## Departure (open)');
		expect(reviews).toContain('> On the whole scene.');
		expect(reviews).toContain('Maren (reviewer),');
		expect(reviews).toContain('Ex (author),');
		expect(reviews).toContain('Will tighten.');
	});
});
