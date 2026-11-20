import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import {
	characters,
	entityMentions,
	scenes,
	stories,
	universes,
	users
} from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/auth';
import type { GatewayDeps } from '../../src/lib/server/llm/gateway';
import type { HttpRequest, Provider } from '../../src/lib/server/llm/providers/types';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';
import {
	rebuildSceneMentions,
	rebuildUniverseMentions,
	reconcileMentions
} from '../../src/lib/server/mentions';
import { setSceneStatus } from '../../src/lib/server/scene-status';
import { trashScene } from '../../src/lib/server/scene-lifecycle';
import { applySceneOrder } from '../../src/lib/server/scene-order';

// Storing the account API key encrypts it with APP_SECRET (needed for enrich).
process.env.APP_SECRET = process.env.APP_SECRET || 'entity-enrich-test-secret';

const { stageEntitySuggestions, decideEntitySuggestion, listPendingForEntity } =
	await import('../../src/lib/server/entity-suggestions');
const { enrichEntity, enrichUniverse } = await import('../../src/lib/server/llm/enrich');
const { saveAccountLlmConfig, saveModelPricing, saveStoryLlmOverride, saveUniverseModels } =
	await import('../../src/lib/server/llm/config');

const enrichJson =
	'{"aliases":["The Grey"],"details":[{"label":"Eyes","value":"grey"}],"summary":"A weary swordsman."}';
// The last prompt the stub was sent, to check which passages reached it, and
// how many completions it served.
let lastPrompt = '';
let lastModel = '';
let calls = 0;
// Set to 'length' to have the stub report a reply cut off at the cap.
let finish: 'length' | undefined;
// Runs while the stub is answering, to land a change mid-call.
let duringCall: (() => Promise<void>) | null = null;
const stubProvider: Provider = {
	async *chatStream() {
		yield { type: 'done' };
	},
	async respond(req) {
		lastPrompt = JSON.stringify(req.messages);
		lastModel = req.model;
		calls += 1;
		if (duringCall) await duringCall();
		return { content: enrichJson, toolCalls: [], finishReason: finish };
	},
	async listModels() {
		return [];
	}
};
const noHttp: HttpRequest = async () => {
	throw new Error('the injected provider should not call the transport');
};
const deps: GatewayDeps = { provider: stubProvider, http: noHttp };

let pool: pg.Pool;
let db: Database;
let ownerId: string;
let strangerId: string;
let universeId: string;
let storyId: string;

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	finish = undefined;
	await pool.query(
		'truncate table entity_suggestions, entity_mentions, revisions, characters, stories, universes, users cascade'
	);
	const [owner] = await db
		.insert(users)
		.values({ email: 'o@example.com', displayName: 'Olwen', passwordHash: 'x', role: 'user' })
		.returning({ id: users.id });
	ownerId = owner.id;
	const [stranger] = await db
		.insert(users)
		.values({ email: 's@example.com', displayName: 'Sam', passwordHash: 'x', role: 'user' })
		.returning({ id: users.id });
	strangerId = stranger.id;
	const [universe] = await db
		.insert(universes)
		.values({ ownerId, name: 'Aldermoor' })
		.returning({ id: universes.id });
	universeId = universe.id;
	const [story] = await db
		.insert(stories)
		.values({ universeId, ownerId, title: 'The Tide Below' })
		.returning({ id: stories.id });
	storyId = story.id;
});

afterAll(async () => {
	await pool.end();
});

async function makeCharacter(over: Partial<typeof characters.$inferInsert> = {}) {
	const [c] = await db
		.insert(characters)
		.values({ universeId, ownerId, name: 'Bram', ...over })
		.returning({ id: characters.id });
	return c.id;
}

async function readChar(id: string) {
	const [row] = await db
		.select({
			aliases: characters.aliases,
			details: characters.details,
			summaryMd: characters.summaryMd
		})
		.from(characters)
		.where(eq(characters.id, id));
	return row;
}

