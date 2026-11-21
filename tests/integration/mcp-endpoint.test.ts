import { createHash } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import type pg from 'pg';
import {
	characters,
	entityMentions,
	oauthClients,
	oauthGrants,
	reviewSuggestions,
	scenes,
	stories,
	universes,
	users
} from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase } from './test-db';

// The MCP endpoint against a real database, through the route an outside app
// calls. The rule under test throughout: a credential reaches the data of the
// writer it resolves to and nothing else, and what it cannot reach looks the
// same as what does not exist.

process.env.APP_SECRET = process.env.APP_SECRET || 'mcp-endpoint-test-secret';

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
const { resetRateLimits } = await import('#lib/server/rate-limit');
const { saveStoryLlmOverride } = await import('#lib/server/llm/config');
const { dispatchToolCall } = await import('#lib/server/llm/tools/dispatch');
const { TOOLS, toolSpecs } = await import('#lib/server/llm/tools/registry');
const { registerClient } = await import('#lib/server/mcp/clients');
const { createAuthorizationCode, exchangeCode, revokeAllGrants } =
	await import('#lib/server/mcp/oauth');
const { saveMcpInstanceEnabled } = await import('#lib/server/mcp/settings');
const { NO_UNIVERSE_RESULT } = await import('#lib/server/mcp/tools');
const {
	addComment,
	createSuggestion,
	createThread,
	decideSuggestion,
	listSuggestions,
	listThreads
} = await import('#lib/server/review');
const { createAnchorMapper } = await import('#lib/review-anchor');
const { TOOL_RESULT_MAX_CHARS } = await import('#lib/server/mcp/constants');
const route = await import('../../src/routes/api/mcp/+server');

const ORIGIN = 'http://localhost';
const MISSING = '00000000-0000-4000-8000-000000000000';
const NO_SCENE = 'No scene with that id in this story.';
const NO_ENTITY = 'No entity with that id.';
const NO_THREAD = 'No thread with that id.';
const NO_SUGGESTION = 'No suggestion with that id.';
const APP = 'Writing Desk (app.example)';
const VERIFIER = 'v'.repeat(64);
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

// One writer's corner of the database: a universe with an open story, a muted
// one and a trashed one, a character mentioned in each, and a second universe
// of their own with a character in it.
type World = {
	userId: string;
	token: string;
	universeId: string;
	otherUniverseId: string;
	trashedUniverseId: string;
	storyId: string;
	sceneId: string;
	mutedSceneId: string;
	trashedStorySceneId: string;
	trashedSceneId: string;
	characterId: string;
	otherCharacterId: string;
};

let alice: World;
let bob: World;

async function connect(
	userId: string,
	name = 'Writing Desk',
	permissions: ('read' | 'suggest')[] = ['read', 'suggest']
): Promise<string> {
	const registered = await registerClient(db, {
		client_name: name,
		redirect_uris: ['https://app.example/callback']
	});
	if (!registered.ok) throw new Error(registered.description);
	const code = await createAuthorizationCode(db, {
		userId,
		client: registered.client,
		permissions,
		redirectUri: 'https://app.example/callback',
		codeChallenge: CHALLENGE
	});
	const result = await exchangeCode(db, {
		code,
		clientId: registered.client.clientId,
		redirectUri: 'https://app.example/callback',
		codeVerifier: VERIFIER
	});
	if (!result.ok) throw new Error('the exchange was refused');
	return result.tokens.accessToken;
}

async function buildWorld(name: string): Promise<World> {
	const [user] = await db
		.insert(users)
		.values({
			email: `${name.toLowerCase()}@example.com`,
			displayName: name,
			passwordHash: 'x',
			role: 'user',
			emailVerifiedAt: new Date(),
			approvedAt: new Date(),
			mcpEnabled: true
		})
		.returning({ id: users.id });
	const userId = user.id;
	const universe = async (title: string, deletedAt: Date | null = null) =>
		(
			await db
				.insert(universes)
				.values({ ownerId: userId, name: title, deletedAt })
				.returning({ id: universes.id })
		)[0].id;
	const universeId = await universe(`${name} Main`);
	const otherUniverseId = await universe(`${name} Other`);
	const trashedUniverseId = await universe(`${name} Trashed`, new Date());

	const story = async (title: string, deletedAt: Date | null = null) =>
		(
			await db
				.insert(stories)
				.values({ universeId, ownerId: userId, title, deletedAt })
				.returning({ id: stories.id })
		)[0].id;
	const storyId = await story(`${name} Open Book`);
	const mutedStoryId = await story(`${name} Muted Book`);
	await saveStoryLlmOverride(db, mutedStoryId, { enabled: false });
	const trashedStoryId = await story(`${name} Trashed Book`, new Date());

	const [character] = await db
		.insert(characters)
		.values({ universeId, ownerId: userId, name: `${name}s hero Bram` })
		.returning({ id: characters.id });
	const [otherCharacter] = await db
		.insert(characters)
		.values({ universeId: otherUniverseId, ownerId: userId, name: `${name}s outsider` })
		.returning({ id: characters.id });

	const scene = async (
		ofStory: string,
		title: string,
		bodyMd: string,
		deletedAt: Date | null = null
	) => {
		const [row] = await db
			.insert(scenes)
			.values({ storyId: ofStory, globalPosition: 1, title, bodyMd, deletedAt })
			.returning({ id: scenes.id });
		// Trashing a scene removes its mention rows, so a trashed one has none.
		if (!deletedAt) {
			await db.insert(entityMentions).values({
				sourceType: 'scene',
				sourceId: row.id,
				targetType: 'character',
				targetId: character.id,
				position: 0,
				surroundingText: bodyMd
			});
		}
		return row.id;
	};
	// Every body shares the word "lantern", so a search that leaked would show it.
	const sceneId = await scene(storyId, `${name} Quay`, `${name} open lantern prose.`);
	const mutedSceneId = await scene(mutedStoryId, `${name} Secret`, `${name} muted lantern prose.`);
	const trashedStorySceneId = await scene(
		trashedStoryId,
		`${name} Gone`,
		`${name} trashed lantern prose.`
	);
	const trashedSceneId = await scene(
		storyId,
		`${name} Cut`,
		`${name} deleted lantern prose.`,
		new Date()
	);

	return {
		userId,
		token: await connect(userId),
		universeId,
		otherUniverseId,
		trashedUniverseId,
		storyId,
		sceneId,
		mutedSceneId,
		trashedStorySceneId,
		trashedSceneId,
		characterId: character.id,
		otherCharacterId: otherCharacter.id
	};
}

