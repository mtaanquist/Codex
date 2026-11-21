import { createHash } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import type pg from 'pg';
import {
	characters,
	entityMentions,
	oauthGrants,
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
const { TOOL_RESULT_MAX_CHARS } = await import('#lib/server/mcp/constants');
const route = await import('../../src/routes/api/mcp/+server');

const ORIGIN = 'http://localhost';
const MISSING = '00000000-0000-4000-8000-000000000000';
const NO_SCENE = 'No scene with that id in this story.';
const NO_ENTITY = 'No entity with that id.';
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

async function connect(userId: string, name = 'Writing Desk'): Promise<string> {
	const registered = await registerClient(db, {
		client_name: name,
		redirect_uris: ['https://app.example/callback']
	});
	if (!registered.ok) throw new Error(registered.description);
	const code = await createAuthorizationCode(db, {
		userId,
		client: registered.client,
		permissions: ['read', 'suggest'],
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

	it('offers the read tools, each asking for the universe, and nothing that stages', async () => {
		const { result } = await rpc(alice.token, 'tools/list');
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

	it('refuses a tool it does not offer, and stages nothing', async () => {
		for (const name of ['suggest_edit', 'leave_comment', 'reply_in_thread', 'no_such_tool']) {
			const result = await call(alice, name, {
				universeId: alice.universeId,
				sceneId: alice.sceneId,
				original: 'open',
				replacement: 'shut',
				comment: 'x'
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