describe('stageEntitySuggestions', () => {
	it('drops duplicates of existing aliases, detail labels, and an existing summary', async () => {
		const id = await makeCharacter({
			aliases: ['Al'],
			details: [{ label: 'Eyes', value: 'grey' }],
			summaryMd: 'A swordsman.'
		});
		const staged = await stageEntitySuggestions(db, {
			ownerId,
			kind: 'character',
			entityId: id,
			proposals: [
				{ field: 'alias', value: 'Al' }, // dup
				{ field: 'alias', value: 'The Grey' }, // new
				{ field: 'detail', label: 'Eyes', value: 'blue' }, // dup label
				{ field: 'detail', label: 'Age', value: '40' }, // new
				{ field: 'summary', value: 'ignored' } // has a summary
			]
		});
		const fields = staged.map((s) => `${s.field}:${s.label ?? s.value}`);
		expect(fields).toContain('alias:The Grey');
		expect(fields).toContain('detail:Age');
		expect(fields).not.toContain('alias:Al');
		expect(fields.some((f) => f.startsWith('summary'))).toBe(false);
	});

	it('does not stage again what the writer rejected', async () => {
		const id = await makeCharacter();
		const first = await stageEntitySuggestions(db, {
			ownerId,
			kind: 'character',
			entityId: id,
			proposals: [
				{ field: 'alias', value: 'The Grey' },
				{ field: 'detail', label: 'Eyes', value: 'blue' }
			]
		});
		for (const s of first) await decideEntitySuggestion(db, ownerId, s.id, 'reject');
		const again = await stageEntitySuggestions(db, {
			ownerId,
			kind: 'character',
			entityId: id,
			proposals: [
				{ field: 'alias', value: 'the grey' }, // rejected, any case
				{ field: 'detail', label: 'Eyes', value: 'Blue' }, // rejected pair
				{ field: 'detail', label: 'Eyes', value: 'grey' } // same label, new value
			]
		});
		expect(again.map((s) => `${s.field}:${s.label ?? ''}:${s.value}`)).toEqual([
			'detail:Eyes:grey'
		]);
	});

	it('never stages a summary again once one was rejected', async () => {
		const id = await makeCharacter();
		const [first] = await stageEntitySuggestions(db, {
			ownerId,
			kind: 'character',
			entityId: id,
			proposals: [{ field: 'summary', value: 'A weary swordsman.' }]
		});
		await decideEntitySuggestion(db, ownerId, first.id, 'reject');
		const again = await stageEntitySuggestions(db, {
			ownerId,
			kind: 'character',
			entityId: id,
			proposals: [{ field: 'summary', value: 'A different summary.' }]
		});
		expect(again).toEqual([]);
	});
});

describe('decideEntitySuggestion', () => {
	it('accepting an alias adds it to the entity and clears the suggestion', async () => {
		const id = await makeCharacter();
		const [s] = await stageEntitySuggestions(db, {
			ownerId,
			kind: 'character',
			entityId: id,
			proposals: [{ field: 'alias', value: 'The Grey' }]
		});
		const result = await decideEntitySuggestion(db, ownerId, s.id, 'accept');
		expect(result.ok).toBe(true);
		expect((await readChar(id)).aliases).toContain('The Grey');
		expect(await listPendingForEntity(db, ownerId, 'character', id)).toHaveLength(0);
	});

	it('accepting a detail keeps a detail saved while the accept waited', async () => {
		const id = await makeCharacter({ details: [{ label: 'Age', value: '40' }] });
		const [s] = await stageEntitySuggestions(db, {
			ownerId,
			kind: 'character',
			entityId: id,
			proposals: [{ field: 'detail', label: 'Eyes', value: 'grey' }]
		});
		// A save in flight: it holds the row until it commits.
		const save = await pool.connect();
		try {
			await save.query('begin');
			await save.query('update characters set details = $1 where id = $2', [
				JSON.stringify([
					{ label: 'Age', value: '40' },
					{ label: 'Scar', value: 'left cheek' }
				]),
				id
			]);
			const accept = decideEntitySuggestion(db, ownerId, s.id, 'accept');
			await new Promise((resolve) => setTimeout(resolve, 200));
			await save.query('commit');
			expect((await accept).ok).toBe(true);
		} finally {
			save.release();
		}
		expect((await readChar(id)).details).toEqual([
			{ label: 'Age', value: '40' },
			{ label: 'Scar', value: 'left cheek' },
			{ label: 'Eyes', value: 'grey' }
		]);
	});

	it('accepting the same detail twice at once applies it once', async () => {
		const id = await makeCharacter();
		const [s] = await stageEntitySuggestions(db, {
			ownerId,
			kind: 'character',
			entityId: id,
			proposals: [{ field: 'detail', label: 'Eyes', value: 'grey' }]
		});
		const results = await Promise.all([
			decideEntitySuggestion(db, ownerId, s.id, 'accept'),
			decideEntitySuggestion(db, ownerId, s.id, 'accept')
		]);
		expect(results.map((r) => r.ok).sort()).toEqual([false, true]);
		expect((await readChar(id)).details).toEqual([{ label: 'Eyes', value: 'grey' }]);
	});

	it('does not reject a suggestion that was already accepted', async () => {
		const id = await makeCharacter();
		const [s] = await stageEntitySuggestions(db, {
			ownerId,
			kind: 'character',
			entityId: id,
			proposals: [{ field: 'alias', value: 'The Grey' }]
		});
		await decideEntitySuggestion(db, ownerId, s.id, 'accept');
		// A reject sent from a tab that still shows it pending.
		expect((await decideEntitySuggestion(db, ownerId, s.id, 'reject')).ok).toBe(false);
		const [row] = await db
			.select({ status: schema.entitySuggestions.status })
			.from(schema.entitySuggestions)
			.where(eq(schema.entitySuggestions.id, s.id));
		expect(row.status).toBe('accepted');
	});

	it('accepting a detail and a summary applies each to the entity', async () => {
		const id = await makeCharacter();
		const staged = await stageEntitySuggestions(db, {
			ownerId,
			kind: 'character',
			entityId: id,
			proposals: [
				{ field: 'detail', label: 'Eyes', value: 'grey' },
				{ field: 'summary', value: 'A weary swordsman.' }
			]
		});
		for (const s of staged) await decideEntitySuggestion(db, ownerId, s.id, 'accept');
		const c = await readChar(id);
		expect(c.details).toContainEqual({ label: 'Eyes', value: 'grey' });
		expect(c.summaryMd).toBe('A weary swordsman.');
	});

	it('never replaces a summary the writer wrote after the suggestion was staged', async () => {
		const id = await makeCharacter();
		const [s] = await stageEntitySuggestions(db, {
			ownerId,
			kind: 'character',
			entityId: id,
			proposals: [{ field: 'summary', value: 'A weary swordsman.' }]
		});
		await db.update(characters).set({ summaryMd: 'My own words.' }).where(eq(characters.id, id));
		const result = await decideEntitySuggestion(db, ownerId, s.id, 'accept');
		expect(result.ok).toBe(false);
		expect((await readChar(id)).summaryMd).toBe('My own words.');
	});

	it('rejecting leaves the entity untouched', async () => {
		const id = await makeCharacter();
		const [s] = await stageEntitySuggestions(db, {
			ownerId,
			kind: 'character',
			entityId: id,
			proposals: [{ field: 'alias', value: 'The Grey' }]
		});
		await decideEntitySuggestion(db, ownerId, s.id, 'reject');
		expect((await readChar(id)).aliases).not.toContain('The Grey');
		expect(await listPendingForEntity(db, ownerId, 'character', id)).toHaveLength(0);
	});

	it('does not let a stranger decide a suggestion', async () => {
		const id = await makeCharacter();
		const [s] = await stageEntitySuggestions(db, {
			ownerId,
			kind: 'character',
			entityId: id,
			proposals: [{ field: 'alias', value: 'The Grey' }]
		});
		const result = await decideEntitySuggestion(db, strangerId, s.id, 'accept');
		expect(result.ok).toBe(false);
		expect((await readChar(id)).aliases).not.toContain('The Grey');
	});
});