// ============ Talking to the endpoint ============

type Init = { token?: string; headers?: Record<string, string>; method?: string };

function send(body: unknown, init: Init = {}): Promise<Response> {
	const url = new URL(`${ORIGIN}/api/mcp`);
	const method = init.method ?? 'POST';
	const request = new Request(url, {
		method,
		body: method === 'POST' ? JSON.stringify(body) : undefined,
		headers: {
			'content-type': 'application/json',
			accept: 'application/json, text/event-stream',
			...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
			...init.headers
		}
	});
	const handler = route[method as 'POST' | 'GET' | 'DELETE'];
	return handler({ request, url } as never) as Promise<Response>;
}

// The JSON-RPC answer, whether it came as plain JSON or as one event.
async function answer(response: Response) {
	const text = await response.text();
	const json = response.headers.get('content-type')?.includes('text/event-stream')
		? text
				.split('\n')
				.filter((line) => line.startsWith('data:'))
				.map((line) => line.slice(5))
				.join('')
		: text;
	return JSON.parse(json) as {
		result?: Record<string, unknown>;
		error?: { code: number; message: string };
	};
}

async function rpc(token: string, method: string, params: unknown = {}) {
	const response = await send({ jsonrpc: '2.0', id: 1, method, params }, { token });
	expect(response.status).toBe(200);
	return answer(response);
}

type ToolAnswer = { text: string; isError: boolean };

async function call(
	who: World | string,
	name: string,
	args: Record<string, unknown> = {}
): Promise<ToolAnswer> {
	const token = typeof who === 'string' ? who : who.token;
	const { result, error } = await rpc(token, 'tools/call', { name, arguments: args });
	// A call the protocol layer refuses (unknown tool, bad arguments) is an
	// error too; fold both shapes into one for the assertions.
	if (!result) return { text: error?.message ?? '', isError: true };
	const content = result.content as { type: string; text: string }[];
	return { text: content.map((part) => part.text).join(''), isError: result.isError === true };
}

async function stagedRows(): Promise<number> {
	const { rows } = await pool.query(
		`select (select count(*) from review_threads) + (select count(*) from review_suggestions)
		      + (select count(*) from review_comments) + (select count(*) from entity_suggestions)
		      + (select count(*) from assistant_drafts) as n`
	);
	return Number(rows[0].n);
}

beforeAll(async () => {
	await ensureTestDatabase();
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await pool.query('truncate table users, oauth_clients cascade');
	await pool.query(`delete from app_settings where key = 'mcp'`);
	resetRateLimits();
	alice = await buildWorld('Alice');
	bob = await buildWorld('Bob');
});

afterAll(async () => {
	await pool.end();
});

