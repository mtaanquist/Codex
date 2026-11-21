import { createHash } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { asc, eq } from 'drizzle-orm';
import type pg from 'pg';
import {
	assistantDrafts,
	characters,
	entityCategories,
	entityMentions,
	loreEntries,
	oauthClients,
	oauthGrants,
	places,
	reviewInvitations,
	reviewers,
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
const {
	createAuthorizationCode,
	createPersonalToken,
	exchangeCode,
	listPersonalTokens,
	resolveBearer,
	revokeAllGrants,
	revokeGrant
} = await import('#lib/server/mcp/oauth');
const { saveMcpInstanceEnabled } = await import('#lib/server/mcp/settings');
const { NO_UNIVERSE_RESULT, callMcpTool } = await import('#lib/server/mcp/tools');
const {
	addComment,
	createSuggestion,
	createThread,
	decideSuggestion,
	ensureSuggestionThread,
	listSuggestions,
	listThreads,
	updateAssistantSuggestion
} = await import('#lib/server/review');
const {
	decideEntityProposal,
	decideSplitProposal,
	listProposals,
	stageEntityProposal,
	MAX_ENTITY_PROPOSALS_WAITING,
	MAX_SPLIT_PROPOSALS_WAITING
} = await import('#lib/server/proposals');
const { discardSceneDraft, sceneDraftFor } = await import('#lib/server/scene-drafts');
const { createAnchorMapper } = await import('#lib/review-anchor');
const { MAX_APP_DRAFTS_WAITING, MAX_STAGING_CALLS_WAITING, TOOL_RESULT_MAX_CHARS } =
	await import('#lib/server/mcp/constants');
const route = await import('../../src/routes/api/mcp/+server');

const ORIGIN = 'http://localhost';
const MISSING = '00000000-0000-4000-8000-000000000000';
const NO_SCENE = 'No scene with that id in this story.';
const NO_ENTITY = 'No entity with that id.';
const NO_THREAD = 'No thread with that id.';
const NO_SUGGESTION = 'No suggestion with that id.';
const APP_NAME = 'Writing Desk';
const APP = `${APP_NAME} (app.example)`;
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
	if (!code) throw new Error('no code was issued');
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
		      + (select count(*) from assistant_drafts) + (select count(*) from entity_proposals)
		      + (select count(*) from scene_split_proposals) as n`
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
			'get_review_note',
			'get_scene',
			'list_review_notes',
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
			'propose_scene_split',
			'reply_in_thread',
			'stage_scene_draft',
			'suggest_edit',
			'suggest_entity',
			'update_suggestion'
		]);
		expect(tools).toHaveLength(17);
		const required = (name: string) =>
			tools.find((tool) => tool.name === name)!.inputSchema.required;
		expect(required('reply_in_thread')).toEqual(['universeId', 'threadId', 'comment']);
		expect(required('update_suggestion')).toEqual(['universeId', 'suggestionId', 'replacement']);
		// The note and the edit a suggestion is linked to are named, not required.
		const suggest = tools.find((tool) => tool.name === 'suggest_edit')!.inputSchema as {
			required: string[];
			properties: Record<string, unknown>;
		};
		expect(suggest.required).toEqual(['universeId', 'sceneId', 'original', 'replacement']);
		expect(suggest.properties).toHaveProperty('patternNoteId');
		expect(suggest.properties).toHaveProperty('followsSuggestionId');
		// The in-app tool takes neither: there the page fixes them.
		const inApp = TOOLS.find((tool) => tool.name === 'suggest_edit')!.parameters as {
			properties: Record<string, unknown>;
		};
		expect(inApp.properties).not.toHaveProperty('patternNoteId');
	});

	it('offers a prompt for each Assistant flow, by what the connection may do', async () => {
		const { result: opening } = await rpc(alice.token, 'initialize', {
			protocolVersion: '2025-06-18',
			capabilities: {},
			clientInfo: { name: 'test', version: '1' }
		});
		expect(opening?.capabilities).toHaveProperty('prompts');

		type Listed = { name: string; arguments: { name: string; required?: boolean }[] }[];
		const { result } = await rpc(alice.token, 'prompts/list');
		const prompts = result!.prompts as Listed;
		expect(prompts.map((prompt) => prompt.name).sort()).toEqual([
			'catchup',
			'continuity-review',
			'copyedit',
			'draft',
			'draft-chapter',
			'find',
			'pattern-pass',
			'review',
			'rewrite',
			'who',
			'write'
		]);
		const review = prompts.find((prompt) => prompt.name === 'review')!;
		expect(review.arguments).toEqual([
			expect.objectContaining({ name: 'universeId', required: true }),
			expect.objectContaining({ name: 'sceneId', required: true }),
			expect.objectContaining({ name: 'focus', required: false })
		]);

		const readOnly = await connect(alice.userId, 'Reader', ['read']);
		const reader = (await rpc(readOnly, 'prompts/list')).result!.prompts as Listed;
		expect(reader.map((prompt) => prompt.name)).not.toContain('review');
		expect(reader.map((prompt) => prompt.name)).toContain('catchup');
		const refused = await rpc(readOnly, 'prompts/get', {
			name: 'review',
			arguments: { universeId: alice.universeId, sceneId: alice.sceneId }
		});
		expect(refused.error).toBeDefined();
	});

	it('gives a prompt as text built from the arguments alone', async () => {
		const get = (args: Record<string, unknown>, name = 'review') =>
			rpc(alice.token, 'prompts/get', { name, arguments: args });
		const promptText = (answered: Awaited<ReturnType<typeof get>>) => {
			const messages = answered.result!.messages as {
				role: string;
				content: { type: string; text: string };
			}[];
			expect(messages).toHaveLength(1);
			expect(messages[0].role).toBe('user');
			return messages[0].content.text;
		};

		const own = promptText(await get({ universeId: alice.universeId, sceneId: alice.sceneId }));
		expect(own).toContain(`The universe id is ${alice.universeId}`);
		expect(own).toContain(`Review the scene with id ${alice.sceneId}.`);
		expect(own).toContain('Read it in full with get_scene');
		expect(own).toContain("You cannot change the writer's text.");

		// A prompt reads nothing: for another writer's ids it is the same text
		// around those ids, and says nothing of what they name. The tools it
		// points at are what refuse them.
		const others = promptText(await get({ universeId: bob.universeId, sceneId: bob.sceneId }));
		expect(others).not.toMatch(/Bob|Quay|lantern/);
		expect(others.replaceAll(bob.universeId, 'U').replaceAll(bob.sceneId, 'S')).toBe(
			own.replaceAll(alice.universeId, 'U').replaceAll(alice.sceneId, 'S')
		);

		// A bad argument is refused, with the argument named.
		const bad = await get({ universeId: alice.universeId, sceneId: 'nope' });
		expect(bad.error?.message).toContain('"sceneId" must be an id from list_scenes.');
		expect((await get({ universeId: alice.universeId })).error).toBeDefined();
		expect((await get({}, 'no-such-prompt')).error).toBeDefined();
		expect(await stagedRows()).toBe(0);
	});

	it('refuses a tool it does not offer, and stages nothing', async () => {
		const readOnly = await connect(alice.userId, 'Reader', ['read']);
		const attempts: [string, string][] = [
			[readOnly, 'suggest_edit'],
			[readOnly, 'leave_comment'],
			[readOnly, 'leave_pattern_note'],
			[readOnly, 'propose_scene_split'],
			[readOnly, 'suggest_entity'],
			[readOnly, 'stage_scene_draft'],
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
				rationale: 'x',
				kind: 'character',
				name: 'Old Marit',
				text: 'A draft.'
			});
			expect(result.isError).toBe(true);
		}
		expect(await stagedRows()).toBe(0);
	});

	it('keeps the external tools out of the in-app toolbox', async () => {
		const external = TOOLS.filter((tool) => tool.external).map((tool) => tool.name);
		expect(external.sort()).toEqual(['list_stories', 'list_universes', 'stage_scene_draft']);
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

const NO_NOTE = 'No review note of yours with that id.';
const NO_STORY = 'No story with that id.';
const PATTERN = 'Pattern note (lanterns): the word carries every sentence.';
// Four paragraphs, each with a word of its own to edit.
const PARAGRAPHS = [
	'One open lantern.',
	'Two dark lantern.',
	'Three far paragraph.',
	'Four last words.'
].join('\n\n');

async function setBody(who: World, bodyMd: string) {
	await db.update(scenes).set({ bodyMd }).where(eq(scenes.id, who.sceneId));
}

async function storyOf(sceneId: string): Promise<string> {
	const [row] = await db.select().from(scenes).where(eq(scenes.id, sceneId));
	return row.storyId;
}

// A pattern note the app leaves on the writer's scene; its id.
async function patternNote(
	who: World,
	edits: { original: string; replacement: string }[] = [{ original: 'open', replacement: 'shut' }]
): Promise<string> {
	const result = await call(who, 'leave_pattern_note', {
		universeId: who.universeId,
		sceneId: who.sceneId,
		comment: PATTERN,
		edits
	});
	return idIn(result.text);
}

async function writerSays(who: World, threadId: string, body: string) {
	const said = await addComment(db, {
		storyId: who.storyId,
		threadId,
		author: { userId: who.userId },
		body
	});
	if (!said.ok) throw new Error(said.reason);
}

async function guestSays(who: World, threadId: string, body: string) {
	const [invitation] = await db
		.insert(reviewInvitations)
		.values({ storyId: who.storyId, createdBy: who.userId, tokenHash: `guest-${threadId}` })
		.returning({ id: reviewInvitations.id });
	const [reviewer] = await db
		.insert(reviewers)
		.values({ invitationId: invitation.id, displayName: 'Guest Gil' })
		.returning({ id: reviewers.id });
	const said = await addComment(db, {
		storyId: who.storyId,
		threadId,
		author: { reviewerId: reviewer.id },
		body
	});
	if (!said.ok) throw new Error(said.reason);
}

// The discussion under a suggested edit, opened as the writer's first reply
// there would open it.
async function discussionOf(who: World, suggestionId: string): Promise<string> {
	const thread = await ensureSuggestionThread(db, { storyId: who.storyId, suggestionId });
	if (!thread.ok) throw new Error(thread.reason);
	return thread.threadId;
}

// The app the writer's first connection is, as the author of a row.
async function appOf(who: World) {
	const [row] = await db
		.select({ client: oauthClients })
		.from(oauthGrants)
		.innerJoin(oauthClients, eq(oauthGrants.clientId, oauthClients.id))
		.where(eq(oauthGrants.userId, who.userId))
		.orderBy(asc(oauthGrants.createdAt))
		.limit(1);
	return { client: { id: row.client.id, name: row.client.clientName, host: row.client.host } };
}

// The context a call from the writer's app runs in, for a call made past the
// endpoint.
async function appContext(who: World, maxNotesPerScene = 100) {
	return {
		db,
		userId: who.userId,
		universeId: who.universeId,
		external: { sceneBodyCap: 1000, ...(await appOf(who)), maxNotesPerScene, origin: ORIGIN }
	};
}

const trash = (sceneId: string) =>
	db.update(scenes).set({ deletedAt: new Date() }).where(eq(scenes.id, sceneId));

// A database whose reads fail the way a query does: the message carries the
// statement and the values bound to it.
const SECRET = 'SECRET PROSE';
function brokenDb(real: Database = db): Database {
	return new Proxy(real, {
		get(target, prop) {
			if (prop === 'select') {
				return () => {
					throw Object.assign(
						new Error(`Failed query: select "body_md" from "scenes"\nparams: ${SECRET}`),
						{ query: 'select "body_md" from "scenes"', params: [SECRET], cause: { code: 'XX000' } }
					);
				};
			}
			if (prop === 'transaction') {
				return (run: (tx: Database) => Promise<unknown>) =>
					target.transaction((tx) => run(brokenDb(tx as unknown as Database)));
			}
			const value = target[prop as keyof Database] as unknown;
			return typeof value === 'function' ? value.bind(target) : value;
		}
	}) as Database;
}

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

describe('the same call sent several times at once', () => {
	const SIX = Array.from({ length: 6 });

	it('stages one edit and one comment, not one for each call', async () => {
		const edits = await Promise.all(SIX.map(() => edit(alice)));
		expect(edits.filter((entry) => entry.text.includes('Staged a suggested edit'))).toHaveLength(1);
		const comments = await Promise.all(SIX.map(() => comment(alice)));
		expect(comments.filter((entry) => entry.text.includes('Staged a review comment'))).toHaveLength(
			1
		);
		expect(await stagedRows()).toBe(3);
	});

	it('holds the ceiling of waiting notes on a scene', async () => {
		const ctx = await appContext(alice, 2);
		const outcomes = await Promise.all(
			SIX.map((_, n) =>
				dispatchToolCall(ctx, {
					id: 'call',
					name: 'leave_comment',
					arguments: JSON.stringify({ sceneId: alice.sceneId, comment: `Note ${n}.` })
				})
			)
		);
		expect(outcomes.filter((outcome) => outcome.staged)).toHaveLength(2);
		expect((await listThreads(db, alice.storyId, mapRange)).length).toBe(2);
	});

	const BUSY = 'Another call is still running. Try again.';
	const leave = (ctx: Awaited<ReturnType<typeof appContext>>, n: number) =>
		dispatchToolCall(ctx, {
			id: 'call',
			name: 'leave_comment',
			arguments: JSON.stringify({ sceneId: alice.sceneId, comment: `Note ${n}.` })
		});

	it('waits its turn without a database connection, and turns away a crowd', async () => {
		const ctx = await appContext(alice);
		let busiest = 0;
		const watch = setInterval(() => {
			busiest = Math.max(busiest, pool.totalCount - pool.idleCount);
		}, 1);
		const calls = Array.from({ length: 30 }, (_, n) => leave(ctx, n));
		// Something else the server does meanwhile is not kept waiting.
		const began = Date.now();
		await pool.query('select 1');
		const unrelated = Date.now() - began;
		const outcomes = await Promise.all(calls);
		clearInterval(watch);
		expect(unrelated).toBeLessThan(1000);
		// One call at work, and the unrelated query beside it.
		expect(busiest).toBeLessThanOrEqual(2);
		// One runs, a few wait, the rest are told to come back.
		expect(outcomes.filter((outcome) => outcome.staged)).toHaveLength(
			MAX_STAGING_CALLS_WAITING + 1
		);
		expect(outcomes.filter((outcome) => outcome.result === BUSY)).toHaveLength(
			30 - MAX_STAGING_CALLS_WAITING - 1
		);
		// The queue is empty again afterwards.
		expect((await leave(ctx, 99)).staged).toBe(true);
	});

	it('gives up rather than sit on a connection when the lock is held elsewhere', async () => {
		const ctx = await appContext(alice);
		const holder = await pool.connect();
		try {
			await holder.query('begin');
			await holder.query('select pg_advisory_xact_lock(hashtext($1))', [
				`mcp-staging:${ctx.external.client.id}:${alice.universeId}`
			]);
			const began = Date.now();
			const outcome = await leave(ctx, 1);
			expect(outcome).toMatchObject({ staged: false, result: BUSY });
			expect(Date.now() - began).toBeLessThan(5000);
		} finally {
			await holder.query('rollback');
			holder.release();
		}
		expect(await stagedRows()).toBe(0);
		expect((await leave(ctx, 1)).staged).toBe(true);
	});

	it('keeps the writers save of the scene waiting only briefly behind a long note', async () => {
		const words = Array.from({ length: 40 }, (_, n) => `word${n}x`);
		await setBody(alice, words.map((word) => `A line with ${word} in it.`).join('\n\n'));
		const ctx = await appContext(alice);
		const saver = await pool.connect();
		try {
			const noting = dispatchToolCall(ctx, {
				id: 'call',
				name: 'leave_pattern_note',
				arguments: JSON.stringify({
					sceneId: alice.sceneId,
					comment: PATTERN,
					edits: words.map((word) => ({ original: word, replacement: `${word}y` }))
				})
			});
			// What a save takes: the scene's revision lock. Asked for again and
			// again while the note is staged; the longest wait is what a save
			// would have seen.
			let longest = 0;
			let done = false;
			void noting.then(() => (done = true));
			while (!done) {
				const began = Date.now();
				await saver.query('begin');
				await saver.query('select pg_advisory_xact_lock(hashtext($1))', [`scene:${alice.sceneId}`]);
				await saver.query('commit');
				longest = Math.max(longest, Date.now() - began);
				await new Promise((resolve) => setTimeout(resolve, 2));
			}
			expect((await noting).result).toContain('with 40 linked edits');
			expect(longest).toBeLessThan(2000);
		} finally {
			saver.release();
		}
	});
});

describe('leave_pattern_note', () => {
	const note = (who: World, overrides: Record<string, unknown> = {}) =>
		call(who, 'leave_pattern_note', {
			universeId: who.universeId,
			sceneId: who.sceneId,
			comment: PATTERN,
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
		// The app is told the note's id and where the writer works through it.
		expect(idIn(result.text)).toBe(thread.id);
		expect(result.text).toContain(
			`${ORIGIN}/stories/${alice.storyId}/review?scene=${alice.sceneId}&pass=${thread.id}`
		);

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
	const POSTED = 'Your reply was posted to the thread.';

	async function threadBy(
		who: World,
		author: Parameters<typeof createThread>[1]['author'],
		sceneId = who.sceneId,
		storyId = who.storyId
	) {
		const created = await createThread(db, {
			storyId,
			sceneId,
			anchor: null,
			author,
			body: 'What do you make of this?'
		});
		if (!created.ok) throw new Error(created.reason);
		return created.threadId;
	}

	// A note the app left that the writer has answered.
	async function answeredNote(who: World) {
		const own = idIn((await comment(who)).text);
		await writerSays(who, own, 'Go on.');
		return own;
	}

	it('replies in a note of its own once the writer has answered, in the apps name', async () => {
		const own = await answeredNote(alice);
		expect((await reply(alice, own)).text).toBe(POSTED);
		const [thread] = await listThreads(db, alice.storyId, mapRange);
		expect(thread.comments.map((entry) => [entry.authorName, entry.isApp])).toEqual([
			[APP, true],
			['Alice', false],
			[APP, true]
		]);
	});

	it('replies in the discussion under an edit of its own', async () => {
		const own = idIn((await edit(alice)).text);
		const threadId = await discussionOf(alice, own);
		await writerSays(alice, threadId, 'Why shut?');
		expect((await reply(alice, threadId)).text).toBe(POSTED);
	});

	it('does not answer itself: one reply, then it waits for someone else', async () => {
		const own = idIn((await comment(alice)).text);
		// Its own note is the latest word in that thread.
		expect((await reply(alice, own)).text).toContain('Wait for the writer to answer');
		await writerSays(alice, own, 'Go on.');
		expect((await reply(alice, own)).text).toBe(POSTED);
		expect((await reply(alice, own)).text).toContain('Wait for the writer to answer');
		await writerSays(alice, own, 'And then?');
		expect((await reply(alice, own)).text).toBe(POSTED);
	});

	it('posts once when the same reply is sent several times at once', async () => {
		const own = await answeredNote(alice);
		const answers = await Promise.all(Array.from({ length: 5 }, () => reply(alice, own)));
		expect(answers.filter((entry) => entry.text === POSTED)).toHaveLength(1);
		const [thread] = await listThreads(db, alice.storyId, mapRange);
		expect(thread.comments).toHaveLength(3);
	});

	it('finds no thread it did not open: the writers, a guests, the Assistants, another apps', async () => {
		const owners = await threadBy(alice, { userId: alice.userId });
		const assistants = await threadBy(alice, { assistant: true });
		const guests = await threadBy(alice, { userId: alice.userId });
		// A guest's thread: the opening comment is the guest's.
		await guestSays(alice, guests, 'From the guest.');
		await pool.query(
			'delete from review_comments where thread_id = $1 and author_user_id is not null',
			[guests]
		);
		const second = await connect(alice.userId, 'Second');
		const others = idIn((await comment({ ...alice, token: second }, { comment: 'Mine.' })).text);
		// The discussion under an edit that is not the app's.
		const assistantsEdit = await createSuggestion(db, {
			storyId: alice.storyId,
			sceneId: alice.sceneId,
			author: { assistant: true },
			range: { start: 11, end: 18 },
			replacement: 'lamp'
		});
		if (!assistantsEdit.ok) throw new Error(assistantsEdit.reason);
		const underAssistants = await discussionOf(alice, assistantsEdit.suggestionId);
		const others2 = idIn(
			(await edit({ ...alice, token: second }, { original: 'prose', replacement: 'verse' })).text
		);
		const underOthers = await discussionOf(alice, others2);
		for (const threadId of [owners, assistants, guests, others, underAssistants, underOthers]) {
			await writerSays(alice, threadId, 'Anyone?');
		}
		const before = await pool.query('select count(*) from review_comments');
		for (const threadId of [owners, assistants, guests, others, underAssistants, underOthers]) {
			expect(await reply(alice, threadId)).toEqual({ text: NO_THREAD, isError: false });
		}
		const after = await pool.query('select count(*) from review_comments');
		expect(after.rows).toEqual(before.rows);
	});

	it('finds no thread that is another writers, in a muted story, on a trashed scene or missing', async () => {
		await expectNoUniverse('reply_in_thread', { threadId: MISSING, comment: 'x' });
		const bobs = await answeredNote(bob);
		// Notes of its own that it can no longer reach.
		const app = await appOf(alice);
		const [mutedScene] = await db.select().from(scenes).where(eq(scenes.id, alice.mutedSceneId));
		const muted = await threadBy(alice, app, mutedScene.id, mutedScene.storyId);
		await addComment(db, {
			storyId: mutedScene.storyId,
			threadId: muted,
			author: { userId: alice.userId },
			body: 'Go on.'
		});
		const [second] = await db
			.insert(scenes)
			.values({ storyId: alice.storyId, globalPosition: 2, title: 'Second', bodyMd: 'More.' })
			.returning({ id: scenes.id });
		const trashed = await threadBy(alice, app, second.id);
		await writerSays(alice, trashed, 'Go on.');
		const underTrashed = await createSuggestion(db, {
			storyId: alice.storyId,
			sceneId: second.id,
			author: app,
			range: { start: 0, end: 4 },
			replacement: 'Less'
		});
		if (!underTrashed.ok) throw new Error(underTrashed.reason);
		const discussion = await discussionOf(alice, underTrashed.suggestionId);
		await writerSays(alice, discussion, 'Go on.');
		await trash(second.id);
		const own = await answeredNote(alice);
		const before = await pool.query('select count(*) from review_comments');
		for (const threadId of [bobs, muted, trashed, discussion, MISSING, 'nope']) {
			expect(await reply(alice, threadId)).toEqual({ text: NO_THREAD, isError: false });
		}
		// Bob's thread through Bob's universe is no universe at all.
		expect(await reply(alice, bobs, bob.universeId)).toEqual({
			text: NO_UNIVERSE_RESULT,
			isError: true
		});
		// A thread of its own, asked for through the writer's other universe.
		expect(await reply(alice, own, alice.otherUniverseId)).toEqual({
			text: NO_THREAD,
			isError: false
		});
		const after = await pool.query('select count(*) from review_comments');
		expect(after.rows).toEqual(before.rows);
	});
});

describe('update_suggestion', () => {
	const revise = (
		who: World | string,
		suggestionId: unknown,
		universeId = alice.universeId,
		replacement = 'closed'
	) => call(who, 'update_suggestion', { universeId, suggestionId, replacement });
	const replacementOf = async (id: string) =>
		(await db.select().from(reviewSuggestions).where(eq(reviewSuggestions.id, id)))[0].replacement;
	// The writer asks for a change in the edit's discussion.
	async function asked(who: World, suggestionId: string) {
		await writerSays(who, await discussionOf(who, suggestionId), 'Try another word.');
	}

	it('revises its own pending suggestion once the writer has asked, and no other', async () => {
		const own = idIn((await edit(alice)).text);
		// Not before the writer has said anything about it.
		expect((await revise(alice, own)).text).toContain('after the writer has answered');
		expect(await replacementOf(own)).toBe('shut');
		await asked(alice, own);
		expect((await revise(alice, own)).text).toContain('now proposes the revised text');
		expect(await replacementOf(own)).toBe('closed');
		// One revision for each thing the writer says: a second one would keep
		// an accept of what they just read refused.
		expect((await revise(alice, own, alice.universeId, 'fastened')).text).toContain(
			'already revised'
		);
		expect(await replacementOf(own)).toBe('closed');
		await asked(alice, own);
		expect((await revise(alice, own, alice.universeId, 'fastened')).text).toContain(
			'now proposes the revised text'
		);
		expect((await revise(alice, own)).text).toContain('already revised');
		expect(await replacementOf(own)).toBe('fastened');
		// Once it has answered, it waits for the writer again.
		expect(
			(
				await call(alice, 'reply_in_thread', {
					universeId: alice.universeId,
					threadId: await discussionOf(alice, own),
					comment: 'Changed it.'
				})
			).text
		).toBe('Your reply was posted to the thread.');
		expect((await revise(alice, own, alice.universeId, 'barred')).text).toContain(
			'after the writer has answered'
		);
		expect(await replacementOf(own)).toBe('fastened');

		// The Assistant's, another app's and the writer's own are not its to
		// change, and look the same as one that does not exist.
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
			await asked(alice, id as string);
			expect(await revise(alice, id)).toEqual({ text: NO_SUGGESTION, isError: false });
			expect(await replacementOf(id as string)).not.toBe('closed');
		}
	});

	it('refuses a revision that changes nothing, or that repeats another of its edits', async () => {
		const own = idIn((await edit(alice)).text);
		const twin = idIn((await edit(alice, { replacement: 'closed' })).text);
		await asked(alice, own);
		// Back to the text the scene already has.
		expect((await revise(alice, own, alice.universeId, 'open')).text).toContain('changes nothing');
		expect((await revise(alice, own)).text).toContain('already staged this exact edit');
		expect(await replacementOf(own)).toBe('shut');
		expect(await replacementOf(twin)).toBe('closed');
	});

	it('holds the Assistant to the same two rules in the app', async () => {
		const staged = await createSuggestion(db, {
			storyId: alice.storyId,
			sceneId: alice.sceneId,
			author: { assistant: true },
			range: { start: 6, end: 10 },
			replacement: 'shut'
		});
		const twin = await createSuggestion(db, {
			storyId: alice.storyId,
			sceneId: alice.sceneId,
			author: { assistant: true },
			range: { start: 6, end: 10 },
			replacement: 'closed'
		});
		if (!staged.ok || !twin.ok) throw new Error('not staged');
		const to = (replacement: string) =>
			updateAssistantSuggestion(db, {
				storyId: alice.storyId,
				suggestionId: staged.suggestionId,
				replacement
			});
		expect(await to('open')).toMatchObject({ ok: false });
		expect(await to('closed')).toMatchObject({ ok: false });
		expect(await to('barred')).toEqual({ ok: true });
	});

	it('finds no suggestion that is decided, on a trashed scene, another writers or missing', async () => {
		await expectNoUniverse('update_suggestion', { suggestionId: MISSING, replacement: 'x' });
		const bobs = idIn((await edit(bob)).text);
		await asked(bob, bobs);
		const decided = idIn((await edit(alice)).text);
		await asked(alice, decided);
		await decideSuggestion(db, alice.userId, alice.storyId, decided, false);
		const [second] = await db
			.insert(scenes)
			.values({ storyId: alice.storyId, globalPosition: 2, title: 'Second', bodyMd: 'More.' })
			.returning({ id: scenes.id });
		const trashed = idIn(
			(await edit(alice, { sceneId: second.id, original: 'More', replacement: 'Less' })).text
		);
		await asked(alice, trashed);
		await trash(second.id);
		for (const id of [bobs, decided, trashed, MISSING, 'nope']) {
			expect(await revise(alice, id)).toEqual({ text: NO_SUGGESTION, isError: false });
		}
		expect(await revise(alice, bobs, bob.universeId)).toEqual({
			text: NO_UNIVERSE_RESULT,
			isError: true
		});
		expect(await replacementOf(bobs)).toBe('shut');
		expect(await replacementOf(decided)).toBe('shut');
		expect(await replacementOf(trashed)).toBe('Less');
	});
});

describe('suggest_edit linked to a pattern note', () => {
	it('adds an edit to its own pattern note and to no one elses', async () => {
		await setBody(alice, PARAGRAPHS);
		const noteId = await patternNote(alice);
		const added = await edit(alice, {
			original: 'dark',
			replacement: 'dim',
			patternNoteId: noteId
		});
		expect(added.text).toContain('Staged a suggested edit');
		const linked = (await listSuggestions(db, alice.storyId)).find(
			(row) => row.id === idIn(added.text)
		);
		expect(linked).toMatchObject({ patternThreadId: noteId, reviewerName: APP });

		await setBody(bob, PARAGRAPHS);
		const second = await connect(alice.userId, 'Second');
		const assistants = await createThread(db, {
			storyId: alice.storyId,
			sceneId: alice.sceneId,
			anchor: null,
			author: { assistant: true },
			body: 'Pattern note (far): from the Assistant.'
		});
		const notTheirs = [
			await patternNote(bob),
			await patternNote({ ...alice, token: second }, [{ original: 'last', replacement: 'final' }]),
			assistants.ok && assistants.threadId,
			MISSING,
			'nope'
		];
		const before = await stagedRows();
		for (const patternNoteId of notTheirs) {
			expect(await edit(alice, { original: 'far', replacement: 'near', patternNoteId })).toEqual({
				text: NO_NOTE,
				isError: false
			});
		}
		expect(await stagedRows()).toBe(before);
	});

	it('stages one follow-up to an accepted edit, held to the paragraphs around it', async () => {
		await setBody(alice, PARAGRAPHS);
		const noteId = await patternNote(alice);
		const [first] = await listSuggestions(db, alice.storyId);
		await decideSuggestion(db, alice.userId, alice.storyId, first.id, true);
		const follow = (original: string, replacement: string) =>
			edit(alice, { original, replacement, followsSuggestionId: first.id });

		// Two paragraphs on from the change is out of reach.
		expect((await follow('far', 'near')).text).toContain('outside the paragraphs under review');
		const staged = await follow('dark', 'dim');
		expect(staged.text).toContain('Staged a suggested edit');
		const row = (await listSuggestions(db, alice.storyId)).find(
			(entry) => entry.id === idIn(staged.text)
		);
		expect(row).toMatchObject({ patternThreadId: noteId, followsId: first.id, status: 'pending' });
		// One per accepted edit, whatever becomes of it.
		await decideSuggestion(db, alice.userId, alice.storyId, row!.id, false);
		expect((await follow('Two', 'Second')).text).toBe(
			'You have already staged a follow-up to that edit.'
		);
		expect(await listSuggestions(db, alice.storyId)).toHaveLength(2);
	});

	it('links nothing to a note or an accepted edit on a trashed scene', async () => {
		await setBody(alice, PARAGRAPHS);
		const noteId = await patternNote(alice);
		const [first] = await listSuggestions(db, alice.storyId);
		await decideSuggestion(db, alice.userId, alice.storyId, first.id, true);
		const [second] = await db
			.insert(scenes)
			.values({ storyId: alice.storyId, globalPosition: 2, title: 'Second', bodyMd: 'More far.' })
			.returning({ id: scenes.id });
		await trash(alice.sceneId);
		const before = await stagedRows();
		// The note sits on the trashed scene; the edit would go on a live one.
		expect(
			await edit(alice, {
				sceneId: second.id,
				original: 'far',
				replacement: 'near',
				patternNoteId: noteId
			})
		).toEqual({ text: NO_NOTE, isError: false });
		expect(
			await edit(alice, { original: 'dark', replacement: 'dim', followsSuggestionId: first.id })
		).toEqual({ text: 'No accepted edit with that id in a note of yours.', isError: false });
		expect(await stagedRows()).toBe(before);
	});

	it('stages one follow-up when several are sent at once', async () => {
		await setBody(alice, PARAGRAPHS);
		await patternNote(alice);
		const [first] = await listSuggestions(db, alice.storyId);
		await decideSuggestion(db, alice.userId, alice.storyId, first.id, true);
		const answers = await Promise.all(
			['dim', 'dull', 'dusky', 'faint'].map((replacement) =>
				edit(alice, { original: 'dark', replacement, followsSuggestionId: first.id })
			)
		);
		expect(answers.filter((entry) => entry.text.includes('Staged a suggested edit'))).toHaveLength(
			1
		);
		expect(
			(await listSuggestions(db, alice.storyId)).filter((row) => row.followsId === first.id)
		).toHaveLength(1);
	});

	it('follows nothing that is not an accepted edit in a note of its own', async () => {
		await setBody(alice, PARAGRAPHS);
		await setBody(bob, PARAGRAPHS);
		// Its own edit, still pending.
		await patternNote(alice);
		const [pending] = await listSuggestions(db, alice.storyId);
		// Another writer's accepted edit.
		await patternNote(bob);
		const [bobs] = await listSuggestions(db, bob.storyId);
		await decideSuggestion(db, bob.userId, bob.storyId, bobs.id, true);
		// The Assistant's accepted edit, in its own note on this writer's scene.
		const assistants = await dispatchToolCall(
			{ db, userId: alice.userId, universeId: alice.universeId },
			{
				id: 'call',
				name: 'leave_pattern_note',
				arguments: JSON.stringify({
					sceneId: alice.sceneId,
					comment: 'Pattern note (dark): from the Assistant.',
					edits: [{ original: 'dark', replacement: 'dim' }]
				})
			}
		);
		expect(assistants.staged).toBe(true);
		const assistantsEdit = (await listSuggestions(db, alice.storyId)).find(
			(row) => row.isAssistant
		)!;
		await decideSuggestion(db, alice.userId, alice.storyId, assistantsEdit.id, true);

		const before = await stagedRows();
		for (const followsSuggestionId of [pending.id, bobs.id, assistantsEdit.id, MISSING, 'nope']) {
			expect(
				await edit(alice, { original: 'Two', replacement: 'Second', followsSuggestionId })
			).toEqual({ text: 'No accepted edit with that id in a note of yours.', isError: false });
		}
		expect(await stagedRows()).toBe(before);
	});
});

describe('list_review_notes', () => {
	const list = (who: World | string, storyId: unknown, universeId = alice.universeId) =>
		call(who, 'list_review_notes', { universeId, storyId });
	type Listed = {
		notes: {
			id: string;
			opening: string;
			edits: Record<string, number>;
			writerRepliedLast: boolean;
		}[];
		otherEdits: { id: string; writerRepliedLast: boolean }[];
	};
	const listed = async () => JSON.parse((await list(alice, alice.storyId)).text) as Listed;

	it('lists the apps own notes with what became of their edits', async () => {
		await setBody(alice, PARAGRAPHS);
		const noteId = await patternNote(alice, [
			{ original: 'open', replacement: 'shut' },
			{ original: 'dark', replacement: 'dim' },
			{ original: 'far', replacement: 'near' }
		]);
		const edits = await listSuggestions(db, alice.storyId);
		await decideSuggestion(db, alice.userId, alice.storyId, edits[0].id, true);
		await decideSuggestion(db, alice.userId, alice.storyId, edits[1].id, false);
		const loose = idIn((await edit(alice, { original: 'last', replacement: 'final' })).text);
		const plain = idIn((await comment(alice)).text);
		// Notes that are someone else's: another app's, the Assistant's, the writer's.
		const second = await connect(alice.userId, 'Second');
		await comment({ ...alice, token: second }, { comment: 'From the second app.' });
		await edit({ ...alice, token: second }, { original: 'Four', replacement: 'Fourth' });
		for (const author of [{ assistant: true as const }, { userId: alice.userId }]) {
			await createThread(db, {
				storyId: alice.storyId,
				sceneId: alice.sceneId,
				anchor: null,
				author,
				body: 'Not from this app.'
			});
		}

		const result = await listed();
		expect(result.notes.map((note) => note.id).sort()).toEqual([noteId, plain].sort());
		const note = result.notes.find((entry) => entry.id === noteId)!;
		expect(note).toMatchObject({
			sceneId: alice.sceneId,
			sceneTitle: 'Alice Quay',
			resolved: false,
			edits: { pending: 1, accepted: 1, rejected: 1 },
			writerRepliedLast: false
		});
		expect(note.opening).toContain('Pattern note (lanterns)');
		expect(result.otherEdits).toEqual([
			expect.objectContaining({
				id: loose,
				status: 'pending',
				replacement: 'final',
				writerRepliedLast: false
			})
		]);
	});

	it('flags a note the writer answered last, on the note or under one of its edits', async () => {
		await setBody(alice, PARAGRAPHS);
		const noteId = await patternNote(alice);
		const [linked] = await listSuggestions(db, alice.storyId);
		const loose = idIn((await edit(alice, { original: 'last', replacement: 'final' })).text);
		const flagged = async () => {
			const result = await listed();
			return [result.notes[0].writerRepliedLast, result.otherEdits[0].writerRepliedLast];
		};
		expect(await flagged()).toEqual([false, false]);

		await writerSays(alice, noteId, 'Why this one?');
		expect(await flagged()).toEqual([true, false]);
		// A guest's aside does not answer the writer; the app's reply does.
		await guestSays(alice, noteId, 'A guest aside.');
		expect(await flagged()).toEqual([true, false]);
		await call(alice, 'reply_in_thread', {
			universeId: alice.universeId,
			threadId: noteId,
			comment: 'Because it repeats.'
		});
		expect(await flagged()).toEqual([false, false]);

		await writerSays(alice, await discussionOf(alice, linked.id), 'Could it be "ajar"?');
		expect(await flagged()).toEqual([true, false]);
		await writerSays(alice, await discussionOf(alice, loose), 'Not sure about this.');
		expect(await flagged()).toEqual([true, true]);
	});

	it('finds no story that is another writers, muted, in the trash or missing', async () => {
		await expectNoUniverse('list_review_notes', { storyId: alice.storyId });
		await comment(bob);
		const before = await stagedRows();
		const hidden = [
			bob.storyId,
			await storyOf(alice.mutedSceneId),
			await storyOf(alice.trashedStorySceneId),
			MISSING,
			'nope'
		];
		for (const storyId of hidden) {
			expect(await list(alice, storyId)).toEqual({ text: NO_STORY, isError: false });
		}
		// The writer's own story, asked for through their other universe.
		expect(await list(alice, alice.storyId, alice.otherUniverseId)).toEqual({
			text: NO_STORY,
			isError: false
		});
		expect(await list(alice, bob.storyId, bob.universeId)).toEqual({
			text: NO_UNIVERSE_RESULT,
			isError: true
		});
		expect(await stagedRows()).toBe(before);
	});
});

describe('get_review_note', () => {
	const get = (who: World | string, noteId: unknown, universeId = alice.universeId) =>
		call(who, 'get_review_note', { universeId, noteId });
	type Reply = { from: string; body: string };
	type Got = {
		storyId: string;
		note?: { id: string; comments: Reply[] };
		edits: { id: string; threadId: string | null; replies: Reply[] }[];
		workThroughLink?: string;
	};
	const said = (replies: Reply[]) => replies.map((reply) => [reply.from, reply.body]);

	it('returns the note, the talk with the writer in order, and each edit as it stands', async () => {
		await setBody(alice, PARAGRAPHS);
		const noteId = await patternNote(alice, [
			{ original: 'open', replacement: 'shut' },
			{ original: 'dark', replacement: 'dim' }
		]);
		const [first, second] = await listSuggestions(db, alice.storyId);
		// The writer accepts the first in their own words and asks about the second.
		await decideSuggestion(db, alice.userId, alice.storyId, first.id, true, 'ajar');
		const discussion = await discussionOf(alice, second.id);
		await writerSays(alice, discussion, 'Could it be "dull"?');
		// On the note: the writer, a guest, another app, then this app.
		await writerSays(alice, noteId, 'Why this one?');
		await guestSays(alice, noteId, 'A guest aside.');
		const other = await connect(alice.userId, 'Second');
		await call(other, 'reply_in_thread', {
			universeId: alice.universeId,
			threadId: noteId,
			comment: 'Another app butting in.'
		});
		await call(alice, 'reply_in_thread', {
			universeId: alice.universeId,
			threadId: noteId,
			comment: 'Because it repeats.'
		});

		const got = JSON.parse((await get(alice, noteId)).text) as Got;
		expect(got.storyId).toBe(alice.storyId);
		expect(got.note).toMatchObject({ id: noteId, sceneId: alice.sceneId, resolved: false });
		expect(said(got.note!.comments)).toEqual([
			['you', PATTERN],
			['writer', 'Why this one?'],
			['you', 'Because it repeats.']
		]);
		expect(got.edits).toHaveLength(2);
		expect(got.edits[0]).toMatchObject({
			id: first.id,
			yours: true,
			status: 'accepted',
			original: 'open',
			replacement: 'ajar',
			paragraphNow: 'One ajar lantern.',
			threadId: null,
			replies: []
		});
		expect(got.edits[1]).toMatchObject({
			id: second.id,
			status: 'pending',
			original: 'dark',
			replacement: 'dim',
			paragraphNow: 'Two dark lantern.',
			threadId: discussion
		});
		expect(said(got.edits[1].replies)).toEqual([['writer', 'Could it be "dull"?']]);
		expect(got.workThroughLink).toBe(
			`${ORIGIN}/stories/${alice.storyId}/review?scene=${alice.sceneId}&pass=${noteId}`
		);

		// The app answers under the edit, with the thread id it was given.
		const answered = await call(alice, 'reply_in_thread', {
			universeId: alice.universeId,
			threadId: discussion,
			comment: 'It could; revising.'
		});
		expect(answered.text).toBe('Your reply was posted to the thread.');
		const again = JSON.parse((await get(alice, noteId)).text) as Got;
		expect(said(again.edits[1].replies)).toEqual([
			['writer', 'Could it be "dull"?'],
			['you', 'It could; revising.']
		]);
	});

	it('reads a single edit by its id', async () => {
		const editId = idIn((await edit(alice)).text);
		await writerSays(alice, await discussionOf(alice, editId), 'Shut is too hard a word.');
		const got = JSON.parse((await get(alice, editId)).text) as Got;
		expect(got.note).toBeUndefined();
		expect(got.workThroughLink).toBeUndefined();
		expect(got.edits).toHaveLength(1);
		expect(got.edits[0]).toMatchObject({
			id: editId,
			status: 'pending',
			paragraphNow: 'Alice open lantern prose.'
		});
		expect(said(got.edits[0].replies)).toEqual([['writer', 'Shut is too hard a word.']]);
	});

	it('finds no note that is not its own', async () => {
		await expectNoUniverse('get_review_note', { noteId: MISSING });
		const second = await connect(alice.userId, 'Second');
		const [client] = await db
			.select()
			.from(oauthClients)
			.where(eq(oauthClients.clientName, APP_NAME));
		const mutedStoryId = await storyOf(alice.mutedSceneId);
		// Its own note, in a story the writer muted.
		const muted = await createThread(db, {
			storyId: mutedStoryId,
			sceneId: alice.mutedSceneId,
			anchor: null,
			author: { client: { id: client.id, name: client.clientName, host: client.host } },
			body: 'Left before the story was muted.'
		});
		const threadBy = async (author: { assistant: true } | { userId: string }) => {
			const created = await createThread(db, {
				storyId: alice.storyId,
				sceneId: alice.sceneId,
				anchor: null,
				author,
				body: 'Not from this app.'
			});
			if (!created.ok) throw new Error(created.reason);
			return created.threadId;
		};
		const assistantsEdit = await createSuggestion(db, {
			storyId: alice.storyId,
			sceneId: alice.sceneId,
			author: { assistant: true },
			range: { start: 11, end: 18 },
			replacement: 'lamp'
		});
		const bobsNote = idIn((await comment(bob)).text);
		const notTheirs = [
			bobsNote,
			idIn((await edit(bob)).text),
			idIn((await comment({ ...alice, token: second }, { comment: 'Second app.' })).text),
			idIn((await edit({ ...alice, token: second })).text),
			await threadBy({ assistant: true }),
			await threadBy({ userId: alice.userId }),
			assistantsEdit.ok && assistantsEdit.suggestionId,
			muted.ok && muted.threadId,
			MISSING,
			'nope'
		];
		const own = idIn((await comment(alice)).text);
		const before = await stagedRows();
		for (const noteId of notTheirs) {
			expect(noteId).toBeTruthy();
			expect(await get(alice, noteId)).toEqual({ text: NO_NOTE, isError: false });
		}
		// Its own note through the writer's other universe, and Bob's through Bob's.
		expect(await get(alice, own, alice.otherUniverseId)).toEqual({ text: NO_NOTE, isError: false });
		expect(await get(alice, bobsNote, bob.universeId)).toEqual({
			text: NO_UNIVERSE_RESULT,
			isError: true
		});
		// Its own note is there until the scene goes in the trash.
		expect((await get(alice, own)).text).toContain(own);
		await db.update(scenes).set({ deletedAt: new Date() }).where(eq(scenes.id, alice.sceneId));
		expect(await get(alice, own)).toEqual({ text: NO_NOTE, isError: false });
		expect(await stagedRows()).toBe(before);
	});

	it('gives the Assistant its own notes in the app, and not an apps', async () => {
		const appsNote = idIn((await comment(alice)).text);
		const created = await createThread(db, {
			storyId: alice.storyId,
			sceneId: alice.sceneId,
			anchor: null,
			author: { assistant: true },
			body: 'From the Assistant.'
		});
		const assistantsNote = created.ok ? created.threadId : '';
		await writerSays(alice, assistantsNote, 'Say more.');
		const inApp = async (name: string, args: Record<string, unknown>) =>
			(
				await dispatchToolCall(
					{ db, userId: alice.userId, universeId: alice.universeId },
					{ id: 'call', name, arguments: JSON.stringify(args) }
				)
			).result;
		expect(toolSpecs().map((tool) => tool.name)).toEqual(
			expect.arrayContaining(['list_review_notes', 'get_review_note'])
		);
		const result = JSON.parse(await inApp('list_review_notes', { storyId: alice.storyId })) as {
			notes: { id: string; writerRepliedLast: boolean }[];
		};
		expect(result.notes).toEqual([
			expect.objectContaining({ id: assistantsNote, writerRepliedLast: true })
		]);
		expect(await inApp('get_review_note', { noteId: appsNote })).toBe(NO_NOTE);
		const got = JSON.parse(await inApp('get_review_note', { noteId: assistantsNote })) as Got;
		expect(said(got.note!.comments)).toEqual([
			['you', 'From the Assistant.'],
			['writer', 'Say more.']
		]);
		expect(await inApp('list_review_notes', { storyId: bob.storyId })).toBe(NO_STORY);
	});
});

describe('suggest_entity', () => {
	const suggest = (who: World | string, overrides: Record<string, unknown> = {}) =>
		call(who, 'suggest_entity', {
			universeId: alice.universeId,
			kind: 'character',
			name: 'Old Marit',
			description: 'The lamplighter on the quay.',
			seenIn: 'Alice Quay: "Old Marit lit the lantern."',
			...overrides
		});

	it('stages an entry for the writer to accept, and creates nothing', async () => {
		const result = await suggest(alice);
		expect(result.isError).toBe(false);
		expect(result.text).toContain('Suggested the character "Old Marit"');
		expect(result.text).toContain(`${ORIGIN}/universes/${alice.universeId}/suggestions`);
		const waiting = await listProposals(db, alice.userId, alice.universeId);
		expect(waiting.entities).toEqual([
			expect.objectContaining({
				kind: 'character',
				name: 'Old Marit',
				description: 'The lamplighter on the quay.',
				seenIn: 'Alice Quay: "Old Marit lit the lantern."',
				from: APP
			})
		]);
		expect(await db.select().from(characters).where(eq(characters.name, 'Old Marit'))).toEqual([]);
		// Nothing of it shows in another writer's universe, or another of her own.
		expect((await listProposals(db, bob.userId, bob.universeId)).entities).toEqual([]);
		expect((await listProposals(db, alice.userId, alice.otherUniverseId)).entities).toEqual([]);
		expect((await listProposals(db, bob.userId, alice.universeId)).entities).toEqual([]);
	});

	it('stages nothing outside the writers own universes', async () => {
		await expectNoUniverse('suggest_entity', { kind: 'character', name: 'Old Marit' });
		expect(await stagedRows()).toBe(0);
	});

	it('refuses a name or another name the universe already has', async () => {
		await db
			.update(characters)
			.set({ aliases: ['The Quiet One'] })
			.where(eq(characters.id, alice.characterId));
		await db
			.insert(places)
			.values({ universeId: alice.universeId, ownerId: alice.userId, name: 'Saltmere' });
		for (const name of ['alices hero bram', 'the quiet one', '  Saltmere ']) {
			const refused = await suggest(alice, { name });
			expect(refused.text).toContain('already has an entry named');
		}
		// A name only another universe has is free here.
		expect((await suggest(alice, { name: 'Alices outsider' })).text).toContain('Suggested');
		for (const bad of [{ kind: 'weapon' }, { name: '   ' }, { name: 'x'.repeat(121) }]) {
			expect((await suggest(alice, bad)).text).not.toContain('Suggested');
		}
		expect((await listProposals(db, alice.userId, alice.universeId)).entities).toHaveLength(1);
	});

	it('does not stage a name twice, or again once the writer dismissed it', async () => {
		expect((await suggest(alice)).text).toContain('Suggested');
		expect((await suggest(alice, { name: 'old marit' })).text).toContain('already suggested');
		const second = await connect(alice.userId, 'Second');
		expect((await suggest(second, { kind: 'place' })).text).toContain('already suggested');
		const [waiting] = (await listProposals(db, alice.userId, alice.universeId)).entities;
		expect(
			await decideEntityProposal(db, alice.userId, alice.universeId, waiting.id, 'dismiss')
		).toMatchObject({
			ok: true,
			entityId: null
		});
		expect((await suggest(alice)).text).toContain('turned down "Old Marit" before');
		expect((await listProposals(db, alice.userId, alice.universeId)).entities).toEqual([]);
	});

	it('stages a name once when it is suggested several times at once', async () => {
		const args = { universeId: alice.universeId, kind: 'place', name: 'The Saltmarsh' };
		const answers = await Promise.all(
			Array.from({ length: 6 }, () => call(alice, 'suggest_entity', args))
		);
		expect(answers.filter((entry) => entry.text.startsWith('Suggested the place'))).toHaveLength(1);
		expect(answers.every((entry) => !entry.isError)).toBe(true);
		expect((await listProposals(db, alice.userId, alice.universeId)).entities).toHaveLength(1);

		// The same holds past the endpoint, for the Assistant and an app together.
		const app = await appOf(alice);
		const staged = await Promise.all(
			Array.from({ length: 6 }, (_, n) =>
				stageEntityProposal(db, {
					ownerId: alice.userId,
					universeId: alice.universeId,
					kind: 'character',
					name: n % 2 ? 'Old Marit' : 'old marit',
					author: n % 3 ? app : { assistant: true }
				})
			)
		);
		expect(staged.filter((entry) => entry.ok)).toHaveLength(1);
		for (const entry of staged) {
			if (!entry.ok) expect(entry.reason).toContain('already suggested and waiting');
		}
	});

	it('creates the entry only when the writer accepts, and only for its owner', async () => {
		await suggest(alice);
		await suggest(alice, { kind: 'place', name: 'Saltmere', description: '' });
		const { entities } = await listProposals(db, alice.userId, alice.universeId);
		const [marit, saltmere] = entities;
		// Another writer cannot decide it, by either answer.
		for (const decision of ['accept', 'dismiss'] as const) {
			expect(
				(await decideEntityProposal(db, bob.userId, alice.universeId, marit.id, decision)).ok
			).toBe(false);
		}
		expect(
			(await decideEntityProposal(db, alice.userId, alice.universeId, MISSING, 'accept')).ok
		).toBe(false);
		expect(await db.select().from(characters).where(eq(characters.name, 'Old Marit'))).toEqual([]);

		const accepted = await decideEntityProposal(
			db,
			alice.userId,
			alice.universeId,
			marit.id,
			'accept'
		);
		expect(accepted).toMatchObject({ ok: true, entityId: expect.any(String) });
		const [created] = await db.select().from(characters).where(eq(characters.name, 'Old Marit'));
		expect(created).toMatchObject({
			id: accepted.ok ? accepted.entityId : '',
			ownerId: alice.userId,
			universeId: alice.universeId,
			summaryMd: 'The lamplighter on the quay.'
		});
		// Decided once.
		expect(
			(await decideEntityProposal(db, alice.userId, alice.universeId, marit.id, 'accept')).ok
		).toBe(false);
		expect(await db.select().from(characters).where(eq(characters.name, 'Old Marit'))).toHaveLength(
			1
		);

		// A name the writer took in the meantime is not created twice.
		await db
			.insert(places)
			.values({ universeId: alice.universeId, ownerId: alice.userId, name: 'Saltmere' });
		const late = await decideEntityProposal(
			db,
			alice.userId,
			alice.universeId,
			saltmere.id,
			'accept'
		);
		expect(late).toMatchObject({ ok: false, code: 'conflict' });
		expect(await db.select().from(places).where(eq(places.name, 'Saltmere'))).toHaveLength(1);
	});

	it('files an accepted lore entry under the first category', async () => {
		await suggest(alice, { kind: 'lore', name: 'The Tide Oath' });
		const [waiting] = (await listProposals(db, alice.userId, alice.universeId)).entities;
		const early = await decideEntityProposal(
			db,
			alice.userId,
			alice.universeId,
			waiting.id,
			'accept'
		);
		expect(early).toMatchObject({ ok: false, code: 'invalid' });
		const [category] = await db
			.insert(entityCategories)
			.values({
				universeId: alice.universeId,
				ownerId: alice.userId,
				name: 'Customs',
				sortOrder: 0
			})
			.returning({ id: entityCategories.id });
		expect(
			(await decideEntityProposal(db, alice.userId, alice.universeId, waiting.id, 'accept')).ok
		).toBe(true);
		const [entry] = await db.select().from(loreEntries);
		expect(entry).toMatchObject({ title: 'The Tide Oath', categoryId: category.id });
	});

	it('decides nothing through another universe, even one of the writers own', async () => {
		await suggest(alice);
		const [waiting] = (await listProposals(db, alice.userId, alice.universeId)).entities;
		for (const universeId of [alice.otherUniverseId, bob.universeId, MISSING]) {
			for (const decision of ['accept', 'dismiss'] as const) {
				expect(
					(await decideEntityProposal(db, alice.userId, universeId, waiting.id, decision)).ok
				).toBe(false);
			}
		}
		// Still waiting, and nothing was added anywhere.
		expect((await listProposals(db, alice.userId, alice.universeId)).entities).toHaveLength(1);
		expect(await db.select().from(characters)).toHaveLength(4);
	});

	it('is the Assistants tool too, staged in its name', async () => {
		const outcome = await dispatchToolCall(
			{ db, userId: alice.userId, universeId: alice.universeId },
			{
				id: 'call',
				name: 'suggest_entity',
				arguments: JSON.stringify({ kind: 'place', name: 'Saltmere' })
			}
		);
		expect(outcome.staged).toBe(true);
		expect(outcome.result).toContain('under Suggestions');
		expect(toolSpecs().map((tool) => tool.name)).toContain('suggest_entity');
		const [waiting] = (await listProposals(db, alice.userId, alice.universeId)).entities;
		expect(waiting).toMatchObject({ name: 'Saltmere', from: 'Assistant' });
	});

	it('stops at a ceiling of waiting entries, and counts against the staging budget', async () => {
		const [client] = await db.select().from(oauthClients);
		const author = { client: { id: client.id, name: client.clientName, host: client.host } };
		for (let i = 0; i < MAX_ENTITY_PROPOSALS_WAITING; i++) {
			const staged = await stageEntityProposal(db, {
				ownerId: alice.userId,
				universeId: alice.universeId,
				kind: 'character',
				name: `Sailor ${i}`,
				author
			});
			expect(staged.ok).toBe(true);
		}
		expect((await suggest(alice)).text).toContain('suggested entries waiting');
		// Bob's universe is his own count; the budget is one for all staging.
		let staged = 0;
		for (let i = 0; i < 31; i++) {
			const result = await suggest(bob, { universeId: bob.universeId, name: `Rower ${i}` });
			if (!result.isError) staged++;
		}
		expect(staged).toBe(30);
		expect((await suggest(bob, { universeId: bob.universeId })).text).toMatch(/^Too many calls/);
	});
});

describe('propose_scene_split', () => {
	const BODY = 'They rowed out past the bar and slept.\n\nDawn came swiftly over the water.';
	const propose = (who: World | string, overrides: Record<string, unknown> = {}) =>
		call(who, 'propose_scene_split', {
			universeId: alice.universeId,
			sceneId: alice.sceneId,
			newSceneStart: 'Dawn came swiftly',
			rationale: 'A night passes.',
			...overrides
		});
	const sceneCount = async (storyId: string) =>
		(await db.select().from(scenes).where(eq(scenes.storyId, storyId))).length;

	beforeEach(async () => {
		await setBody(alice, BODY);
	});

	it('stores the proposal for the writer and leaves the scene whole', async () => {
		const result = await propose(alice);
		expect(result.isError).toBe(false);
		expect(result.text).toContain('Nothing has changed');
		expect(result.text).toContain(`${ORIGIN}/universes/${alice.universeId}/suggestions`);
		const { splits } = await listProposals(db, alice.userId, alice.universeId);
		expect(splits).toEqual([
			expect.objectContaining({
				storyId: alice.storyId,
				sceneId: alice.sceneId,
				sceneTitle: 'Alice Quay',
				before: 'Dawn came swiftly',
				rationale: 'A night passes.',
				from: APP
			})
		]);
		const [scene] = await db.select().from(scenes).where(eq(scenes.id, alice.sceneId));
		expect(scene.bodyMd).toBe(BODY);
		expect((await listProposals(db, bob.userId, bob.universeId)).splits).toEqual([]);
		expect((await listProposals(db, bob.userId, alice.universeId)).splits).toEqual([]);
	});

	it('stages nothing outside the writers own open stories', async () => {
		await expectNoUniverse('propose_scene_split', {
			sceneId: alice.sceneId,
			newSceneStart: 'Dawn came swiftly',
			rationale: 'x'
		});
		for (const sceneId of hiddenScenes()) {
			expect(await propose(alice, { sceneId, newSceneStart: 'lantern' })).toEqual({
				text: NO_SCENE,
				isError: false
			});
		}
		expect(await stagedRows()).toBe(0);
	});

	it('refuses a point it cannot place, a repeat, and more than a few', async () => {
		expect((await propose(alice, { newSceneStart: 'No such words' })).text).toContain('not found');
		expect((await propose(alice, { newSceneStart: 'They rowed' })).text).toContain(
			'already starts there'
		);
		expect(await stagedRows()).toBe(0);
		expect((await propose(alice)).text).toContain('proposed to the writer');
		expect((await propose(alice)).text).toContain('already proposed this split');
		for (const start of ['came swiftly', 'swiftly over', 'over the', 'the water']) {
			expect((await propose(alice, { newSceneStart: start })).text).toContain('proposed to');
		}
		expect((await propose(alice, { newSceneStart: 'water.' })).text).toContain(
			'split proposals waiting'
		);
	});

	it('stores a split once when it is proposed several times at once, and holds the ceiling', async () => {
		const same = await Promise.all(Array.from({ length: 6 }, () => propose(alice)));
		expect(same.filter((entry) => entry.text.includes('The split is proposed'))).toHaveLength(1);
		expect((await listProposals(db, alice.userId, alice.universeId)).splits).toHaveLength(1);

		const starts = ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight'];
		await setBody(alice, `Opening.\n\n${starts.map((word) => `${word} began here.`).join('\n\n')}`);
		await pool.query('delete from scene_split_proposals');
		const many = await Promise.all(
			starts.map((word) => propose(alice, { newSceneStart: `${word} began` }))
		);
		expect(many.filter((entry) => entry.text.includes('The split is proposed'))).toHaveLength(
			MAX_SPLIT_PROPOSALS_WAITING
		);
		expect((await listProposals(db, alice.userId, alice.universeId)).splits).toHaveLength(
			MAX_SPLIT_PROPOSALS_WAITING
		);
	});

	it('splits only when the writer confirms, and only for its owner', async () => {
		await propose(alice);
		const [waiting] = (await listProposals(db, alice.userId, alice.universeId)).splits;
		const before = await sceneCount(alice.storyId);
		for (const decision of ['confirm', 'dismiss'] as const) {
			expect(
				(await decideSplitProposal(db, bob.userId, alice.universeId, waiting.id, decision)).ok
			).toBe(false);
		}
		expect(await sceneCount(alice.storyId)).toBe(before);

		const confirmed = await decideSplitProposal(
			db,
			alice.userId,
			alice.universeId,
			waiting.id,
			'confirm'
		);
		expect(confirmed).toMatchObject({ ok: true, splitSceneId: alice.sceneId });
		expect(await sceneCount(alice.storyId)).toBe(before + 1);
		const [first] = await db.select().from(scenes).where(eq(scenes.id, alice.sceneId));
		expect(first.bodyMd.trim()).toBe('They rowed out past the bar and slept.');
		const newSceneId = confirmed.ok ? (confirmed.newSceneId ?? '') : '';
		const [second] = await db.select().from(scenes).where(eq(scenes.id, newSceneId));
		expect(second.bodyMd.trim()).toBe('Dawn came swiftly over the water.');
		// Decided once.
		expect(
			(await decideSplitProposal(db, alice.userId, alice.universeId, waiting.id, 'confirm')).ok
		).toBe(false);
		expect(await sceneCount(alice.storyId)).toBe(before + 1);
	});

	it('keeps a proposal waiting when the words are gone, and lets the writer dismiss it', async () => {
		await propose(alice);
		const [waiting] = (await listProposals(db, alice.userId, alice.universeId)).splits;
		await setBody(alice, 'They rowed out past the bar and slept.');
		const before = await sceneCount(alice.storyId);
		// Said to the writer, not in the words the app was given when it proposed.
		const STALE =
			'The scene has changed since this was proposed, so it cannot be split here. Dismiss the proposal.';
		expect(
			await decideSplitProposal(db, alice.userId, alice.universeId, waiting.id, 'confirm')
		).toMatchObject({ ok: false, reason: STALE });
		// The words are there twice, or open the scene: the same sentence.
		for (const body of [
			`${BODY}\n\nDawn came swiftly again.`,
			'Dawn came swiftly over the water.'
		]) {
			await setBody(alice, body);
			expect(
				await decideSplitProposal(db, alice.userId, alice.universeId, waiting.id, 'confirm')
			).toMatchObject({ ok: false, reason: STALE });
		}
		// The words moved to another scene of the story: that scene is not the
		// one the writer was shown, so it is not split in its place.
		await setBody(alice, 'They rowed out past the bar and slept.');
		const [moved] = await db
			.insert(scenes)
			.values({ storyId: alice.storyId, globalPosition: 5, title: 'Later', bodyMd: BODY })
			.returning({ id: scenes.id });
		expect(
			await decideSplitProposal(db, alice.userId, alice.universeId, waiting.id, 'confirm')
		).toMatchObject({ ok: false, reason: STALE });
		expect((await db.select().from(scenes).where(eq(scenes.id, moved.id)))[0].bodyMd).toBe(BODY);
		await db.delete(scenes).where(eq(scenes.id, moved.id));
		expect(await sceneCount(alice.storyId)).toBe(before);
		expect((await listProposals(db, alice.userId, alice.universeId)).splits).toHaveLength(1);
		expect(
			(await decideSplitProposal(db, alice.userId, alice.universeId, waiting.id, 'dismiss')).ok
		).toBe(true);
		expect((await listProposals(db, alice.userId, alice.universeId)).splits).toEqual([]);
	});

	it('decides nothing through another universe, even one of the writers own', async () => {
		await propose(alice);
		const [waiting] = (await listProposals(db, alice.userId, alice.universeId)).splits;
		const before = await sceneCount(alice.storyId);
		for (const universeId of [alice.otherUniverseId, bob.universeId, MISSING]) {
			for (const decision of ['confirm', 'dismiss'] as const) {
				expect(
					(await decideSplitProposal(db, alice.userId, universeId, waiting.id, decision)).ok
				).toBe(false);
			}
		}
		expect(await sceneCount(alice.storyId)).toBe(before);
		expect((await listProposals(db, alice.userId, alice.universeId)).splits).toHaveLength(1);
	});

	it('stays a card in the chat for the Assistant, with nothing stored', async () => {
		const outcome = await dispatchToolCall(
			{ db, userId: alice.userId, universeId: alice.universeId },
			{
				id: 'call',
				name: 'propose_scene_split',
				arguments: JSON.stringify({
					sceneId: alice.sceneId,
					newSceneStart: 'Dawn came swiftly',
					rationale: 'A night passes.'
				})
			}
		);
		expect(outcome.result).not.toContain('/suggestions');
		expect(await stagedRows()).toBe(0);
	});
});

describe('stage_scene_draft', () => {
	const DRAFT = 'The tide went out. *Nobody* watched it go.';
	const stage = (who: World | string, overrides: Record<string, unknown> = {}) =>
		call(who, 'stage_scene_draft', {
			universeId: alice.universeId,
			sceneId: alice.sceneId,
			text: DRAFT,
			brief: 'The morning after.',
			...overrides
		});
	const draftsOf = (userId: string) =>
		db.select().from(assistantDrafts).where(eq(assistantDrafts.userId, userId));

	it('leaves a draft on the scene in the apps name, and the scene text alone', async () => {
		const result = await stage(alice);
		expect(result.isError).toBe(false);
		expect(result.text).toContain('Staged the draft');
		expect(result.text).toContain(
			`${ORIGIN}/stories/${alice.storyId}?scene=${alice.sceneId}&draft=show`
		);
		expect(await draftsOf(alice.userId)).toEqual([
			expect.objectContaining({
				storyId: alice.storyId,
				sceneId: alice.sceneId,
				textMd: DRAFT,
				brief: 'The morning after.',
				status: 'ready',
				note: `Drafted by ${APP}.`
			})
		]);
		const [scene] = await db.select().from(scenes).where(eq(scenes.id, alice.sceneId));
		expect(scene.bodyMd).toBe('Alice open lantern prose.');
		expect(await draftsOf(bob.userId)).toEqual([]);
		// The writer sees it where a draft of the Assistant's shows.
		const shown = await sceneDraftFor(db, alice.userId, alice.sceneId);
		expect(shown).toMatchObject({ status: 'ready', textMd: DRAFT });
	});

	it('stages nothing outside the writers own open stories', async () => {
		await expectNoUniverse('stage_scene_draft', { sceneId: alice.sceneId, text: DRAFT });
		for (const sceneId of hiddenScenes()) {
			expect(await stage(alice, { sceneId })).toEqual({ text: NO_SCENE, isError: false });
		}
		expect(await stagedRows()).toBe(0);
	});

	it('takes one undecided draft a scene, whichever app wrote it', async () => {
		expect((await stage(alice)).text).toContain('Staged the draft');
		expect((await stage(alice, { text: 'Another go.' })).text).toContain('already has a draft');
		const second = await connect(alice.userId, 'Second');
		expect((await stage(second, { text: 'A third.' })).text).toContain('already has a draft');
		expect(await draftsOf(alice.userId)).toHaveLength(1);
		// Once the writer has decided, the scene takes another.
		const [draft] = await draftsOf(alice.userId);
		expect((await discardSceneDraft(db, alice.userId, draft.id)).ok).toBe(true);
		expect((await stage(alice, { text: 'Another go.' })).text).toContain('Staged the draft');
	});

	it('stops at a ceiling of undecided app drafts in a universe', async () => {
		const sceneIds = (
			await db
				.insert(scenes)
				.values(
					Array.from({ length: MAX_APP_DRAFTS_WAITING + 1 }, (_, n) => ({
						storyId: alice.storyId,
						globalPosition: n + 10,
						title: `Scene ${n}`,
						bodyMd: ''
					}))
				)
				.returning({ id: scenes.id })
		).map((row) => row.id);
		const waiting = (sceneId: string, jobId: string | null = null) => ({
			userId: alice.userId,
			storyId: alice.storyId,
			sceneId,
			brief: 'x',
			targetWords: 100,
			textMd: 'Words.',
			status: 'ready' as const,
			jobId
		});
		// One short of the ceiling, and a draft the Assistant wrote, which does
		// not count.
		await db
			.insert(assistantDrafts)
			.values([
				...sceneIds.slice(0, MAX_APP_DRAFTS_WAITING - 1).map((sceneId) => waiting(sceneId)),
				waiting(sceneIds[MAX_APP_DRAFTS_WAITING - 1], 'a-job')
			]);
		expect((await stage(alice)).text).toContain('Staged the draft');
		const full = await stage(alice, { sceneId: sceneIds[MAX_APP_DRAFTS_WAITING] });
		expect(full).toMatchObject({ isError: false });
		expect(full.text).toContain(`${MAX_APP_DRAFTS_WAITING} drafts from apps waiting`);
		expect(await draftsOf(alice.userId)).toHaveLength(MAX_APP_DRAFTS_WAITING + 1);
		// Bob's universe is not held back by Alice's.
		expect((await stage(bob, { universeId: bob.universeId, sceneId: bob.sceneId })).text).toContain(
			'Staged the draft'
		);
		// Once the writer has decided on one, there is room again.
		const [draft] = await draftsOf(alice.userId);
		expect((await discardSceneDraft(db, alice.userId, draft.id)).ok).toBe(true);
		expect((await stage(alice, { sceneId: sceneIds[MAX_APP_DRAFTS_WAITING] })).text).toContain(
			'Staged the draft'
		);
	});

	it('takes one draft when two apps stage at the same moment', async () => {
		const second = await connect(alice.userId, 'Second');
		for (let round = 0; round < 5; round++) {
			await pool.query('delete from assistant_drafts');
			const answers = await Promise.all([stage(alice), stage(second, { text: 'The other one.' })]);
			expect(answers.every((entry) => !entry.isError)).toBe(true);
			expect(answers.filter((entry) => entry.text.includes('Staged the draft'))).toHaveLength(1);
			expect(answers.filter((entry) => entry.text.includes('already has a draft'))).toHaveLength(1);
			expect(await draftsOf(alice.userId)).toHaveLength(1);
		}
	});

	it('leaves a failed draft of the writers own in place', async () => {
		const [failed] = await db
			.insert(assistantDrafts)
			.values({
				userId: alice.userId,
				storyId: alice.storyId,
				sceneId: alice.sceneId,
				brief: 'Asked of the Assistant.',
				targetWords: 500,
				status: 'failed'
			})
			.returning({ id: assistantDrafts.id });
		expect((await stage(alice)).text).toContain('Staged the draft');
		const rows = await draftsOf(alice.userId);
		expect(rows.find((row) => row.id === failed.id)).toMatchObject({ status: 'failed' });
		expect(rows).toHaveLength(2);
	});

	it('refuses an empty draft and one that is too long', async () => {
		expect((await stage(alice, { text: '   ' })).text).toContain('Give the text');
		expect((await stage(alice, { text: 'x'.repeat(60_001) })).text).toContain('too long');
		expect(await stagedRows()).toBe(0);
	});

	it('is not a tool of the Assistant', async () => {
		const outcome = await dispatchToolCall(
			{ db, userId: alice.userId, universeId: alice.universeId },
			{
				id: 'call',
				name: 'stage_scene_draft',
				arguments: JSON.stringify({ sceneId: alice.sceneId, text: DRAFT })
			}
		);
		expect(outcome.result).toBe('Unknown tool: stage_scene_draft.');
		expect(await stagedRows()).toBe(0);
	});
});

// ============ A personal access token ============

// The same rule with the other kind of credential: a token the writer made on
// the Account page reaches that writer's data and nothing else, tool by tool.
describe('with a personal access token', () => {
	const TOKEN_NAME = 'Night Script';
	type Ids = {
		storyId: string;
		sceneId: string;
		entityId: string;
		threadId: string;
		suggestionId: string;
		noteId: string;
	};
	const NOTHING: Ids = {
		storyId: MISSING,
		sceneId: MISSING,
		entityId: MISSING,
		threadId: MISSING,
		suggestionId: MISSING,
		noteId: MISSING
	};
	// Every tool but list_universes, with arguments that name the given things.
	// `names` says which ids the tool takes; none means it works on the
	// universe alone.
	const TOOLS_BY_NAME: Record<
		string,
		{ names: (keyof Ids)[]; args: (ids: Ids) => Record<string, unknown>; stagesOwn?: boolean }
	> = {
		list_stories: { names: [], args: () => ({}) },
		list_scenes: { names: [], args: () => ({}) },
		search_text: { names: [], args: () => ({ query: 'lantern' }) },
		get_scene: { names: ['sceneId'], args: ({ sceneId }) => ({ sceneId }) },
		get_entity: { names: ['entityId'], args: ({ entityId }) => ({ entityId }) },
		find_appearances: { names: ['entityId'], args: ({ entityId }) => ({ entityId }) },
		list_review_notes: { names: ['storyId'], args: ({ storyId }) => ({ storyId }) },
		get_review_note: { names: ['noteId'], args: ({ noteId }) => ({ noteId }) },
		suggest_edit: {
			names: ['sceneId'],
			args: ({ sceneId }) => ({ sceneId, original: 'open', replacement: 'shut' })
		},
		leave_comment: { names: ['sceneId'], args: ({ sceneId }) => ({ sceneId, comment: 'x' }) },
		leave_pattern_note: {
			names: ['sceneId'],
			args: ({ sceneId }) => ({
				sceneId,
				comment: PATTERN,
				edits: [{ original: 'open', replacement: 'shut' }]
			})
		},
		propose_scene_split: {
			names: ['sceneId'],
			args: ({ sceneId }) => ({ sceneId, newSceneStart: 'lantern', rationale: 'x' })
		},
		stage_scene_draft: {
			names: ['sceneId'],
			args: ({ sceneId }) => ({ sceneId, text: 'A draft.' })
		},
		reply_in_thread: {
			names: ['threadId'],
			args: ({ threadId }) => ({ threadId, comment: 'x' })
		},
		update_suggestion: {
			names: ['suggestionId'],
			args: ({ suggestionId }) => ({ suggestionId, replacement: 'x' })
		},
		// Takes no id: it can only ever stage in the universe of the call.
		suggest_entity: {
			names: [],
			args: () => ({ kind: 'character', name: 'Old Marit' }),
			stagesOwn: true
		}
	};

	let pat: string;
	let bobs: Ids;

	async function personalToken(
		userId: string,
		permissions: string[] = ['suggest'],
		name = TOKEN_NAME
	): Promise<string> {
		const made = await createPersonalToken(db, { userId, name, permissions, expiresInDays: 90 });
		if (!made.ok) throw new Error(made.reason);
		return made.token;
	}

	beforeEach(async () => {
		pat = await personalToken(alice.userId);
		// Things of Bob's that a call could name: a thread, a suggestion and a
		// pattern note his own app left on his scene.
		bobs = {
			storyId: bob.storyId,
			sceneId: bob.sceneId,
			entityId: bob.characterId,
			threadId: idIn((await comment(bob)).text),
			suggestionId: idIn((await edit(bob, { original: 'lantern', replacement: 'lamp' })).text),
			noteId: await patternNote(bob)
		};
	});

	it('is offered the same tools as an app with the same permissions', async () => {
		const names = async (token: string) =>
			((await rpc(token, 'tools/list')).result!.tools as { name: string }[])
				.map((tool) => tool.name)
				.sort();
		expect(await names(pat)).toEqual(await names(alice.token));
		expect(await names(pat)).toEqual([...Object.keys(TOOLS_BY_NAME), 'list_universes'].sort());
		const readOnly = await personalToken(alice.userId, [], 'Reader');
		expect(await names(readOnly)).toEqual(
			await names(await connect(alice.userId, 'Reader', ['read']))
		);
		expect((await call(readOnly, 'suggest_edit', editArgs())).isError).toBe(true);
	});
	const editArgs = () => ({
		universeId: alice.universeId,
		sceneId: alice.sceneId,
		original: 'open',
		replacement: 'shut'
	});

	it('lists only the universes of the writer who made it', async () => {
		const { text, isError } = await call(pat, 'list_universes');
		expect(isError).toBe(false);
		const listed = JSON.parse(text).universes as { id: string }[];
		expect(listed.map((row) => row.id).sort()).toEqual(
			[alice.universeId, alice.otherUniverseId].sort()
		);
		expect(text).not.toContain('Bob');
	});

	it.each(Object.keys(TOOLS_BY_NAME))(
		'%s reaches nothing of another writer, and nothing muted or trashed',
		async (name) => {
			const tool = TOOLS_BY_NAME[name];
			const before = await stagedRows();
			const bobsScene = async () =>
				(await db.select().from(scenes).where(eq(scenes.id, bob.sceneId)))[0].bodyMd;
			const bobsText = await bobsScene();

			// Another writer's universe, a trashed one and a missing one: one answer.
			for (const universeId of [bob.universeId, alice.trashedUniverseId, MISSING]) {
				expect(await call(pat, name, { ...tool.args(bobs), universeId })).toEqual({
					text: NO_UNIVERSE_RESULT,
					isError: true
				});
			}
			expect(await stagedRows()).toBe(before);

			if (tool.names.length === 0) {
				// Nothing to name: in the writer's own universe it sees only her own.
				const own = await call(pat, name, { ...tool.args(bobs), universeId: alice.universeId });
				expect(own.isError).toBe(false);
				expect(own.text).not.toContain('Bob');
				expect(await stagedRows()).toBe(before + (tool.stagesOwn ? 1 : 0));
			} else {
				// Another writer's things named through her own universe answer
				// exactly as things that do not exist, and so do her own muted
				// and trashed scenes.
				const missing = await call(pat, name, {
					...tool.args(NOTHING),
					universeId: alice.universeId
				});
				expect(missing.text).toMatch(/^No /);
				const targets: Ids[] = [bobs];
				if (tool.names.includes('sceneId')) {
					for (const sceneId of [
						alice.mutedSceneId,
						alice.trashedStorySceneId,
						alice.trashedSceneId
					]) {
						targets.push({ ...NOTHING, sceneId });
					}
				}
				for (const ids of targets) {
					expect(
						await call(pat, name, { ...tool.args(ids), universeId: alice.universeId })
					).toEqual(missing);
				}
				expect(await stagedRows()).toBe(before);
			}
			expect(await bobsScene()).toBe(bobsText);
			expect((await listProposals(db, bob.userId, bob.universeId)).entities).toEqual([]);
		}
	);

	it('stages under the name the writer gave the token', async () => {
		const result = await call(pat, 'suggest_edit', editArgs());
		expect(result.text).toContain('Staged a suggested edit');
		const [staged] = await listSuggestions(db, alice.storyId);
		expect(staged).toMatchObject({
			reviewerName: `${TOKEN_NAME} (personal token)`,
			isApp: true,
			isAssistant: false,
			isOwner: false,
			status: 'pending'
		});
		const [scene] = await db.select().from(scenes).where(eq(scenes.id, alice.sceneId));
		expect(scene.bodyMd).toBe('Alice open lantern prose.');
		// Its notes are its own: the app's token cannot revise them.
		const revised = await call(alice, 'update_suggestion', {
			universeId: alice.universeId,
			suggestionId: staged.id,
			replacement: 'ajar'
		});
		expect(revised.text).toBe(NO_SUGGESTION);
	});

	it('stops working when it is revoked, and when every credential is', async () => {
		const list = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
		expect((await send(list, { token: pat })).status).toBe(200);
		const [token] = await listPersonalTokens(db, alice.userId);
		// Another writer cannot revoke it.
		expect(await revokeGrant(db, bob.userId, token.id)).toBe(false);
		expect((await send(list, { token: pat })).status).toBe(200);
		expect(await revokeGrant(db, alice.userId, token.id)).toBe(true);
		expect((await send(list, { token: pat })).status).toBe(401);

		const second = await personalToken(alice.userId, ['suggest'], 'Second');
		expect((await send(list, { token: second })).status).toBe(200);
		await revokeAllGrants(db, alice.userId);
		expect((await send(list, { token: second })).status).toBe(401);
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
						maxNotesPerScene: 2,
						origin: ORIGIN
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
				await call(who, 'list_review_notes', { universeId, storyId: other.storyId });
				await call(who, 'get_review_note', { universeId, noteId: other.sceneId });
			}
		}
		expect(await stagedRows()).toBe(0);
		const after = await pool.query(`select id, body_md, updated_at from scenes order by id`);
		expect(after.rows).toEqual(before.rows);
	});
});

describe('a call that fails', () => {
	it('tells the app nothing of the query, and logs nothing of it', async () => {
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
		const identity = (await resolveBearer(db, alice.token))!;
		const args = { universeId: alice.universeId, sceneId: alice.sceneId };
		const broken = brokenDb();
		for (const [name, more] of [
			['suggest_edit', { original: 'open', replacement: 'shut' }],
			['leave_comment', { comment: 'A note.' }],
			['get_scene', {}]
		] as const) {
			expect(await callMcpTool(broken, identity, name, { ...args, ...more }, ORIGIN)).toEqual({
				text: 'The tool failed. Try again.',
				isError: true
			});
		}
		// Past the universe check, in the tool itself.
		const ctx = { ...(await appContext(alice)), db: broken };
		for (const name of ['suggest_edit', 'get_scene']) {
			const outcome = await dispatchToolCall(ctx, {
				id: 'call',
				name,
				arguments: JSON.stringify({ sceneId: alice.sceneId, original: 'open', replacement: 'shut' })
			});
			expect(outcome).toMatchObject({ staged: false, failed: true });
			expect(outcome.result).not.toContain(SECRET);
			expect(outcome.result).not.toContain('select');
		}
		const lines = logged.mock.calls.map((entry) => String(entry[0])).join('\n');
		logged.mockRestore();
		expect(lines).toContain('mcp.tool_failed');
		expect(lines).toContain('XX000');
		expect(lines).not.toContain(SECRET);
		expect(await stagedRows()).toBe(0);
	});

	it('is a tool result in the app too, not a thrown error', async () => {
		const outcome = await dispatchToolCall(
			{ db: brokenDb(), userId: alice.userId, universeId: alice.universeId },
			{
				id: 'call',
				name: 'suggest_edit',
				arguments: JSON.stringify({ sceneId: alice.sceneId, original: 'open', replacement: 'shut' })
			}
		);
		expect(outcome).toMatchObject({ staged: false, failed: true });
		expect(outcome.result).not.toContain(SECRET);
	});

	it('refuses text with a null character before anything is asked of the database', async () => {
		const before = await stagedRows();
		for (const [name, more] of [
			['suggest_edit', { sceneId: alice.sceneId, original: 'open', replacement: 'sh\u0000ut' }],
			['leave_comment', { sceneId: alice.sceneId, comment: 'A\u0000note.' }],
			['suggest_entity', { kind: 'place', name: 'Salt\u0000marsh' }],
			[
				'leave_pattern_note',
				{
					sceneId: alice.sceneId,
					comment: PATTERN,
					edits: [{ original: 'open', replacement: 'sh\u0000ut' }]
				}
			],
			['search_text', { query: 'lan\u0000tern' }]
		] as const) {
			const result = await call(alice, name, { universeId: alice.universeId, ...more });
			expect(result.text).toBe('Text cannot contain the null character. Remove it and try again.');
		}
		expect(await stagedRows()).toBe(before);
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