describe('enrichEntity', () => {
	const enableAssistant = () =>
		saveAccountLlmConfig(db, ownerId, {
			enabled: true,
			assistantName: '',
			persona: 'balanced',
			endpoint: 'https://api.example.com/v1',
			apiKey: 'sk',
			models: { chat: 'chat-model' },
			toolCallBudget: 8
		});

	async function mention(inStoryId: string, entityId: string, text: string) {
		const [scene] = await db
			.insert(scenes)
			.values({ storyId: inStoryId, globalPosition: 1, title: `Scene of ${text}` })
			.returning({ id: scenes.id });
		await db.insert(entityMentions).values({
			sourceType: 'scene',
			sourceId: scene.id,
			targetType: 'character',
			targetId: entityId,
			position: 0,
			surroundingText: text
		});
	}

	it('stages the aliases, details, and summary the Assistant returns', async () => {
		await enableAssistant();
		const id = await makeCharacter();
		const staged = await enrichEntity(
			db,
			{ userId: ownerId, scope: { storyId }, entityId: id },
			deps
		);
		const fields = staged.map((s) => s.field);
		expect(fields).toContain('alias');
		expect(fields).toContain('detail');
		expect(fields).toContain('summary');
		expect(await listPendingForEntity(db, ownerId, 'character', id)).toHaveLength(staged.length);
	});

	it('reads appearances from every story at universe scope, and only this one at story scope', async () => {
		await enableAssistant();
		const id = await makeCharacter();
		const [other] = await db
			.insert(stories)
			.values({ universeId, ownerId, title: 'The Salt Road' })
			.returning({ id: stories.id });
		await mention(storyId, id, 'Bram at the harbour');
		await mention(other.id, id, 'Bram on the road');

		await enrichEntity(db, { userId: ownerId, scope: { universeId }, entityId: id }, deps);
		expect(lastPrompt).toContain('Bram at the harbour');
		expect(lastPrompt).toContain('Bram on the road');
		expect(lastPrompt).toContain('The Salt Road');

		await enrichEntity(db, { userId: ownerId, scope: { storyId }, entityId: id }, deps);
		expect(lastPrompt).toContain('Bram at the harbour');
		expect(lastPrompt).not.toContain('Bram on the road');
	});

	it('does not ask for a summary once the writer rejected one', async () => {
		await enableAssistant();
		const id = await makeCharacter();
		const staged = await enrichEntity(
			db,
			{ userId: ownerId, scope: { storyId }, entityId: id },
			deps
		);
		expect(lastPrompt).not.toContain('do not propose a summary');
		const summary = staged.find((s) => s.field === 'summary')!;
		await decideEntitySuggestion(db, ownerId, summary.id, 'reject');

		const again = await enrichEntity(
			db,
			{ userId: ownerId, scope: { storyId }, entityId: id },
			deps
		);
		expect(lastPrompt).toContain('do not propose a summary');
		expect(again.some((s) => s.field === 'summary')).toBe(false);
	});

	it('stages nothing for an entity outside the given universe', async () => {
		await enableAssistant();
		const id = await makeCharacter();
		const [elsewhere] = await db
			.insert(universes)
			.values({ ownerId, name: 'Elsewhere' })
			.returning({ id: universes.id });
		const staged = await enrichEntity(
			db,
			{ userId: ownerId, scope: { universeId: elsewhere.id }, entityId: id },
			deps
		);
		expect(staged).toEqual([]);
	});
});