describe('who may call the endpoint', () => {
	const list = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };

	it('answers 401 with the way to sign in when there is no token', async () => {
		const response = await send(list);
		expect(response.status).toBe(401);
		const challenge = response.headers.get('www-authenticate')!;
		expect(challenge).toContain(
			`Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/api/mcp"`
		);
		expect(challenge).toContain('scope="read suggest"');
		expect(challenge).not.toContain('error=');
	});

	it('answers 401 for a token that is unknown, malformed or not an access token', async () => {
		for (const headers of [
			{ authorization: 'Bearer cdx_at_nope' },
			{ authorization: 'Basic abc' },
			{ authorization: `Bearer ${alice.token} extra` }
		]) {
			expect((await send(list, { headers })).status).toBe(401);
		}
		const unknown = await send(list, { token: 'cdx_at_nope' });
		expect(unknown.headers.get('www-authenticate')).toContain('error="invalid_token"');
	});

	it('takes no notice of a session cookie', async () => {
		const response = await send(list, { headers: { cookie: 'session=anything' } });
		expect(response.status).toBe(401);
	});

	it('stops answering a token once its connection, account or switch is gone', async () => {
		expect((await send(list, { token: alice.token })).status).toBe(200);

		await db.update(users).set({ suspendedAt: new Date() }).where(eq(users.id, alice.userId));
		expect((await send(list, { token: alice.token })).status).toBe(401);
		await db.update(users).set({ suspendedAt: null }).where(eq(users.id, alice.userId));

		await db.update(users).set({ mcpEnabled: false }).where(eq(users.id, alice.userId));
		expect((await send(list, { token: alice.token })).status).toBe(401);
		await db.update(users).set({ mcpEnabled: true }).where(eq(users.id, alice.userId));
		expect((await send(list, { token: alice.token })).status).toBe(200);

		await revokeAllGrants(db, alice.userId);
		expect((await send(list, { token: alice.token })).status).toBe(401);
		// Bob's connection is his own.
		expect((await send(list, { token: bob.token })).status).toBe(200);
	});

	it('does not exist while the instance switch is off, token or not', async () => {
		await saveMcpInstanceEnabled(db, false);
		expect((await send(list)).status).toBe(404);
		expect((await send(list, { token: alice.token })).status).toBe(404);
	});

	it('refuses a browser page on another site and allows this site and no origin', async () => {
		const from = (origin: string) => send(list, { token: alice.token, headers: { origin } });
		expect((await from('https://elsewhere.example')).status).toBe(403);
		expect((await from('null')).status).toBe(403);
		expect((await from(ORIGIN)).status).toBe(200);
	});

	it('checks the token before saying anything about the method', async () => {
		expect((await send(null, { method: 'GET' })).status).toBe(401);
		expect((await send(null, { method: 'DELETE' })).status).toBe(401);
		expect((await send(null, { method: 'GET', token: alice.token })).status).toBe(405);
	});
});

describe('the protocol', () => {
	it('answers the opening handshake', async () => {
		const { result } = await rpc(alice.token, 'initialize', {
			protocolVersion: '2025-06-18',
			capabilities: {},
			clientInfo: { name: 'test', version: '1' }
		});
		expect(result).toMatchObject({ serverInfo: { name: 'codex' } });
		expect(result?.capabilities).toHaveProperty('tools');
		expect(String(result?.instructions)).toContain('list_universes');
	});

	it('offers only the read tools to a connection that may only read', async () => {
		const readOnly = await connect(alice.userId, 'Reader', ['read']);
		const { result } = await rpc(readOnly, 'tools/list');
		const tools = result!.tools as {
			name: string;
			inputSchema: { required?: string[]; properties: Record<string, unknown> };
			annotations?: { readOnlyHint?: boolean };
		}[];
		expect(tools.map((tool) => tool.name).sort()).toEqual([
			'find_appearances',
			'get_entity',
			'get_scene',
			'list_scenes',
			'list_stories',
			'list_universes',
			'search_text'
		]);
		for (const tool of tools) {
			expect(tool.annotations?.readOnlyHint).toBe(true);
			if (tool.name === 'list_universes') {
				expect(tool.inputSchema.properties).not.toHaveProperty('universeId');
			} else {
				expect(tool.inputSchema.required).toContain('universeId');
			}
		}
		expect(tools.find((tool) => tool.name === 'get_scene')!.inputSchema.required).toEqual([
			'universeId',
			'sceneId'
		]);
	});

	it('adds the staging tools for a connection that may suggest', async () => {
		const { result } = await rpc(alice.token, 'tools/list');
		const tools = result!.tools as {
			name: string;
			inputSchema: { required?: string[] };
			annotations?: { readOnlyHint?: boolean };
		}[];
		const staging = tools.filter((tool) => tool.annotations?.readOnlyHint === false);
		expect(staging.map((tool) => tool.name).sort()).toEqual([
			'leave_comment',
			'leave_pattern_note',
			'reply_in_thread',
			'suggest_edit',
			'update_suggestion'
		]);
		expect(tools).toHaveLength(12);
		const required = (name: string) =>
			tools.find((tool) => tool.name === name)!.inputSchema.required;
		expect(required('reply_in_thread')).toEqual(['universeId', 'threadId', 'comment']);
		expect(required('update_suggestion')).toEqual(['universeId', 'suggestionId', 'replacement']);
	});

	it('refuses a tool it does not offer, and stages nothing', async () => {
		const readOnly = await connect(alice.userId, 'Reader', ['read']);
		const attempts: [string, string][] = [
			[readOnly, 'suggest_edit'],
			[readOnly, 'leave_comment'],
			[readOnly, 'leave_pattern_note'],
			[alice.token, 'propose_scene_split'],
			[alice.token, 'no_such_tool']
		];
		for (const [token, name] of attempts) {
			const result = await call(token, name, {
				universeId: alice.universeId,
				sceneId: alice.sceneId,
				original: 'open',
				replacement: 'shut',
				comment: 'x',
				edits: [{ original: 'open', replacement: 'shut' }],
				newSceneStart: 'lantern',
				rationale: 'x'
			});
			expect(result.isError).toBe(true);
		}
		expect(await stagedRows()).toBe(0);
	});

	it('keeps the external tools out of the in-app toolbox', async () => {
		const external = TOOLS.filter((tool) => tool.external).map((tool) => tool.name);
		expect(external).toEqual(['list_universes', 'list_stories']);
		const inApp = toolSpecs().map((tool) => tool.name);
		expect(inApp).not.toContain('list_universes');
		expect(toolSpecs(external)).toEqual([]);
		const outcome = await dispatchToolCall(
			{ db, userId: alice.userId, universeId: alice.universeId },
			{ id: 'call', name: 'list_universes', arguments: '{}' }
		);
		expect(outcome.result).toBe('Unknown tool: list_universes.');
	});
});

// ============ One block per tool ============

// The universe argument: another writer's, a trashed one, a missing one and
// one that is not an id at all get one and the same answer.
async function expectNoUniverse(name: string, args: Record<string, unknown> = {}) {
	for (const universeId of [bob.universeId, alice.trashedUniverseId, MISSING, 'nope']) {
		expect(await call(alice, name, { ...args, universeId })).toEqual({
			text: NO_UNIVERSE_RESULT,
			isError: true
		});
	}
	// Without the argument, or with something that is not text, the call is
	// refused before it reaches the tool.
	for (const bad of [{}, { universeId: 42 }, { universeId: null }]) {
		expect(await call(alice, name, { ...args, ...bad })).toMatchObject({ isError: true });
	}
}

describe('list_universes', () => {
	it("lists the writer's own live universes and no one else's", async () => {
		const { text, isError } = await call(alice, 'list_universes');
		expect(isError).toBe(false);
		const listed = JSON.parse(text).universes as { id: string; name: string; storyCount: number }[];
		expect(listed.map((row) => row.id).sort()).toEqual(
			[alice.universeId, alice.otherUniverseId].sort()
		);
		expect(text).not.toContain('Bob');
		expect(text).not.toContain('Trashed');
		// The muted and the trashed story are not counted.
		expect(listed.find((row) => row.id === alice.universeId)!.storyCount).toBe(1);
	});

	it('cannot be pointed at another writer by an argument', async () => {
		const result = await call(alice, 'list_universes', { userId: bob.userId });
		expect(result.text).not.toContain('Bob');
	});
});

describe('list_stories', () => {
	it('gives one not-found for any universe that is not the writers own live one', async () => {
		await expectNoUniverse('list_stories');
	});

	it('lists the open stories of the universe, not a muted or trashed one', async () => {
		const { text } = await call(alice, 'list_stories', { universeId: alice.universeId });
		const listed = JSON.parse(text).stories as { id: string; title: string; sceneCount: number }[];
		expect(listed).toMatchObject([{ id: alice.storyId, title: 'Alice Open Book', sceneCount: 1 }]);
	});
});

describe('list_scenes', () => {
	it('gives one not-found for any universe that is not the writers own live one', async () => {
		await expectNoUniverse('list_scenes');
	});

	it('lists the scenes of the open stories only', async () => {
		const { text } = await call(alice, 'list_scenes', { universeId: alice.universeId });
		expect(text).toContain(alice.sceneId);
		for (const hidden of [
			alice.mutedSceneId,
			alice.trashedStorySceneId,
			alice.trashedSceneId,
			bob.sceneId
		]) {
			expect(text).not.toContain(hidden);
		}
		expect(text).not.toContain('Bob');
	});
});

describe('get_scene', () => {
	it('gives one not-found for any universe that is not the writers own live one', async () => {
		await expectNoUniverse('get_scene', { sceneId: alice.sceneId });
		// Naming Bob's universe with Bob's scene is no better.
		expect(
			await call(alice, 'get_scene', { universeId: bob.universeId, sceneId: bob.sceneId })
		).toEqual({ text: NO_UNIVERSE_RESULT, isError: true });
	});

	it('gives one not-found for a scene that is another writers, muted, trashed or missing', async () => {
		for (const sceneId of [
			bob.sceneId,
			alice.mutedSceneId,
			alice.trashedStorySceneId,
			alice.trashedSceneId,
			MISSING,
			'nope'
		]) {
			expect(await call(alice, 'get_scene', { universeId: alice.universeId, sceneId })).toEqual({
				text: NO_SCENE,
				isError: false
			});
		}
		// A scene of the writer's own, asked for through their other universe.
		expect(
			await call(alice, 'get_scene', { universeId: alice.otherUniverseId, sceneId: alice.sceneId })
		).toEqual({ text: NO_SCENE, isError: false });
	});

	it('reads the writers own scene', async () => {
		const { text } = await call(alice, 'get_scene', {
			universeId: alice.universeId,
			sceneId: alice.sceneId
		});
		expect(JSON.parse(text)).toMatchObject({
			id: alice.sceneId,
			title: 'Alice Quay',
			body: 'Alice open lantern prose.'
		});
	});

	it('keeps a very long scene under what a client accepts, and says it was cut', async () => {
		await db
			.update(scenes)
			.set({ bodyMd: 'word '.repeat(60_000) })
			.where(eq(scenes.id, alice.sceneId));
		const { text } = await call(alice, 'get_scene', {
			universeId: alice.universeId,
			sceneId: alice.sceneId
		});
		expect(text.length).toBeLessThan(TOOL_RESULT_MAX_CHARS);
		expect(text).toContain('truncated: showing the first 120000 of 300000 characters');
	});
});