describe('enrichUniverse', () => {
	beforeEach(async () => {
		calls = 0;
		await saveAccountLlmConfig(db, ownerId, {
			enabled: true,
			assistantName: '',
			persona: 'balanced',
			endpoint: 'https://api.example.com/v1',
			apiKey: 'sk',
			models: { chat: 'chat-model' },
			toolCallBudget: 8
		});
	});

	async function sceneMentioning(entityId: string, text: string) {
		const [scene] = await db
			.insert(scenes)
			.values({ storyId, globalPosition: 1, title: 'Harbour' })
			.returning({ id: scenes.id });
		await db.insert(entityMentions).values({
			sourceType: 'scene',
			sourceId: scene.id,
			targetType: 'character',
			targetId: entityId,
			position: 0,
			surroundingText: text
		});
		return scene.id;
	}

	// A scene indexed the way the worker does it, so the mention rows are real.
	async function sceneWithProse(bodyMd: string, globalPosition = 1) {
		const [scene] = await db
			.insert(scenes)
			.values({ storyId, globalPosition, title: 'Harbour', bodyMd })
			.returning({ id: scenes.id });
		await rebuildSceneMentions(db, scene.id);
		return scene.id;
	}

	async function rewrite(sceneId: string, bodyMd: string) {
		await db.update(scenes).set({ bodyMd }).where(eq(scenes.id, sceneId));
		await rebuildSceneMentions(db, sceneId);
	}

	it('reads on the model chosen for the universe (#1266)', async () => {
		await makeCharacter({ name: 'Bram' });
		await sceneWithProse('Bram at the harbour.');
		await saveUniverseModels(db, universeId, { utility: 'universe-model' });
		await enrichUniverse(db, { userId: ownerId, universeId }, deps);
		expect(lastModel).toBe('universe-model');
	});

	it('reads an entity again when its prose changes while it is being read', async () => {
		await makeCharacter({ name: 'Bram' });
		const sceneId = await sceneWithProse('Bram at the harbour.');
		duringCall = async () => {
			duringCall = null;
			await rewrite(sceneId, 'Bram on the quay.');
		};
		try {
			expect((await enrichUniverse(db, { userId: ownerId, universeId }, deps)).entities).toBe(1);
		} finally {
			duringCall = null;
		}
		expect(lastPrompt).toContain('Bram at the harbour.');
		// Stored with what was sent, so the pass after it reads the new passage.
		expect((await enrichUniverse(db, { userId: ownerId, universeId }, deps)).entities).toBe(1);
		expect(lastPrompt).toContain('Bram on the quay.');
		expect(calls).toBe(2);
		expect(await enrichUniverse(db, { userId: ownerId, universeId }, deps)).toMatchObject({
			entities: 0,
			unchanged: 1
		});
		expect(calls).toBe(2);
	});

	it('reads only mentioned entities, and skips them until their prose changes', async () => {
		const mentioned = await makeCharacter({ name: 'Bram' });
		const unmentioned = await makeCharacter({ name: 'Cass' });
		const sceneId = await sceneWithProse('Bram at the harbour.');

		const first = await enrichUniverse(db, { userId: ownerId, universeId }, deps);
		expect(first).toMatchObject({ entities: 1, failed: 0 });
		expect(first.staged).toBeGreaterThan(0);
		expect(calls).toBe(1);
		const [marked] = await db
			.select({ at: characters.assistantEnrichedAt })
			.from(characters)
			.where(eq(characters.id, mentioned));
		expect(marked.at).not.toBeNull();
		const [skipped] = await db
			.select({ at: characters.assistantEnrichedAt })
			.from(characters)
			.where(eq(characters.id, unmentioned));
		expect(skipped.at).toBeNull();

		const second = await enrichUniverse(db, { userId: ownerId, universeId }, deps);
		expect(second).toMatchObject({ entities: 0, staged: 0 });
		expect(calls).toBe(1);

		await rewrite(sceneId, 'Bram on the quay.');
		const third = await enrichUniverse(db, { userId: ownerId, universeId }, deps);
		expect(third.entities).toBe(1);
		expect(calls).toBe(2);
	});

	it('reads an entity newly mentioned in a story once the story is unmuted', async () => {
		await makeCharacter({ name: 'Bram' });
		await makeCharacter({ name: 'Cass' });
		const sceneId = await sceneWithProse('Bram at the harbour.');
		expect((await enrichUniverse(db, { userId: ownerId, universeId }, deps)).entities).toBe(1);
		await saveStoryLlmOverride(db, storyId, { enabled: false });
		await rewrite(sceneId, 'Bram and Cass at the harbour.');
		expect((await enrichUniverse(db, { userId: ownerId, universeId }, deps)).entities).toBe(0);
		expect(calls).toBe(1);

		await saveStoryLlmOverride(db, storyId, { enabled: null });
		expect((await enrichUniverse(db, { userId: ownerId, universeId }, deps)).entities).toBe(2);
		expect(calls).toBe(3);
	});

	it('reads an entity again when its name changes, not when what is recorded on it does', async () => {
		const bram = await makeCharacter({ name: 'Bram', summaryMd: 'A sailor.' });
		await sceneMentioning(bram, 'Bram at the harbour');
		const pass = () => enrichUniverse(db, { userId: ownerId, universeId }, deps);
		expect((await pass()).entities).toBe(1);
		await db.update(characters).set({ name: 'Bram Tull' }).where(eq(characters.id, bram));
		expect((await pass()).entities).toBe(1);
		expect(calls).toBe(2);
		// The entry's own aliases, details, summary and notes do not make it
		// worth reading the same passages again.
		for (const change of [
			{ aliases: ['The Grey'] },
			{ details: [{ label: 'Eyes', value: 'grey' }] },
			{ summaryMd: 'A captain.', bodyMd: 'Notes.' }
		]) {
			await db.update(characters).set(change).where(eq(characters.id, bram));
			expect(await pass()).toMatchObject({ entities: 0, unchanged: 1 });
		}
		expect(calls).toBe(2);
	});

	it('does not read an entity again because its suggestions were accepted', async () => {
		const bram = await makeCharacter({ name: 'Bram' });
		await sceneWithProse('Bram at the harbour.');
		const pass = () => enrichUniverse(db, { userId: ownerId, universeId }, deps);
		expect((await pass()).entities).toBe(1);
		const staged = await listPendingForEntity(db, ownerId, 'character', bram);
		expect(staged.map((s) => s.field).sort()).toEqual(['alias', 'detail', 'summary']);
		for (const suggestion of staged) {
			expect((await decideEntitySuggestion(db, ownerId, suggestion.id, 'accept')).ok).toBe(true);
			expect(await pass()).toMatchObject({ entities: 0, unchanged: 1 });
		}
		expect((await readChar(bram)).aliases).toContain('The Grey');
		expect(calls).toBe(1);
	});

	it('reads an entity once more when an accepted alias finds new passages', async () => {
		const bram = await makeCharacter({ name: 'Bram' });
		await sceneWithProse('Bram at the harbour.');
		await sceneWithProse('The Grey walked the quay alone.', 2);
		const pass = () => enrichUniverse(db, { userId: ownerId, universeId }, deps);
		expect((await pass()).entities).toBe(1);
		const alias = (await listPendingForEntity(db, ownerId, 'character', bram)).find(
			(s) => s.field === 'alias'
		)!;
		expect((await decideEntitySuggestion(db, ownerId, alias.id, 'accept')).ok).toBe(true);
		// Before the reindex the passages are the same, so nothing is sent.
		expect((await pass()).entities).toBe(0);
		await rebuildUniverseMentions(db, universeId);
		expect((await pass()).entities).toBe(1);
		expect(lastPrompt).toContain('walked the quay');
		expect((await pass()).entities).toBe(0);
		expect(calls).toBe(2);
	});

	it('reads an entity again when a scene it was read from is deleted', async () => {
		const bram = await makeCharacter({ name: 'Bram', summaryMd: 'A sailor.' });
		await sceneMentioning(bram, 'Bram at the harbour');
		const sceneId = await sceneMentioning(bram, 'Bram on the road');
		const pass = () => enrichUniverse(db, { userId: ownerId, universeId }, deps);
		expect((await pass()).entities).toBe(1);
		expect(await trashScene(db, ownerId, sceneId)).toBe(true);
		expect((await pass()).entities).toBe(1);
		expect(lastPrompt).not.toContain('Bram on the road');
		expect(calls).toBe(2);
	});

	it('does not read an entity again for a status change, a reorder, or an edit away from it', async () => {
		await makeCharacter({ name: 'Bram' });
		const filler = ' The tide ran out over the flats.'.repeat(6);
		const sceneId = await sceneWithProse(`Bram at the harbour.${filler}`);
		const otherId = await sceneWithProse('An empty quay.', 2);
		expect((await enrichUniverse(db, { userId: ownerId, universeId }, deps)).entities).toBe(1);

		expect(await setSceneStatus(db, ownerId, sceneId, 'revised')).toBe(true);
		const order = { chapters: [], orphanSceneIds: [otherId, sceneId] };
		expect((await applySceneOrder(db, storyId, order)).ok).toBe(true);
		// Neither touches the prose, so neither leaves the mention index behind.
		expect(await reconcileMentions(db)).toBe(0);
		// Text added far from the only mention leaves the passage the model reads as it was.
		await rewrite(sceneId, `Bram at the harbour.${filler} The boats came in.`);

		expect((await enrichUniverse(db, { userId: ownerId, universeId }, deps)).entities).toBe(0);
		expect(calls).toBe(1);
	});

	it('reads an entity again when an accepted alias links it to an older scene', async () => {
		const bram = await makeCharacter({ name: 'Bram' });
		await sceneWithProse('Bram at the harbour.');
		await sceneWithProse('The Grey walked the wall at dusk.', 2);
		await enrichUniverse(db, { userId: ownerId, universeId }, deps);
		expect(lastPrompt).not.toContain('walked the wall');

		// The pass suggested The Grey as an alias; the writer accepts it.
		const pending = await listPendingForEntity(db, ownerId, 'character', bram);
		const alias = pending.find((s) => s.field === 'alias' && s.value === 'The Grey')!;
		expect((await decideEntitySuggestion(db, ownerId, alias.id, 'accept')).ok).toBe(true);
		await rebuildUniverseMentions(db, universeId);

		expect((await enrichUniverse(db, { userId: ownerId, universeId }, deps)).entities).toBe(1);
		expect(lastPrompt).toContain('walked the wall');
	});

	it('stores nothing for an entity whose reply is cut off at the cap', async () => {
		const bram = await makeCharacter({ name: 'Bram' });
		await sceneMentioning(bram, 'Bram at the harbour');
		finish = 'length';
		const result = await enrichUniverse(db, { userId: ownerId, universeId }, deps);
		expect(result).toMatchObject({ entities: 0, staged: 0, failed: 1 });
		expect(await enrichedAt(bram)).toBeNull();
	});

	async function enrichedAt(id: string) {
		const [row] = await db
			.select({ at: characters.assistantEnrichedAt })
			.from(characters)
			.where(eq(characters.id, id));
		return row.at;
	}

	it('stops at the spend cap and leaves the rest for the next pass', async () => {
		await saveAccountLlmConfig(db, ownerId, {
			enabled: true,
			assistantName: '',
			persona: 'balanced',
			endpoint: 'https://api.example.com/v1',
			apiKey: 'sk',
			models: { chat: 'chat-model' },
			toolCallBudget: 8,
			spendCapUsd: 0.5
		});
		await saveModelPricing(db, ownerId, { 'chat-model': { prompt: 0.001, completion: 0 } });
		const priced: GatewayDeps = {
			http: noHttp,
			provider: {
				...stubProvider,
				async respond(req) {
					calls += 1;
					lastPrompt = JSON.stringify(req.messages);
					return {
						content: enrichJson,
						toolCalls: [],
						usage: { promptTokens: 1000, completionTokens: 0 }
					};
				}
			}
		};
		const first = await makeCharacter({ name: 'Alda' });
		const second = await makeCharacter({ name: 'Bram' });
		await sceneMentioning(first, 'Alda at the gate');
		await sceneMentioning(second, 'Bram at the harbour');

		const result = await enrichUniverse(db, { userId: ownerId, universeId }, priced);
		expect(result).toMatchObject({ entities: 1, capped: true });
		expect(calls).toBe(1);
		expect(await enrichedAt(first)).not.toBeNull();
		expect(await enrichedAt(second)).toBeNull();
	});

	it('leaves out mentions in a trashed scene or story', async () => {
		const inTrashedScene = await makeCharacter({ name: 'Alda' });
		const inTrashedStory = await makeCharacter({ name: 'Bram' });
		const sceneId = await sceneMentioning(inTrashedScene, 'Alda at the gate');
		await db.update(scenes).set({ deletedAt: new Date() }).where(eq(scenes.id, sceneId));
		const [gone] = await db
			.insert(stories)
			.values({ universeId, ownerId, title: 'Gone', deletedAt: new Date() })
			.returning({ id: stories.id });
		const [scene] = await db
			.insert(scenes)
			.values({ storyId: gone.id, globalPosition: 1 })
			.returning({ id: scenes.id });
		await db.insert(entityMentions).values({
			sourceType: 'scene',
			sourceId: scene.id,
			targetType: 'character',
			targetId: inTrashedStory,
			position: 0,
			surroundingText: 'Bram'
		});

		const result = await enrichUniverse(db, { userId: ownerId, universeId }, deps);
		expect(result.entities).toBe(0);
		expect(calls).toBe(0);
	});

	it('stops when the job is stopped, storing nothing and saying so', async () => {
		const id = await makeCharacter();
		await sceneMentioning(id, 'Bram at the harbour');
		const controller = new AbortController();
		controller.abort();
		const result = await enrichUniverse(
			db,
			{ userId: ownerId, universeId, signal: controller.signal },
			deps
		);
		expect(result).toMatchObject({ entities: 0, aborted: true });
		expect(await enrichedAt(id)).toBeNull();
	});

	it('leaves out an entity seen only in a story the Assistant is muted on', async () => {
		const id = await makeCharacter();
		await sceneMentioning(id, 'Bram at the harbour');
		await saveStoryLlmOverride(db, storyId, { enabled: false });
		const result = await enrichUniverse(db, { userId: ownerId, universeId }, deps);
		expect(result.entities).toBe(0);
		expect(calls).toBe(0);
	});

	it("leaves another writer's universe alone", async () => {
		const id = await makeCharacter();
		await sceneMentioning(id, 'Bram at the harbour');
		const result = await enrichUniverse(db, { userId: strangerId, universeId }, deps);
		expect(result).toMatchObject({ entities: 0, staged: 0 });
		expect(calls).toBe(0);
	});

	// Not retried by the gateway, so one call is one failed read.
	const unauthorized = 'Endpoint returned 401: unauthorized';

	it('stops after three failed reads in a row', async () => {
		for (const name of ['Alda', 'Bram', 'Cass', 'Dov', 'Esk']) {
			await sceneMentioning(await makeCharacter({ name }), `${name} at the harbour`);
		}
		const failing: GatewayDeps = {
			http: noHttp,
			provider: {
				...stubProvider,
				async respond() {
					calls += 1;
					throw new Error(unauthorized);
				}
			}
		};
		const result = await enrichUniverse(db, { userId: ownerId, universeId }, failing);
		expect(result).toMatchObject({ entities: 0, failed: 3, stoppedFailing: true });
		expect(calls).toBe(3);
	});

	it('starts the count again after a read that works, or one cut off at the cap', async () => {
		const names = ['Alda', 'Bram', 'Cass', 'Dov', 'Esk', 'Fen', 'Gil', 'Hal', 'Ivo'];
		for (const name of names) {
			await sceneMentioning(await makeCharacter({ name }), `${name} at the harbour`);
		}
		// Without the reset after Cass's cut-off, Dov would be the third failure
		// in a row; without the one after Fen's read, Gil would be.
		const outcomes = ['fail', 'fail', 'cut', 'fail', 'fail', 'ok', 'fail', 'fail', 'ok'];
		const mixed: GatewayDeps = {
			http: noHttp,
			provider: {
				...stubProvider,
				async respond() {
					const outcome = outcomes[calls];
					calls += 1;
					if (outcome === 'fail') throw new Error(unauthorized);
					return {
						content: enrichJson,
						toolCalls: [],
						finishReason: outcome === 'cut' ? 'length' : undefined
					};
				}
			}
		};
		const result = await enrichUniverse(db, { userId: ownerId, universeId }, mixed);
		expect(result).toMatchObject({ entities: 2, failed: 7, cutOffs: 1 });
		expect(result.stoppedFailing).toBeUndefined();
		expect(calls).toBe(9);
	});

	it('does not stop for failing when the third failure was the last entry', async () => {
		for (const name of ['Alda', 'Bram', 'Cass']) {
			await sceneMentioning(await makeCharacter({ name }), `${name} at the harbour`);
		}
		const failing: GatewayDeps = {
			http: noHttp,
			provider: {
				...stubProvider,
				async respond() {
					throw new Error(unauthorized);
				}
			}
		};
		const result = await enrichUniverse(db, { userId: ownerId, universeId }, failing);
		expect(result).toMatchObject({ entities: 0, failed: 3 });
		expect(result.stoppedFailing).toBeUndefined();
	});

	it('stops when the Assistant is turned off mid-pass, leaving the rest unread', async () => {
		const alda = await makeCharacter({ name: 'Alda' });
		const bram = await makeCharacter({ name: 'Bram' });
		await sceneMentioning(alda, 'Alda at the gate');
		await sceneMentioning(bram, 'Bram at the harbour');
		duringCall = async () => {
			await saveAccountLlmConfig(db, ownerId, {
				enabled: false,
				assistantName: '',
				persona: 'balanced',
				endpoint: 'https://api.example.com/v1',
				apiKey: 'sk',
				models: { chat: 'chat-model' },
				toolCallBudget: 8
			});
		};
		try {
			const result = await enrichUniverse(db, { userId: ownerId, universeId }, deps);
			expect(result).toMatchObject({ entities: 1, failed: 0, disabled: true });
		} finally {
			duringCall = null;
		}
		expect(calls).toBe(1);
		expect(await enrichedAt(alda)).not.toBeNull();
		expect(await enrichedAt(bram)).toBeNull();
	});

	it('does not ask the model when the passages it would send are unchanged', async () => {
		// A summary already, so whether to ask for one does not change between passes.
		await makeCharacter({ name: 'Bram', summaryMd: 'A sailor.' });
		const ids: string[] = [];
		for (let i = 1; i <= 17; i++) ids.push(await sceneWithProse(`Bram in scene ${i}.`, i));
		expect((await enrichUniverse(db, { userId: ownerId, universeId }, deps)).entities).toBe(1);
		expect(calls).toBe(1);
		expect(lastPrompt).not.toContain('scene 17.');

		// Only the first sixteen passages are sent, so an edit to the seventeenth
		// does not change what the model would read.
		await rewrite(ids[16], 'Bram in the last scene.');
		const skipped = await enrichUniverse(db, { userId: ownerId, universeId }, deps);
		expect(skipped).toMatchObject({ entities: 0, unchanged: 1 });
		expect(calls).toBe(1);

		await rewrite(ids[0], 'Bram in the first scene.');
		expect((await enrichUniverse(db, { userId: ownerId, universeId }, deps)).entities).toBe(1);
		expect(calls).toBe(2);
	});

	it('does not ask the model again after a read that staged a summary', async () => {
		await makeCharacter({ name: 'Bram' });
		await sceneWithProse('Bram at the harbour.');
		const first = await enrichUniverse(db, { userId: ownerId, universeId }, deps);
		expect(first.staged).toBeGreaterThan(0);
		expect(lastPrompt).toContain('a one or two sentence summary');
		// The staged summary only changes whether the request asks for one.
		const second = await enrichUniverse(db, { userId: ownerId, universeId }, deps);
		expect(second).toMatchObject({ entities: 0, unchanged: 1 });
		expect(calls).toBe(1);
	});

	describe('a read stored by an earlier release', () => {
		async function stored(id: string) {
			const [row] = await db
				.select({ at: characters.assistantEnrichedAt, input: characters.assistantEnrichedInput })
				.from(characters)
				.where(eq(characters.id, id));
			return row;
		}
		const pass = () => enrichUniverse(db, { userId: ownerId, universeId }, deps);

		it('is given its fingerprint without asking the model when nothing changed since', async () => {
			const bram = await makeCharacter({ name: 'Bram' });
			const sceneId = await sceneWithProse('Bram at the harbour.');
			await pool.query(`update characters set assistant_enriched_at = now() where id = $1`, [bram]);
			const before = await stored(bram);
			expect(await pass()).toMatchObject({ entities: 0, unchanged: 1 });
			expect(calls).toBe(0);
			const after = await stored(bram);
			expect(after.input).not.toBeNull();
			expect(after.at).toEqual(before.at);

			await rewrite(sceneId, 'Bram on the quay.');
			expect((await pass()).entities).toBe(1);
			expect(calls).toBe(1);
		});

		it('is read again when a scene that mentions the entity changed after it', async () => {
			const bram = await makeCharacter({ name: 'Bram' });
			await sceneWithProse('Bram at the harbour.');
			await pool.query(
				`update characters set assistant_enriched_at = now() - interval '1 day' where id = $1`,
				[bram]
			);
			expect((await pass()).entities).toBe(1);
			expect(calls).toBe(1);
		});

		it('is read again when that release marked it', async () => {
			const bram = await makeCharacter({ name: 'Bram' });
			await sceneWithProse('Bram at the harbour.');
			await pool.query(
				`update scenes set updated_at = now() - interval '60 years' where story_id = $1`,
				[storyId]
			);
			await pool.query(
				`update characters set assistant_enriched_at = now() - interval '50 years' where id = $1`,
				[bram]
			);
			expect((await pass()).entities).toBe(1);
			expect(calls).toBe(1);
		});

		it('is left alone when it has a fingerprint that still matches, whatever its time says', async () => {
			const bram = await makeCharacter({ name: 'Bram' });
			await sceneWithProse('Bram at the harbour.');
			expect((await pass()).entities).toBe(1);
			await pool.query(
				`update characters set assistant_enriched_at = now() - interval '50 years' where id = $1`,
				[bram]
			);
			expect(await pass()).toMatchObject({ entities: 0, unchanged: 1 });
			expect(calls).toBe(1);
		});
	});

	it('passes over an entity deleted while the pass runs', async () => {
		await makeCharacter({ name: 'Bram' });
		const cass = await makeCharacter({ name: 'Cass' });
		await sceneWithProse('Bram and Cass at the harbour.');
		duringCall = async () => {
			duringCall = null;
			await pool.query(`delete from entity_mentions where target_id = $1`, [cass]);
			await pool.query(`delete from characters where id = $1`, [cass]);
		};
		try {
			const result = await enrichUniverse(db, { userId: ownerId, universeId }, deps);
			expect(result).toMatchObject({ entities: 1, failed: 0 });
			expect(calls).toBe(1);
		} finally {
			duringCall = null;
		}
	});

	it('stops with its own reason when no model is chosen', async () => {
		await saveAccountLlmConfig(db, ownerId, {
			enabled: true,
			assistantName: '',
			persona: 'balanced',
			endpoint: 'https://api.example.com/v1',
			apiKey: 'sk',
			models: {},
			toolCallBudget: 8
		});
		const bram = await makeCharacter({ name: 'Bram' });
		await sceneMentioning(bram, 'Bram at the harbour');
		const result = await enrichUniverse(db, { userId: ownerId, universeId }, deps);
		expect(result).toMatchObject({ entities: 0, failed: 0, noModel: true });
		expect(result.disabled).toBeUndefined();
		expect(await enrichedAt(bram)).toBeNull();
	});

	it('stores nothing for an entity whose read failed, so the next pass tries again', async () => {
		const id = await makeCharacter();
		await sceneMentioning(id, 'Bram at the harbour');
		const failing: GatewayDeps = {
			http: noHttp,
			provider: {
				...stubProvider,
				async respond() {
					throw new Error('endpoint down');
				}
			}
		};
		const result = await enrichUniverse(db, { userId: ownerId, universeId }, failing);
		expect(result).toMatchObject({ entities: 0, failed: 1 });
		const [row] = await db
			.select({ at: characters.assistantEnrichedAt })
			.from(characters)
			.where(eq(characters.id, id));
		expect(row.at).toBeNull();
	});
});