describe('get_entity', () => {
	it('gives one not-found for any universe that is not the writers own live one', async () => {
		await expectNoUniverse('get_entity', { entityId: alice.characterId });
		expect(
			await call(alice, 'get_entity', { universeId: bob.universeId, entityId: bob.characterId })
		).toEqual({ text: NO_UNIVERSE_RESULT, isError: true });
	});

	it('gives one not-found for an entry that is another writers, in another universe or missing', async () => {
		for (const entityId of [bob.characterId, alice.otherCharacterId, MISSING, 'nope']) {
			expect(await call(alice, 'get_entity', { universeId: alice.universeId, entityId })).toEqual({
				text: NO_ENTITY,
				isError: false
			});
		}
	});

	it('reads the writers own entry', async () => {
		const { text } = await call(alice, 'get_entity', {
			universeId: alice.universeId,
			entityId: alice.characterId
		});
		expect(JSON.parse(text)).toMatchObject({ id: alice.characterId, name: 'Alices hero Bram' });
	});
});

describe('find_appearances', () => {
	it('gives one not-found for any universe that is not the writers own live one', async () => {
		await expectNoUniverse('find_appearances', { entityId: alice.characterId });
	});

	it('gives one not-found for an entry that is another writers, in another universe or missing', async () => {
		for (const entityId of [bob.characterId, alice.otherCharacterId, MISSING, 'nope']) {
			expect(
				await call(alice, 'find_appearances', { universeId: alice.universeId, entityId })
			).toEqual({ text: NO_ENTITY, isError: false });
		}
	});

	it('quotes the open story only', async () => {
		const { text } = await call(alice, 'find_appearances', {
			universeId: alice.universeId,
			entityId: alice.characterId
		});
		expect(text).toContain('Alice open lantern prose.');
		for (const hidden of ['muted', 'trashed', 'deleted', 'Bob']) expect(text).not.toContain(hidden);
	});
});

describe('search_text', () => {
	it('gives one not-found for any universe that is not the writers own live one', async () => {
		await expectNoUniverse('search_text', { query: 'lantern' });
	});

	it('searches the open stories of the universe only', async () => {
		const { text } = await call(alice, 'search_text', {
			universeId: alice.universeId,
			query: 'lantern'
		});
		expect(text).toContain('Alice Quay');
		for (const hidden of ['Bob', 'Secret', 'Gone', 'Cut', 'muted', 'trashed', 'deleted']) {
			expect(text).not.toContain(hidden);
		}
		// A word only Bob wrote finds nothing in Alice's universe.
		const bobs = await call(alice, 'search_text', { universeId: alice.universeId, query: 'Bobs' });
		expect(JSON.parse(bobs.text)).toEqual([]);
	});
});

// ============ Staging ============

const idIn = (text: string) => /id ([0-9a-f-]{36})/.exec(text)?.[1] ?? '';
const mapRange = (base: string, current: string, start: number, end: number) =>
	createAnchorMapper().range(base, current, start, end);

function edit(who: World, overrides: Record<string, unknown> = {}) {
	return call(who, 'suggest_edit', {
		universeId: who.universeId,
		sceneId: who.sceneId,
		original: 'open',
		replacement: 'shut',
		...overrides
	});
}

function comment(who: World, overrides: Record<string, unknown> = {}) {
	return call(who, 'leave_comment', {
		universeId: who.universeId,
		sceneId: who.sceneId,
		comment: 'The lantern needs a keeper.',
		...overrides
	});
}

// A scene of the writer's own that an app must not reach, or no scene at all.
const hiddenScenes = () => [
	bob.sceneId,
	alice.mutedSceneId,
	alice.trashedStorySceneId,
	alice.trashedSceneId,
	MISSING,
	'nope'
];

describe('suggest_edit', () => {
	it('stages a pending suggestion in the apps name and leaves the text alone', async () => {
		const result = await edit(alice);
		expect(result).toMatchObject({ isError: false });
		expect(result.text).toContain('Staged a suggested edit');
		const [staged] = await listSuggestions(db, alice.storyId);
		expect(staged).toMatchObject({
			id: idIn(result.text),
			reviewerName: APP,
			isApp: true,
			isAssistant: false,
			isOwner: false,
			original: 'open',
			replacement: 'shut',
			status: 'pending'
		});
		const [scene] = await db.select().from(scenes).where(eq(scenes.id, alice.sceneId));
		expect(scene.bodyMd).toBe('Alice open lantern prose.');
	});

	it('stages nothing outside the writers own open stories', async () => {
		await expectNoUniverse('suggest_edit', {
			sceneId: alice.sceneId,
			original: 'open',
			replacement: 'shut'
		});
		expect(await edit(alice, { universeId: bob.universeId, sceneId: bob.sceneId })).toEqual({
			text: NO_UNIVERSE_RESULT,
			isError: true
		});
		for (const sceneId of hiddenScenes()) {
			expect(await edit(alice, { sceneId })).toEqual({ text: NO_SCENE, isError: false });
		}
		expect(await stagedRows()).toBe(0);
	});

	it('drops a repeat of its own edit, and lets another app make the same one', async () => {
		expect((await edit(alice)).text).toContain('Staged');
		expect((await edit(alice)).text).toContain('already staged this exact edit');
		const second = await connect(alice.userId, 'Second');
		expect((await edit({ ...alice, token: second })).text).toContain('Staged');
		expect(await listSuggestions(db, alice.storyId)).toHaveLength(2);
	});
});

describe('leave_comment', () => {
	it('stages a comment in the apps name, anchored to the quote', async () => {
		const result = await comment(alice, { quote: 'lantern' });
		expect(result.text).toContain('Staged a review comment');
		const [thread] = await listThreads(db, alice.storyId, mapRange);
		expect(thread).toMatchObject({ id: idIn(result.text), anchor: { start: 11, end: 18 } });
		expect(thread.comments[0]).toMatchObject({
			authorName: APP,
			isApp: true,
			isAssistant: false,
			isOwner: false,
			mine: false,
			body: 'The lantern needs a keeper.'
		});
	});

	it('stages nothing outside the writers own open stories', async () => {
		await expectNoUniverse('leave_comment', { sceneId: alice.sceneId, comment: 'x' });
		for (const sceneId of hiddenScenes()) {
			expect(await comment(alice, { sceneId })).toEqual({ text: NO_SCENE, isError: false });
		}
		expect(await stagedRows()).toBe(0);
	});

	it('drops a repeat of its own comment', async () => {
		await comment(alice);
		expect((await comment(alice)).text).toContain('already left this comment');
		expect(await listThreads(db, alice.storyId, mapRange)).toHaveLength(1);
	});
});

describe('leave_pattern_note', () => {
	const note = (who: World, overrides: Record<string, unknown> = {}) =>
		call(who, 'leave_pattern_note', {
			universeId: who.universeId,
			sceneId: who.sceneId,
			comment: 'Pattern note (lanterns): the word carries every sentence.',
			edits: [
				{ original: 'open', replacement: 'shut' },
				{ original: 'not in the scene', replacement: 'x' }
			],
			...overrides
		});

	it('stages the note with its edits, linked, in the apps name', async () => {
		const result = await note(alice);
		expect(result.text).toContain('Staged the pattern note with 1 linked edit');
		expect(result.text).toContain('not found in the scene');
		const [thread] = await listThreads(db, alice.storyId, mapRange);
		const [suggestion] = await listSuggestions(db, alice.storyId);
		expect(thread.comments[0]).toMatchObject({ authorName: APP, isApp: true });
		expect(suggestion).toMatchObject({ reviewerName: APP, patternThreadId: thread.id });

		// A retry with the same comment adds to the apps own note, not a new one.
		const retry = await note(alice, { edits: [{ original: 'lantern', replacement: 'lamp' }] });
		expect(retry.text).toContain('1 linked edit');
		expect(await listThreads(db, alice.storyId, mapRange)).toHaveLength(1);
		expect(await listSuggestions(db, alice.storyId)).toHaveLength(2);
	});

	it('does not extend a note the Assistant or another app left', async () => {
		await createThread(db, {
			storyId: alice.storyId,
			sceneId: alice.sceneId,
			anchor: null,
			author: { assistant: true },
			body: 'Pattern note (lanterns): the word carries every sentence.'
		});
		await note(alice);
		const threads = await listThreads(db, alice.storyId, mapRange);
		expect(threads.map((thread) => thread.comments[0].isApp)).toEqual([false, true]);
	});

	it('stages nothing outside the writers own open stories', async () => {
		await expectNoUniverse('leave_pattern_note', {
			sceneId: alice.sceneId,
			comment: 'Pattern note (x): y',
			edits: [{ original: 'open', replacement: 'shut' }]
		});
		for (const sceneId of hiddenScenes()) {
			expect(await note(alice, { sceneId })).toEqual({ text: NO_SCENE, isError: false });
		}
		expect(await stagedRows()).toBe(0);
	});
});

describe('reply_in_thread', () => {
	const reply = (who: World, threadId: unknown, universeId = who.universeId) =>
		call(who, 'reply_in_thread', { universeId, threadId, comment: 'A reply from the app.' });

	async function ownersThread(who: World, sceneId = who.sceneId, storyId = who.storyId) {
		const created = await createThread(db, {
			storyId,
			sceneId,
			anchor: null,
			author: { userId: who.userId },
			body: 'What do you make of this?'
		});
		if (!created.ok) throw new Error(created.reason);
		return created.threadId;
	}

	it('replies in a thread of the writers story, in the apps name', async () => {
		const threadId = await ownersThread(alice);
		expect((await reply(alice, threadId)).text).toBe('Your reply was posted to the thread.');
		const [thread] = await listThreads(db, alice.storyId, mapRange);
		expect(thread.comments.map((entry) => [entry.authorName, entry.isApp])).toEqual([
			['Alice', false],
			[APP, true]
		]);
	});

	it('does not answer itself: one reply, then it waits for someone else', async () => {
		const threadId = await ownersThread(alice);
		await reply(alice, threadId);
		expect((await reply(alice, threadId)).text).toContain('Wait for the writer to answer');
		await addComment(db, {
			storyId: alice.storyId,
			threadId,
			author: { userId: alice.userId },
			body: 'Go on.'
		});
		expect((await reply(alice, threadId)).text).toBe('Your reply was posted to the thread.');
		// Its own note is the latest word in that thread too.
		const own = idIn((await comment(alice)).text);
		expect((await reply(alice, own)).text).toContain('Wait for the writer to answer');
	});

	it('finds no thread that is another writers, in a muted story or missing', async () => {
		await expectNoUniverse('reply_in_thread', { threadId: MISSING, comment: 'x' });
		const bobs = await ownersThread(bob);
		const [mutedScene] = await db.select().from(scenes).where(eq(scenes.id, alice.mutedSceneId));
		const muted = await ownersThread(alice, mutedScene.id, mutedScene.storyId);
		const own = await ownersThread(alice);
		const before = await pool.query('select count(*) from review_comments');
		for (const threadId of [bobs, muted, MISSING, 'nope']) {
			expect(await reply(alice, threadId)).toEqual({ text: NO_THREAD, isError: false });
		}
		// Bob's thread through Bob's universe is no universe at all.
		expect(await reply(alice, bobs, bob.universeId)).toEqual({
			text: NO_UNIVERSE_RESULT,
			isError: true
		});
		// A thread of the writer's own, asked for through their other universe.
		expect(await reply(alice, own, alice.otherUniverseId)).toEqual({
			text: NO_THREAD,
			isError: false
		});
		const after = await pool.query('select count(*) from review_comments');
		expect(after.rows).toEqual(before.rows);
	});
});

describe('update_suggestion', () => {
	const revise = (who: World | string, suggestionId: unknown, universeId = alice.universeId) =>
		call(who, 'update_suggestion', { universeId, suggestionId, replacement: 'closed' });
	const replacementOf = async (id: string) =>
		(await db.select().from(reviewSuggestions).where(eq(reviewSuggestions.id, id)))[0].replacement;

	it('revises its own pending suggestion and no other', async () => {
		const own = idIn((await edit(alice)).text);
		expect((await revise(alice, own)).text).toContain('now proposes the revised text');
		expect(await replacementOf(own)).toBe('closed');

		// The Assistant's, another app's and the writer's own are not its to change.
		const assistants = await createSuggestion(db, {
			storyId: alice.storyId,
			sceneId: alice.sceneId,
			author: { assistant: true },
			range: { start: 11, end: 18 },
			replacement: 'lamp'
		});
		const owners = await createSuggestion(db, {
			storyId: alice.storyId,
			sceneId: alice.sceneId,
			author: { userId: alice.userId },
			range: { start: 0, end: 5 },
			replacement: 'She'
		});
		const second = await connect(alice.userId, 'Second');
		const others = idIn(
			(await edit({ ...alice, token: second }, { original: 'prose', replacement: 'verse' })).text
		);
		for (const id of [
			assistants.ok && assistants.suggestionId,
			owners.ok && owners.suggestionId,
			others
		]) {
			expect((await revise(alice, id)).text).toContain('You can only revise a suggestion you made');
			expect(await replacementOf(id as string)).not.toBe('closed');
		}
	});

	it('leaves a decided suggestion as it was decided', async () => {
		const own = idIn((await edit(alice)).text);
		await decideSuggestion(db, alice.userId, alice.storyId, own, false);
		expect((await revise(alice, own)).text).toContain('only while it is pending');
		expect(await replacementOf(own)).toBe('shut');
	});

	it('finds no suggestion that is another writers or missing', async () => {
		await expectNoUniverse('update_suggestion', { suggestionId: MISSING, replacement: 'x' });
		const bobs = idIn((await edit(bob)).text);
		for (const id of [bobs, MISSING, 'nope']) {
			expect(await revise(alice, id)).toEqual({ text: NO_SUGGESTION, isError: false });
		}
		expect(await revise(alice, bobs, bob.universeId)).toEqual({
			text: NO_UNIVERSE_RESULT,
			isError: true
		});
		expect(await replacementOf(bobs)).toBe('shut');
	});
});

describe('what an app leaves behind', () => {
	it('keeps its name on its notes after the client is removed', async () => {
		const suggestionId = idIn((await edit(alice)).text);
		await comment(alice);
		await pool.query('delete from oauth_clients');
		expect(await db.select().from(oauthClients)).toHaveLength(0);
		const [suggestion] = await listSuggestions(db, alice.storyId);
		expect(suggestion).toMatchObject({ id: suggestionId, reviewerName: APP, isApp: true });
		const [thread] = await listThreads(db, alice.storyId, mapRange);
		expect(thread.comments[0]).toMatchObject({ authorName: APP, isApp: true });
		// The writer still decides on it.
		const decided = await decideSuggestion(db, alice.userId, alice.storyId, suggestionId, true);
		expect(decided.ok).toBe(true);
		const [scene] = await db.select().from(scenes).where(eq(scenes.id, alice.sceneId));
		expect(scene.bodyMd).toBe('Alice shut lantern prose.');
	});

	it('stops at a ceiling of waiting notes per scene, until the writer decides', async () => {
		const [client] = await db.select().from(oauthClients);
		const stage = (original: string) =>
			dispatchToolCall(
				{
					db,
					userId: alice.userId,
					universeId: alice.universeId,
					external: {
						sceneBodyCap: 1000,
						client: { id: client.id, name: client.clientName, host: client.host },
						maxNotesPerScene: 2
					}
				},
				{
					id: 'call',
					name: 'suggest_edit',
					arguments: JSON.stringify({ sceneId: alice.sceneId, original, replacement: 'x' })
				}
			);
		const first = await stage('open');
		expect((await stage('lantern')).staged).toBe(true);
		const third = await stage('prose');
		expect(third.staged).toBe(false);
		expect(third.result).toContain('already has 2 of your notes waiting');
		// Another scene is not affected, and deciding makes room.
		await decideSuggestion(db, alice.userId, alice.storyId, idIn(first.result), false);
		expect((await stage('prose')).staged).toBe(true);
	});
});

describe('across every read tool', () => {
	it('stages nothing and leaves both writers work as it was', async () => {
		const before = await pool.query(`select id, body_md, updated_at from scenes order by id`);
		for (const who of [alice, bob]) {
			const other = who === alice ? bob : alice;
			for (const universeId of [who.universeId, other.universeId]) {
				await call(who, 'list_universes');
				await call(who, 'list_stories', { universeId });
				await call(who, 'list_scenes', { universeId });
				await call(who, 'get_scene', { universeId, sceneId: other.sceneId });
				await call(who, 'get_entity', { universeId, entityId: other.characterId });
				await call(who, 'find_appearances', { universeId, entityId: other.characterId });
				await call(who, 'search_text', { universeId, query: 'lantern' });
			}
		}
		expect(await stagedRows()).toBe(0);
		const after = await pool.query(`select id, body_md, updated_at from scenes order by id`);
		expect(after.rows).toEqual(before.rows);
	});
});

describe('limits', () => {
	it('slows one connection after 120 calls a minute without touching another writer', async () => {
		for (let i = 0; i < 120; i++) {
			expect((await call(alice, 'list_universes')).isError).toBe(false);
		}
		const blocked = await call(alice, 'list_universes');
		expect(blocked.isError).toBe(true);
		expect(blocked.text).toMatch(/^Too many calls\. Wait \d+ seconds and try again\.$/);
		expect((await call(bob, 'list_universes')).isError).toBe(false);
	});

	it('counts a writers connections together, so more apps do not mean more calls', async () => {
		const tokens = [
			alice.token,
			await connect(alice.userId, 'Second'),
			await connect(alice.userId, 'Third')
		];
		const allowed = [0, 0, 0];
		for (const [index, token] of tokens.entries()) {
			for (let i = 0; i < 120; i++) {
				if (!(await call(token, 'list_universes')).isError) allowed[index]++;
			}
		}
		expect(allowed).toEqual([120, 120, 0]);
	});

	it('answers 429 once a writer sends more requests than any client needs', async () => {
		const list = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
		let last = 0;
		for (let i = 0; i < 601; i++) last = (await send(list, { token: alice.token })).status;
		expect(last).toBe(429);
		expect((await send(list, { token: bob.token })).status).toBe(200);
	}, 30_000);

	it('gives staging a tighter budget of its own', async () => {
		let staged = 0;
		for (let i = 0; i < 31; i++) {
			const result = await comment(alice, { comment: `Note number ${i}.` });
			if (!result.isError) staged++;
		}
		expect(staged).toBe(30);
		expect((await comment(alice, { comment: 'One more.' })).text).toMatch(/^Too many calls/);
		// Reading is counted apart.
		expect((await call(alice, 'list_universes')).isError).toBe(false);
	});

	it('marks the connection as used', async () => {
		await call(alice, 'list_universes');
		const [grant] = await db
			.select({ lastUsedAt: oauthGrants.lastUsedAt })
			.from(oauthGrants)
			.where(eq(oauthGrants.userId, alice.userId));
		expect(grant.lastUsedAt).not.toBeNull();
	});
});
