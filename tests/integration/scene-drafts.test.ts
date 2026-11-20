import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { isHttpError } from '@sveltejs/kit';
import type pg from 'pg';
import {
	assistantDrafts,
	chapters,
	revisions,
	scenes,
	stories,
	universes,
	users
} from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/auth';
import type { GatewayDeps } from '../../src/lib/server/llm/gateway';
import {
	WriterStopError,
	type HttpRequest,
	type Provider
} from '../../src/lib/server/llm/providers/types';
import { cacheWriteRate } from '../../src/lib/assistant-cost';
import { ensureTestDatabase } from './test-db';

// Scene drafts (#1168): the Assistant drafts one whole scene from the writer's
// brief, in a background job, into a staged row. These tests hold the promise
// the feature rests on: the job never touches a scene, and the writer's text
// is never replaced when a draft is kept.

process.env.APP_SECRET = process.env.APP_SECRET || 'scene-drafts-test-secret';

// The route handlers import the app's db; point it at the test database.
vi.mock('#lib/server/db', async () => {
	const { default: pgModule } = await import('pg');
	const { drizzle } = await import('drizzle-orm/node-postgres');
	const schemaModule = await import('../../src/lib/server/db/schema');
	const { TEST_DATABASE_URL } = await import('./test-db');
	const testPool = new pgModule.Pool({ connectionString: TEST_DATABASE_URL });
	return { db: drizzle(testPool, { schema: schemaModule }), pool: testPool };
});

// Queueing would start pg-boss. The queue hands back a job id; the job itself
// is run by hand through runSceneDraft.
const jobs = vi.hoisted(() => ({
	queueAssistantDraft: vi.fn<(job: { jobId: string }) => Promise<string | 'coalesced' | null>>(),
	assistantDraftJobState:
		vi.fn<(id: string) => Promise<'running' | 'stopped' | 'done' | 'failed' | 'missing'>>(),
	queueSceneMentions: vi.fn(async () => undefined),
	stopRunningAssistantJob: vi.fn(async () => true)
}));
vi.mock('#lib/server/jobs', () => jobs);

const { db, pool } = (await import('#lib/server/db')) as unknown as {
	db: Database;
	pool: pg.Pool;
};
const { resetRateLimits } = await import('#lib/server/rate-limit');
const { saveAccountLlmConfig, saveModelContext, saveModelPricing, saveStoryLlmOverride } =
	await import('../../src/lib/server/llm/config');
const { estimateSceneDraft, runSceneDraft, sceneDraftDefaults, failSceneDraft } =
	await import('../../src/lib/server/llm/scene-draft');
const {
	addDraftAsScene,
	discardSceneDraft,
	fillSceneFromDraft,
	requestSceneDraft,
	sceneDraftFor,
	DRAFT_DID_NOT_FINISH
} = await import('../../src/lib/server/scene-drafts');
const { saveSceneBody } = await import('../../src/lib/server/scene-save');
const { destroyScene, trashScene } = await import('../../src/lib/server/scene-lifecycle');
const { purgeStory } = await import('../../src/lib/server/story-delete');
const draftRoute = await import('../../src/routes/api/assistant/draft/+server');
const decideRoute = await import('../../src/routes/api/assistant/draft/[id=uuid]/+server');

// Every prompt the stub was sent and the reply to each; a reply that is an
// Error is thrown.
let prompts: string[] = [];
let maxTokensSent: (number | undefined)[] = [];
let reply: string | Error = 'The ferry rocked. *Not yet,* Ilse thought.';
let cutOff = false;
// Runs while the stub is "writing", before it answers.
let whileWriting: (() => Promise<void>) | null = null;
const stubProvider: Provider = {
	async *chatStream() {
		yield { type: 'done' };
	},
	async respond(req) {
		prompts.push(req.messages.map((m) => m.content).join('\n'));
		maxTokensSent.push(req.maxTokens);
		await whileWriting?.();
		if (reply instanceof Error) throw reply;
		return {
			content: reply,
			toolCalls: [],
			finishReason: cutOff ? ('length' as const) : undefined,
			usage: { promptTokens: 1000, completionTokens: 500 }
		};
	},
	async listModels() {
		return [];
	}
};
const noHttp: HttpRequest = async () => {
	throw new Error('the injected provider should not call the transport');
};
const deps: GatewayDeps = { provider: stubProvider, http: noHttp, sleep: async () => {} };

let ownerId: string;
let strangerId: string;
let universeId: string;
let storyId: string;
let chapterId: string;
// Three scenes in one chapter: written, empty (the one drafted), written.
let before: string;
let target: string;
let after: string;

const BEFORE_BODY = 'Ilse came down to the quay at dusk, the ledger under her coat.';
const AFTER_BODY = 'On the far bank the reeds were black with frost.';

async function configure(extra: { spendCapUsd?: number } = {}) {
	await saveAccountLlmConfig(db, ownerId, {
		enabled: true,
		assistantName: '',
		persona: 'balanced',
		endpoint: 'https://api.example.com/v1',
		apiKey: 'sk',
		models: { chat: 'chat-model', coauthor: 'write-model' },
		toolCallBudget: 8,
		...extra
	});
}

beforeAll(async () => {
	await ensureTestDatabase();
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	prompts = [];
	maxTokensSent = [];
	reply = 'The ferry rocked. *Not yet,* Ilse thought.';
	cutOff = false;
	whileWriting = null;
	vi.clearAllMocks();
	// The queue takes the id the draft's row already carries.
	jobs.queueAssistantDraft.mockImplementation(async (job) => job.jobId);
	jobs.assistantDraftJobState.mockResolvedValue('running');
	resetRateLimits();
	await pool.query('truncate table users cascade');
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
	const [chapter] = await db
		.insert(chapters)
		.values({ storyId, position: 1, title: 'One' })
		.returning({ id: chapters.id });
	chapterId = chapter.id;
	const make = async (position: number, title: string, bodyMd: string, summaryMd?: string) => {
		const [scene] = await db
			.insert(scenes)
			.values({
				storyId,
				chapterId,
				positionInChapter: position,
				globalPosition: position,
				title,
				bodyMd,
				summaryMd,
				status: bodyMd ? 'draft' : 'outline',
				wordCount: bodyMd ? bodyMd.split(/\s+/).length : 0
			})
			.returning({ id: scenes.id });
		return scene.id;
	};
	before = await make(1, 'The Quay', BEFORE_BODY);
	target = await make(2, 'The Crossing', '', 'Ilse crosses the river and hides the ledger.');
	after = await make(3, 'The Far Bank', AFTER_BODY, 'Ilse wakes in the reeds.');
	await configure();
});

afterAll(async () => {
	await pool.end();
});

const input = (
	extra: Partial<{ brief: string; targetWords: number; pov: string | null }> = {}
) => ({
	userId: ownerId,
	storyId,
	sceneId: target,
	brief: 'Ilse crosses the river and hides the ledger.',
	targetWords: 1000,
	pov: null,
	...extra
});

async function request(extra: Parameters<typeof input>[0] = {}) {
	const result = await requestSceneDraft(db, input(extra), {
		queue: jobs.queueAssistantDraft,
		jobState: jobs.assistantDraftJobState
	});
	if (!result.ok) throw new Error(result.reason);
	return result;
}

// A draft asked for and written, ready to decide.
async function readyDraft(text = 'The ferry rocked. *Not yet,* Ilse thought.') {
	reply = text;
	const { draftId, jobId } = await request();
	const result = await runSceneDraft(db, { userId: ownerId, draftId, jobId }, deps);
	expect(result.outcome).toBe('ready');
	return draftId;
}

const draftRow = async (id: string) =>
	(await db.select().from(assistantDrafts).where(eq(assistantDrafts.id, id)))[0];
const sceneRow = async (id: string) => (await db.select().from(scenes).where(eq(scenes.id, id)))[0];
const storyScenes = () =>
	db.select().from(scenes).where(eq(scenes.storyId, storyId)).orderBy(asc(scenes.globalPosition));
// Everything about the story's scenes that a draft must not disturb.
const scenesSnapshot = async () =>
	(await storyScenes()).map((s) => ({
		id: s.id,
		bodyMd: s.bodyMd,
		title: s.title,
		status: s.status,
		updatedAt: s.updatedAt.getTime(),
		globalPosition: s.globalPosition,
		positionInChapter: s.positionInChapter
	}));
const revisionCount = async () => (await db.select().from(revisions)).length;

type TestUser = { id: string };
function event(
	user: TestUser | null,
	options: { params?: Record<string, string>; body?: unknown; method?: string; path?: string } = {}
) {
	const url = new URL(`http://localhost${options.path ?? '/'}`);
	const init: RequestInit = { method: options.method ?? 'POST' };
	if (options.body !== undefined) {
		init.body = JSON.stringify(options.body);
		init.headers = { 'content-type': 'application/json' };
	}
	return {
		params: options.params ?? {},
		url,
		request: new Request(url, init),
		locals: { user, session: null }
	};
}
async function call(handler: unknown, ev: ReturnType<typeof event>) {
	try {
		const response = await (handler as (e: never) => Promise<Response>)(ev as never);
		return { status: response.status, body: (await response.json()) as Record<string, unknown> };
	} catch (err) {
		if (isHttpError(err)) return { status: err.status, body: { message: err.body.message } };
		throw err;
	}
}

describe('the brief form', () => {
	it("opens with the scene's summary and the story's usual length", async () => {
		const defaults = await sceneDraftDefaults(db, { userId: ownerId, storyId, sceneId: target });
		expect(defaults).toEqual({
			brief: 'Ilse crosses the river and hides the ledger.',
			// Two written scenes of 12 and 10 words: the median, held to the floor.
			targetWords: 300,
			sceneTitle: 'The Crossing'
		});
	});

	it('falls back to a default length in a story with nothing written', async () => {
		await db.update(scenes).set({ bodyMd: '', wordCount: 0 }).where(eq(scenes.storyId, storyId));
		const defaults = await sceneDraftDefaults(db, { userId: ownerId, storyId, sceneId: target });
		expect(defaults?.targetWords).toBe(800);
	});

	it('does not offer a summary the Assistant wrote before the scene last changed', async () => {
		await pool.query(
			`update scenes set summary_generated_at = updated_at - interval '1 hour' where id = $1`,
			[target]
		);
		const defaults = await sceneDraftDefaults(db, { userId: ownerId, storyId, sceneId: target });
		expect(defaults?.brief).toBe('');
	});

	it("is not there for another user's scene", async () => {
		expect(
			await sceneDraftDefaults(db, { userId: strangerId, storyId, sceneId: target })
		).toBeNull();
	});
});

describe('the estimate', () => {
	it('counts tokens in and out, with no price for a model that has none', async () => {
		const estimate = await estimateSceneDraft(db, input());
		expect(estimate).toMatchObject({
			model: 'write-model',
			estCompletionTokens: 1400,
			overCap: false
		});
		expect(estimate!.estTokens).toBeGreaterThan(100);
		expect(estimate!.estCostUsd).toBeUndefined();
		expect(prompts).toEqual([]);
	});

	it('prices the draft when the model has a price', async () => {
		await saveModelPricing(db, ownerId, { 'write-model': { prompt: 0.001, completion: 0.002 } });
		const estimate = await estimateSceneDraft(db, input());
		expect(estimate!.estCostUsd).toBeCloseTo(estimate!.estTokens * 0.001 + 1400 * 0.002, 6);
	});

	it('says where a shorter reply length would stop the draft', async () => {
		await saveAccountLlmConfig(db, ownerId, {
			enabled: true,
			assistantName: '',
			persona: 'balanced',
			endpoint: 'https://api.example.com/v1',
			apiKey: 'sk',
			models: { coauthor: 'write-model' },
			tuning: { coauthor: { maxTokens: 700 } }
		});
		const estimate = await estimateSceneDraft(db, input());
		expect(estimate).toMatchObject({ estCompletionTokens: 700, limitedToWords: 500 });
	});

	it('names the context window when that is what holds the draft short', async () => {
		await saveModelContext(db, ownerId, { 'write-model': 1600 });
		const estimate = await estimateSceneDraft(db, input());
		// Half of a 1600 token window.
		expect(estimate).toMatchObject({
			estCompletionTokens: 800,
			limitedToWords: 550,
			limitedBy: 'window'
		});
	});

	it('says whether the cap can be applied, and the warning limit', async () => {
		await configure({ spendCapUsd: 5 });
		expect(await estimateSceneDraft(db, input())).toMatchObject({
			capUsd: 5,
			capEnforceable: false,
			warnUsd: 2,
			overCap: false
		});
		await saveModelPricing(db, ownerId, { 'write-model': { prompt: 0, completion: 0.0001 } });
		expect(await estimateSceneDraft(db, input())).toMatchObject({ capEnforceable: true });
	});

	// What the stub was sent as the reply limit for a draft of this input.
	async function limitSent() {
		const { draftId } = await request();
		await runSceneDraft(db, { userId: ownerId, draftId }, deps);
		await discardSceneDraft(db, ownerId, draftId);
		return maxTokensSent.at(-1)!;
	}
	const account = (extra: Record<string, unknown>) =>
		saveAccountLlmConfig(db, ownerId, {
			enabled: true,
			assistantName: '',
			persona: 'balanced',
			endpoint: 'https://api.example.com/v1',
			apiKey: 'sk',
			models: { coauthor: 'write-model' },
			...extra
		});

	it('counts the scene itself when the model does not think, under the limit sent', async () => {
		const plain = await estimateSceneDraft(db, input());
		expect(plain!.estCompletionTokens).toBe(1400);
		expect(plain!.estCompletionUpTo).toBeUndefined();
		expect(await limitSent()).toBe(1800);
	});

	it('counts the reply at the limit actually sent on the Claude provider', async () => {
		// Claude models think on their own, and thinking is billed as reply
		// tokens: the request goes out with the thinking limit, not the scene's.
		await account({ provider: 'anthropic' });
		const claude = await estimateSceneDraft(db, input());
		expect(claude).toMatchObject({ estCompletionTokens: 16_384, estCompletionUpTo: true });
		expect(claude!.limitedToWords).toBeUndefined();
		const sent = await limitSent();
		expect(sent).toBe(16_384);
		expect(claude!.estCompletionTokens).toBeGreaterThanOrEqual(sent);
	});

	it('counts the reply at the limit actually sent with Thinking on elsewhere', async () => {
		// An OpenAI-compatible endpoint with Thinking switched on for Write.
		await account({ tuning: { coauthor: { thinking: true } } });
		const thinking = await estimateSceneDraft(db, input());
		expect(thinking).toMatchObject({ estCompletionUpTo: true });
		const sent = await limitSent();
		expect(sent).toBeGreaterThan(1800);
		expect(thinking!.estCompletionTokens).toBeGreaterThanOrEqual(sent);
	});

	it('uses the limit the writer set for Write when the model may think', async () => {
		await account({ provider: 'anthropic', tuning: { coauthor: { maxTokens: 3000 } } });
		const estimate = await estimateSceneDraft(db, input());
		expect(estimate).toMatchObject({ estCompletionTokens: 3000, estCompletionUpTo: true });
		expect(await limitSent()).toBe(3000);
	});

	it('refuses over the cap on the thinking figure, not the words alone', async () => {
		// The scene's words alone would be $1.40; the request can spend $16.38.
		await account({ provider: 'anthropic', spendCapUsd: 10 });
		await saveModelPricing(db, ownerId, { 'write-model': { prompt: 0, completion: 0.001 } });
		expect(await estimateSceneDraft(db, input())).toMatchObject({ overCap: true });
		const result = await requestSceneDraft(db, input(), { queue: jobs.queueAssistantDraft });
		expect(result).toMatchObject({ ok: false, code: 'conflict' });
		expect(!result.ok && result.reason).toMatch(/up to \$16\.38, over your spend cap of \$10\.00/);
		expect(jobs.queueAssistantDraft).not.toHaveBeenCalled();
	});

	it('prices the prompt at the cache write rate on the Claude provider', async () => {
		await account({ provider: 'anthropic' });
		await saveModelPricing(db, ownerId, { 'write-model': { prompt: 0.001, completion: 0 } });
		const estimate = await estimateSceneDraft(db, input());
		const rate = cacheWriteRate(undefined);
		expect(rate).toBeGreaterThan(1);
		expect(estimate!.estCostUsd).toBeCloseTo(estimate!.estTokens * rate * 0.001, 6);
	});

	it("is not there for another user's scene", async () => {
		expect(await estimateSceneDraft(db, { ...input(), userId: strangerId })).toBeNull();
	});
});

describe('asking for a draft', () => {
	it('stages a pending draft and queues its job', async () => {
		const { draftId, jobId } = await request({ pov: ' Ilse, close third ' });
		// The row carries its job's id from the start, and the job takes that id.
		expect(jobs.queueAssistantDraft).toHaveBeenCalledWith({
			jobId,
			userId: ownerId,
			storyId,
			sceneId: target,
			draftId
		});
		expect(await draftRow(draftId)).toMatchObject({
			userId: ownerId,
			storyId,
			sceneId: target,
			status: 'pending',
			brief: 'Ilse crosses the river and hides the ledger.',
			targetWords: 1000,
			pov: 'Ilse, close third',
			textMd: '',
			jobId
		});
	});

	it('refuses an estimate over the spend cap and stages nothing', async () => {
		await configure({ spendCapUsd: 1 });
		// 1400 expected tokens out at $0.01 is $14.
		await saveModelPricing(db, ownerId, { 'write-model': { prompt: 0, completion: 0.01 } });
		const estimate = await estimateSceneDraft(db, input());
		expect(estimate).toMatchObject({ overCap: true, capUsd: 1 });

		const result = await requestSceneDraft(db, input(), { queue: jobs.queueAssistantDraft });
		expect(result).toMatchObject({ ok: false, code: 'conflict' });
		expect(!result.ok && result.reason).toMatch(/over your spend cap of \$1\.00/);
		expect(jobs.queueAssistantDraft).not.toHaveBeenCalled();
		expect(await db.select().from(assistantDrafts)).toEqual([]);
	});

	it('runs a draft the cap allows', async () => {
		await configure({ spendCapUsd: 100 });
		await saveModelPricing(db, ownerId, { 'write-model': { prompt: 0, completion: 0.01 } });
		expect((await request()).draftId).toBeTruthy();
	});

	it('refuses a second draft for a scene that has one undecided', async () => {
		await request();
		const again = await requestSceneDraft(db, input(), {
			queue: jobs.queueAssistantDraft,
			jobState: jobs.assistantDraftJobState
		});
		expect(again).toMatchObject({ ok: false, code: 'conflict' });
		expect(await db.select().from(assistantDrafts)).toHaveLength(1);
		// The database holds the same rule against two requests racing.
		await expect(
			db
				.insert(assistantDrafts)
				.values({ userId: ownerId, storyId, sceneId: target, brief: 'b', targetWords: 500 })
		).rejects.toThrow();
	});

	it('stages nothing when the job could not be queued', async () => {
		jobs.queueAssistantDraft.mockResolvedValueOnce(null);
		const result = await requestSceneDraft(db, input(), { queue: jobs.queueAssistantDraft });
		expect(result.ok).toBe(false);
		expect(await db.select().from(assistantDrafts)).toEqual([]);
	});

	it("is refused for another user's scene", async () => {
		const result = await requestSceneDraft(
			db,
			{ ...input(), userId: strangerId },
			{ queue: jobs.queueAssistantDraft }
		);
		expect(result).toMatchObject({ ok: false, code: 'not_found' });
		expect(await db.select().from(assistantDrafts)).toEqual([]);
	});

	it('replaces a failed draft, and one whose job was dropped', async () => {
		const first = await request();
		await failSceneDraft(db, first.draftId, 'It failed.');
		const second = await request();
		expect((await draftRow(first.draftId)).status).toBe('discarded');

		// The second job vanished without settling its draft.
		jobs.assistantDraftJobState.mockResolvedValue('failed');
		const third = await request();
		expect((await draftRow(second.draftId)).status).toBe('discarded');
		expect((await draftRow(third.draftId)).status).toBe('pending');
	});
});

describe('the endpoint', () => {
	const body = () => ({
		storyId,
		sceneId: target,
		brief: 'Ilse crosses the river.',
		targetWords: 900
	});

	it('answers the defaults, the estimate and the request for the owner', async () => {
		const owner = { id: ownerId };
		const defaults = await call(
			draftRoute.POST,
			event(owner, { body: { ...body(), defaults: true } })
		);
		expect(defaults).toMatchObject({ status: 200, body: { sceneTitle: 'The Crossing' } });
		const estimate = await call(
			draftRoute.POST,
			event(owner, { body: { ...body(), estimate: true } })
		);
		expect(estimate).toMatchObject({ status: 200, body: { estCompletionTokens: 1260 } });
		expect(await db.select().from(assistantDrafts)).toEqual([]);

		const started = await call(draftRoute.POST, event(owner, { body: body() }));
		expect(started).toMatchObject({ status: 200, body: { ok: true, jobId: expect.any(String) } });
		const read = await call(
			draftRoute.GET,
			event(owner, { method: 'GET', path: `/?storyId=${storyId}&sceneId=${target}` })
		);
		expect(read.body.draft).toMatchObject({ status: 'pending', sceneEmpty: true });
	});

	it('refuses when the Assistant is off for the account', async () => {
		await saveAccountLlmConfig(db, ownerId, {
			enabled: false,
			assistantName: '',
			persona: 'balanced',
			endpoint: 'https://api.example.com/v1',
			apiKey: 'sk',
			models: { coauthor: 'write-model' }
		});
		for (const extra of [{}, { estimate: true }, { defaults: true }]) {
			const result = await call(
				draftRoute.POST,
				event({ id: ownerId }, { body: { ...body(), ...extra } })
			);
			expect(result.status).toBe(403);
		}
		expect(jobs.queueAssistantDraft).not.toHaveBeenCalled();
		expect(await db.select().from(assistantDrafts)).toEqual([]);
	});

	it('refuses when the story is muted', async () => {
		await saveStoryLlmOverride(db, storyId, { enabled: false });
		const result = await call(draftRoute.POST, event({ id: ownerId }, { body: body() }));
		expect(result.status).toBe(403);
		const read = await call(
			draftRoute.GET,
			event({ id: ownerId }, { method: 'GET', path: `/?storyId=${storyId}&sceneId=${target}` })
		);
		// Reading a staged draft sends nothing, so it is not gated by the mute.
		expect(read).toEqual({ status: 200, body: { draft: null } });
		expect(jobs.queueAssistantDraft).not.toHaveBeenCalled();
	});

	it('still shows and decides a draft written before the story was muted', async () => {
		const draftId = await readyDraft('Written before the mute.');
		await saveStoryLlmOverride(db, storyId, { enabled: false });
		const owner = { id: ownerId };
		const read = await call(
			draftRoute.GET,
			event(owner, { method: 'GET', path: `/?storyId=${storyId}&sceneId=${target}` })
		);
		expect(read.body.draft).toMatchObject({ id: draftId, status: 'ready' });
		const edited = await call(
			decideRoute.PATCH,
			event(owner, { method: 'PATCH', params: { id: draftId }, body: { text: 'Edited.' } })
		);
		expect(edited.status).toBe(200);
		const filled = await call(
			decideRoute.POST,
			event(owner, { params: { id: draftId }, body: { action: 'fill' } })
		);
		expect(filled.status).toBe(200);
		expect((await sceneRow(target)).bodyMd).toBe('Edited.');
		// Another user's scene is still not readable.
		const stranger = await call(
			draftRoute.GET,
			event({ id: strangerId }, { method: 'GET', path: `/?storyId=${storyId}&sceneId=${target}` })
		);
		expect(stranger.status).toBe(404);
	});

	it('saves edits to a ready draft for its owner, and never touches the scene', async () => {
		const draftId = await readyDraft('As written.');
		const snapshot = await scenesSnapshot();
		const revisionsBefore = await revisionCount();
		const patch = (user: TestUser | null, text: unknown, id = draftId) =>
			call(decideRoute.PATCH, event(user, { method: 'PATCH', params: { id }, body: { text } }));
		expect((await patch({ id: ownerId }, 'As the writer changed it.')).status).toBe(200);
		expect((await draftRow(draftId)).textMd).toBe('As the writer changed it.');
		// It is the saved text that is kept when the panel sends none.
		expect((await sceneDraftFor(db, ownerId, target))?.textMd).toBe('As the writer changed it.');

		expect((await patch({ id: strangerId }, 'Theirs.')).status).toBe(404);
		expect((await patch(null, 'x')).status).toBe(401);
		expect((await patch({ id: ownerId }, 42)).status).toBe(400);
		expect((await patch({ id: ownerId }, 'x'.repeat(2_000_001))).status).toBe(413);
		expect((await draftRow(draftId)).textMd).toBe('As the writer changed it.');
		expect(await scenesSnapshot()).toEqual(snapshot);
		expect(await revisionCount()).toBe(revisionsBefore);
	});

	it('refuses edits to a draft that is not ready, or already kept or discarded', async () => {
		const pending = await request();
		const patch = (id: string) =>
			call(
				decideRoute.PATCH,
				event({ id: ownerId }, { method: 'PATCH', params: { id }, body: { text: 'Late.' } })
			);
		expect((await patch(pending.draftId)).status).toBe(409);
		await discardSceneDraft(db, ownerId, pending.draftId);
		expect((await patch(pending.draftId)).status).toBe(409);
		expect((await draftRow(pending.draftId)).textMd).toBe('');

		const kept = await readyDraft('Kept as written.');
		await fillSceneFromDraft(db, ownerId, kept);
		expect((await patch(kept)).status).toBe(409);
		expect((await draftRow(kept)).textMd).toBe('Kept as written.');
		expect((await sceneRow(target)).bodyMd).toBe('Kept as written.');
	});

	it('refuses an estimate over the cap with the reason', async () => {
		await configure({ spendCapUsd: 1 });
		await saveModelPricing(db, ownerId, { 'write-model': { prompt: 0, completion: 0.01 } });
		const result = await call(draftRoute.POST, event({ id: ownerId }, { body: body() }));
		expect(result.status).toBe(409);
		expect(String(result.body.message)).toMatch(/spend cap/);
		expect(jobs.queueAssistantDraft).not.toHaveBeenCalled();
	});

	it('needs a brief', async () => {
		const result = await call(
			draftRoute.POST,
			event({ id: ownerId }, { body: { ...body(), brief: '  ' } })
		);
		expect(result.status).toBe(400);
	});

	it('gives another user nothing: not the form, the estimate, the draft or a decision', async () => {
		const draftId = await readyDraft();
		const snapshot = await scenesSnapshot();
		const stranger = { id: strangerId };
		for (const extra of [{}, { estimate: true }, { defaults: true }]) {
			const result = await call(
				draftRoute.POST,
				event(stranger, { body: { ...body(), ...extra } })
			);
			expect(result.status).toBe(404);
		}
		const read = await call(
			draftRoute.GET,
			event(stranger, { method: 'GET', path: `/?storyId=${storyId}&sceneId=${target}` })
		);
		expect(read.status).toBe(404);
		for (const action of ['fill', 'add', 'discard']) {
			const result = await call(
				decideRoute.POST,
				event(stranger, { params: { id: draftId }, body: { action, text: 'Mine now.' } })
			);
			expect(result.status).toBe(404);
		}
		expect((await draftRow(draftId)).status).toBe('ready');
		expect(await scenesSnapshot()).toEqual(snapshot);
	});

	it('decides a draft for its owner, and stops the job of one still being written', async () => {
		const { draftId, jobId } = await request();
		const discarded = await call(
			decideRoute.POST,
			event({ id: ownerId }, { params: { id: draftId }, body: { action: 'discard' } })
		);
		expect(discarded.status).toBe(200);
		expect(jobs.stopRunningAssistantJob).toHaveBeenCalledWith(ownerId, jobId);
		expect((await draftRow(draftId)).status).toBe('discarded');

		const ready = await readyDraft('A new scene.');
		const added = await call(
			decideRoute.POST,
			event({ id: ownerId }, { params: { id: ready }, body: { action: 'add' } })
		);
		expect(added.status).toBe(200);
		expect(jobs.queueSceneMentions).toHaveBeenCalledWith(added.body.newSceneId);
		const unknown = await call(
			decideRoute.POST,
			event({ id: ownerId }, { params: { id: ready }, body: { action: 'replace' } })
		);
		expect(unknown.status).toBe(400);
	});
});

describe('the job', () => {
	it('writes the draft and never changes a scene', async () => {
		const snapshot = await scenesSnapshot();
		const revisionsBefore = await revisionCount();
		const { draftId, jobId } = await request();
		const result = await runSceneDraft(db, { userId: ownerId, draftId, jobId }, deps);

		expect(result).toMatchObject({ outcome: 'ready', words: 7, cutOff: false });
		expect(await draftRow(draftId)).toMatchObject({
			status: 'ready',
			textMd: 'The ferry rocked. *Not yet,* Ilse thought.',
			note: null
		});
		expect(await scenesSnapshot()).toEqual(snapshot);
		expect(await revisionCount()).toBe(revisionsBefore);
	});

	it('sends the brief, the scenes on either side, and a reply limit from the length', async () => {
		const { draftId } = await request({ pov: 'Ilse, close third', targetWords: 1000 });
		await runSceneDraft(db, { userId: ownerId, draftId }, deps);
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain('"Ilse crosses the river and hides the ledger."');
		expect(prompts[0]).toContain('about 1000 words');
		expect(prompts[0]).toContain('Point of view: Ilse, close third.');
		// The previous scene's prose, for voice.
		expect(prompts[0]).toContain(BEFORE_BODY);
		// The following scene's summary, so the draft lands before it.
		expect(prompts[0]).toContain('("The Far Bank") is summarised as:');
		expect(prompts[0]).toContain('Ilse wakes in the reeds.');
		expect(maxTokensSent).toEqual([1800]);
	});

	it('holds the reply limit to half a known context window', async () => {
		await saveModelContext(db, ownerId, { 'write-model': 2000 });
		const { draftId } = await request();
		await runSceneDraft(db, { userId: ownerId, draftId }, deps);
		expect(maxTokensSent).toEqual([1000]);
	});

	it('shows how the following scene opens when its summary is out of date', async () => {
		await pool.query(
			`update scenes set summary_generated_at = updated_at - interval '1 hour' where id = $1`,
			[after]
		);
		const { draftId } = await request();
		await runSceneDraft(db, { userId: ownerId, draftId }, deps);
		expect(prompts[0]).toContain('("The Far Bank") opens with:');
		expect(prompts[0]).toContain(AFTER_BODY);
		expect(prompts[0]).not.toContain('is summarised as:');
	});

	it('continues a scene that already has prose, and leaves that prose alone', async () => {
		await db
			.update(scenes)
			.set({ bodyMd: 'The ferryman would not look at her.' })
			.where(eq(scenes.id, target));
		const snapshot = await scenesSnapshot();
		const { draftId } = await request();
		await runSceneDraft(db, { userId: ownerId, draftId }, deps);
		// The scene's text is sent once, in the context, and the task points at it.
		expect(prompts[0]).toContain('The current scene already has prose');
		expect(prompts[0].split('The ferryman would not look at her.')).toHaveLength(2);
		expect(prompts[0]).toContain('Do not repeat or rewrite what is already there.');
		expect(await scenesSnapshot()).toEqual(snapshot);
	});

	it('keeps a draft that stopped at the length limit, and says so', async () => {
		cutOff = true;
		const { draftId } = await request();
		const result = await runSceneDraft(db, { userId: ownerId, draftId }, deps);
		expect(result).toMatchObject({ outcome: 'ready', cutOff: true });
		const row = await draftRow(draftId);
		expect(row.status).toBe('ready');
		expect(row.note).toMatch(/stopped at the length limit/);
	});

	it('asks nothing when the story was muted after the request', async () => {
		const snapshot = await scenesSnapshot();
		const { draftId } = await request();
		await saveStoryLlmOverride(db, storyId, { enabled: false });
		const result = await runSceneDraft(db, { userId: ownerId, draftId }, deps);
		expect(result).toEqual({ outcome: 'off' });
		expect(prompts).toEqual([]);
		expect(await draftRow(draftId)).toMatchObject({ status: 'failed', textMd: '' });
		expect(await scenesSnapshot()).toEqual(snapshot);
	});

	it('asks nothing when the Assistant was switched off after the request', async () => {
		const { draftId } = await request();
		await saveAccountLlmConfig(db, ownerId, {
			enabled: false,
			assistantName: '',
			persona: 'balanced',
			endpoint: 'https://api.example.com/v1',
			apiKey: 'sk',
			models: { coauthor: 'write-model' }
		});
		const result = await runSceneDraft(db, { userId: ownerId, draftId }, deps);
		expect(result).toEqual({ outcome: 'off' });
		expect(prompts).toEqual([]);
		expect((await draftRow(draftId)).status).toBe('failed');
	});

	it('leaves nothing behind when the writer stops it', async () => {
		const snapshot = await scenesSnapshot();
		const { draftId } = await request();
		const controller = new AbortController();
		// The writer selects Stop while the model is writing.
		whileWriting = async () => controller.abort(new WriterStopError());
		reply = new WriterStopError();
		const result = await runSceneDraft(
			db,
			{ userId: ownerId, draftId, signal: controller.signal },
			deps
		);
		expect(result).toEqual({ outcome: 'stopped' });
		expect(await draftRow(draftId)).toMatchObject({ status: 'discarded', textMd: '' });
		expect(await scenesSnapshot()).toEqual(snapshot);
		// Nothing holds the scene: another draft can be asked for.
		expect((await request()).draftId).not.toBe(draftId);
	});

	it('leaves the draft for the retry when the job is cut short for another reason', async () => {
		const { draftId } = await request();
		const controller = new AbortController();
		// A worker shutting down, or the job expiring: pg-boss runs it again.
		whileWriting = async () => controller.abort(new Error('shutting down'));
		reply = Object.assign(new Error('aborted'), { name: 'AbortError' });
		await expect(
			runSceneDraft(db, { userId: ownerId, draftId, signal: controller.signal }, deps)
		).rejects.toThrow();
		expect(await draftRow(draftId)).toMatchObject({ status: 'running', textMd: '' });

		// The retry writes it.
		whileWriting = null;
		reply = 'Second attempt.';
		const result = await runSceneDraft(db, { userId: ownerId, draftId }, deps);
		expect(result.outcome).toBe('ready');
		expect((await draftRow(draftId)).textMd).toBe('Second attempt.');
	});

	it('asks nothing once earlier attempts of the job spent the cap', async () => {
		await configure({ spendCapUsd: 5 });
		await saveModelPricing(db, ownerId, { 'write-model': { prompt: 0.001, completion: 0 } });
		const snapshot = await scenesSnapshot();
		const { draftId } = await request();
		await pool.query(
			`insert into assistant_job_spend (job_id, user_id, spent_usd) values ('draft-job', $1, 5)`,
			[ownerId]
		);
		const result = await runSceneDraft(db, { userId: ownerId, draftId, jobId: 'draft-job' }, deps);
		expect(result).toEqual({ outcome: 'capped', spentUsd: 5 });
		expect(prompts).toEqual([]);
		const row = await draftRow(draftId);
		expect(row).toMatchObject({ status: 'failed', textMd: '' });
		expect(row.note).toMatch(/spend cap/);
		expect(await scenesSnapshot()).toEqual(snapshot);
	});

	it('counts the request towards the job', async () => {
		await configure({ spendCapUsd: 5 });
		// $1 a request: 1000 prompt tokens at $0.001.
		await saveModelPricing(db, ownerId, { 'write-model': { prompt: 0.001, completion: 0 } });
		const { draftId } = await request();
		await runSceneDraft(db, { userId: ownerId, draftId, jobId: 'draft-spend' }, deps);
		const { rows } = await pool.query(
			`select spent_usd from assistant_job_spend where job_id = 'draft-spend'`
		);
		expect(rows[0].spent_usd).toBeCloseTo(1, 6);
	});

	it('does not bring back a draft the writer discarded while it was being written', async () => {
		const { draftId } = await request();
		whileWriting = async () => {
			await discardSceneDraft(db, ownerId, draftId);
		};
		// Nothing was kept, so there is no draft to tell the writer about.
		expect(await runSceneDraft(db, { userId: ownerId, draftId }, deps)).toEqual({
			outcome: 'missing'
		});
		expect(await draftRow(draftId)).toMatchObject({ status: 'discarded', textMd: '' });
	});

	it("does nothing for a draft that is not the user's, or is already decided", async () => {
		const { draftId } = await request();
		expect(await runSceneDraft(db, { userId: strangerId, draftId }, deps)).toEqual({
			outcome: 'missing'
		});
		await discardSceneDraft(db, ownerId, draftId);
		expect(await runSceneDraft(db, { userId: ownerId, draftId }, deps)).toEqual({
			outcome: 'missing'
		});
		expect(prompts).toEqual([]);
	});

	it('fails the draft when its scene went to the trash meanwhile', async () => {
		const { draftId } = await request();
		await trashScene(db, ownerId, target);
		expect(await runSceneDraft(db, { userId: ownerId, draftId }, deps)).toEqual({
			outcome: 'missing'
		});
		expect(prompts).toEqual([]);
		expect((await draftRow(draftId)).status).toBe('failed');
	});
});

describe('reading a draft back', () => {
	it('shows the draft for its scene to its owner only', async () => {
		const draftId = await readyDraft();
		const view = await sceneDraftFor(db, ownerId, target);
		expect(view).toMatchObject({
			id: draftId,
			sceneId: target,
			status: 'ready',
			textMd: 'The ferry rocked. *Not yet,* Ilse thought.',
			sceneEmpty: true,
			sceneTitle: 'The Crossing'
		});
		expect(await sceneDraftFor(db, strangerId, target)).toBeNull();
		expect(await sceneDraftFor(db, ownerId, before)).toBeNull();
	});

	it('says when the scene is no longer empty', async () => {
		await readyDraft();
		await db.update(scenes).set({ bodyMd: 'Now written.' }).where(eq(scenes.id, target));
		expect((await sceneDraftFor(db, ownerId, target))?.sceneEmpty).toBe(false);
	});

	it('settles a draft whose job ended without it', async () => {
		const first = await request();
		// Stopped while still queued: the worker never ran it.
		jobs.assistantDraftJobState.mockResolvedValue('stopped');
		expect(await sceneDraftFor(db, ownerId, target, jobs.assistantDraftJobState)).toBeNull();
		expect((await draftRow(first.draftId)).status).toBe('discarded');

		jobs.assistantDraftJobState.mockResolvedValue('running');
		const second = await request();
		expect((await sceneDraftFor(db, ownerId, target, jobs.assistantDraftJobState))?.status).toBe(
			'pending'
		);
		// Dropped by the queue.
		jobs.assistantDraftJobState.mockResolvedValue('failed');
		const view = await sceneDraftFor(db, ownerId, target, jobs.assistantDraftJobState);
		expect(view).toMatchObject({
			id: second.draftId,
			status: 'failed',
			note: DRAFT_DID_NOT_FINISH
		});
	});

	it('settles a draft whose job was never queued, once it has had time to be', async () => {
		// The request died between writing the row and queueing its job.
		const { draftId } = await request();
		jobs.assistantDraftJobState.mockResolvedValue('missing');
		// Just written: the job may be on its way, so the draft still waits.
		expect((await sceneDraftFor(db, ownerId, target, jobs.assistantDraftJobState))?.status).toBe(
			'pending'
		);
		const refused = await requestSceneDraft(db, input(), {
			queue: jobs.queueAssistantDraft,
			jobState: jobs.assistantDraftJobState
		});
		expect(refused.ok).toBe(false);

		await pool.query(
			`update assistant_drafts set created_at = now() - interval '5 minutes' where id = $1`,
			[draftId]
		);
		expect(await sceneDraftFor(db, ownerId, target, jobs.assistantDraftJobState)).toMatchObject({
			id: draftId,
			status: 'failed',
			note: DRAFT_DID_NOT_FINISH
		});
		// It no longer holds the scene.
		expect((await request()).draftId).not.toBe(draftId);
	});

	it('settles an old draft with no job id at all', async () => {
		const [row] = await db
			.insert(assistantDrafts)
			.values({ userId: ownerId, storyId, sceneId: target, brief: 'b', targetWords: 500 })
			.returning({ id: assistantDrafts.id });
		await pool.query(
			`update assistant_drafts set created_at = now() - interval '5 minutes' where id = $1`,
			[row.id]
		);
		expect((await request()).draftId).not.toBe(row.id);
		expect((await draftRow(row.id)).status).toBe('discarded');
	});

	it('leaves a finished draft alone whatever the queue says', async () => {
		const draftId = await readyDraft();
		jobs.assistantDraftJobState.mockResolvedValue('failed');
		const view = await sceneDraftFor(db, ownerId, target, jobs.assistantDraftJobState);
		expect(view).toMatchObject({ id: draftId, status: 'ready' });
	});
});

describe('Fill this scene', () => {
	it('puts the draft into the empty scene as an ordinary save, with a revision', async () => {
		const draftId = await readyDraft();
		const result = await fillSceneFromDraft(db, ownerId, draftId);
		expect(result).toEqual({ ok: true, sceneId: target });

		const scene = await sceneRow(target);
		expect(scene.bodyMd).toBe('The ferry rocked. *Not yet,* Ilse thought.');
		expect(scene.wordCount).toBe(7);
		// Title, status and place in the story are the writer's, and stay.
		expect(scene).toMatchObject({ title: 'The Crossing', status: 'outline', globalPosition: 2 });
		const history = await db.select().from(revisions).where(eq(revisions.entityId, target));
		expect(history.map((r) => r.bodyMd)).toEqual(['The ferry rocked. *Not yet,* Ilse thought.']);
		expect((await draftRow(draftId)).status).toBe('accepted');
		// The other scenes are as they were.
		expect((await sceneRow(before)).bodyMd).toBe(BEFORE_BODY);
		expect((await sceneRow(after)).bodyMd).toBe(AFTER_BODY);
	});

	it('uses the text as the writer edited it', async () => {
		const draftId = await readyDraft();
		await fillSceneFromDraft(db, ownerId, draftId, '  The ferry held.  ');
		expect((await sceneRow(target)).bodyMd).toBe('The ferry held.');
		expect((await draftRow(draftId)).textMd).toBe('The ferry held.');
	});

	it('refuses when the scene has gained prose since the draft was made, and leaves it untouched', async () => {
		const draftId = await readyDraft();
		// The writer typed into the scene after asking for the draft.
		const saved = await saveSceneBody(db, target, {
			title: 'The Crossing',
			bodyMd: 'My own opening line.',
			anchors: null,
			baseHashes: null,
			overwrite: false
		});
		expect(saved.ok).toBe(true);
		const snapshot = await scenesSnapshot();
		const revisionsBefore = await revisionCount();

		const result = await fillSceneFromDraft(db, ownerId, draftId);
		expect(result).toMatchObject({ ok: false, code: 'conflict' });
		expect(!result.ok && result.reason).toMatch(/has text in it now/);
		expect((await sceneRow(target)).bodyMd).toBe('My own opening line.');
		expect(await scenesSnapshot()).toEqual(snapshot);
		expect(await revisionCount()).toBe(revisionsBefore);
		// The draft is still there to add as a new scene instead.
		expect((await draftRow(draftId)).status).toBe('ready');
	});

	it('refuses when a save lands while the fill is waiting for the scene', async () => {
		const draftId = await readyDraft();
		// Another window's save holds the scene row, then stores its text.
		const client = await pool.connect();
		let filling: ReturnType<typeof fillSceneFromDraft>;
		try {
			await client.query('begin');
			await client.query('select id from scenes where id = $1 for update', [target]);
			filling = fillSceneFromDraft(db, ownerId, draftId);
			// Give the fill time to reach the lock.
			await new Promise((resolve) => setTimeout(resolve, 200));
			await client.query(`update scenes set body_md = 'Typed in another window.' where id = $1`, [
				target
			]);
			await client.query('commit');
		} finally {
			client.release();
		}
		expect(await filling).toMatchObject({ ok: false, code: 'conflict' });
		expect((await sceneRow(target)).bodyMd).toBe('Typed in another window.');
		expect((await draftRow(draftId)).status).toBe('ready');
	});

	it('treats a scene of only blank lines as empty, and any other text as prose', async () => {
		const blank = await readyDraft();
		await db.update(scenes).set({ bodyMd: '\n\n  \n' }).where(eq(scenes.id, target));
		expect((await fillSceneFromDraft(db, ownerId, blank)).ok).toBe(true);
	});

	it('is refused for a scene in the trash', async () => {
		const draftId = await readyDraft();
		await trashScene(db, ownerId, target);
		expect(await fillSceneFromDraft(db, ownerId, draftId)).toMatchObject({
			ok: false,
			code: 'not_found'
		});
		expect((await sceneRow(target)).bodyMd).toBe('');
	});

	it('cannot be used twice, or before the draft is ready', async () => {
		const pending = await request();
		expect(await fillSceneFromDraft(db, ownerId, pending.draftId)).toMatchObject({
			ok: false,
			code: 'conflict'
		});
		expect((await sceneRow(target)).bodyMd).toBe('');
		await runSceneDraft(db, { userId: ownerId, draftId: pending.draftId }, deps);
		expect((await fillSceneFromDraft(db, ownerId, pending.draftId)).ok).toBe(true);
		expect(await fillSceneFromDraft(db, ownerId, pending.draftId, 'Again.')).toMatchObject({
			ok: false,
			code: 'conflict'
		});
		expect((await sceneRow(target)).bodyMd).toBe('The ferry rocked. *Not yet,* Ilse thought.');
	});

	it("does nothing with another user's draft", async () => {
		const draftId = await readyDraft();
		expect(await fillSceneFromDraft(db, strangerId, draftId, 'Mine now.')).toMatchObject({
			ok: false,
			code: 'not_found'
		});
		expect((await sceneRow(target)).bodyMd).toBe('');
		expect((await draftRow(draftId)).status).toBe('ready');
	});
});

describe('Add as a new scene after this one', () => {
	it('creates a draft scene directly after, and changes no other text', async () => {
		const draftId = await readyDraft();
		const result = await addDraftAsScene(db, ownerId, draftId);
		expect(result.ok).toBe(true);
		const newSceneId = result.ok ? result.newSceneId : '';

		const order = await storyScenes();
		expect(order.map((s) => s.id)).toEqual([before, target, newSceneId, after]);
		expect(order.map((s) => s.globalPosition)).toEqual([1, 2, 3, 4]);
		expect(order.map((s) => s.positionInChapter)).toEqual([1, 2, 3, 4]);
		const created = order[2];
		expect(created).toMatchObject({
			chapterId,
			status: 'draft',
			title: null,
			bodyMd: 'The ferry rocked. *Not yet,* Ilse thought.',
			wordCount: 7,
			deletedAt: null
		});
		// The scene the draft was for, and its neighbours, keep their text.
		expect(order[0].bodyMd).toBe(BEFORE_BODY);
		expect(order[1].bodyMd).toBe('');
		expect(order[3].bodyMd).toBe(AFTER_BODY);
		const history = await db.select().from(revisions).where(eq(revisions.entityId, newSceneId));
		expect(history).toHaveLength(1);
		expect((await draftRow(draftId)).status).toBe('accepted');
	});

	it('is offered whatever the scene holds, and leaves that text alone', async () => {
		const draftId = await readyDraft();
		await db.update(scenes).set({ bodyMd: 'My own scene.' }).where(eq(scenes.id, target));
		const result = await addDraftAsScene(db, ownerId, draftId, 'The edited draft.');
		expect(result.ok).toBe(true);
		expect((await sceneRow(target)).bodyMd).toBe('My own scene.');
		expect((await sceneRow(result.ok ? result.newSceneId : '')).bodyMd).toBe('The edited draft.');
	});

	it('adds an unfiled scene after an unfiled one', async () => {
		await db
			.update(scenes)
			.set({ chapterId: null, positionInChapter: null })
			.where(eq(scenes.id, target));
		const draftId = await readyDraft();
		const result = await addDraftAsScene(db, ownerId, draftId);
		const created = await sceneRow(result.ok ? result.newSceneId : '');
		expect(created).toMatchObject({ chapterId: null, positionInChapter: null, globalPosition: 3 });
	});

	it("does nothing with another user's draft, an empty text, or a used draft", async () => {
		const draftId = await readyDraft();
		const snapshot = await scenesSnapshot();
		expect(await addDraftAsScene(db, strangerId, draftId)).toMatchObject({
			ok: false,
			code: 'not_found'
		});
		expect(await addDraftAsScene(db, ownerId, draftId, '   ')).toMatchObject({
			ok: false,
			code: 'invalid'
		});
		expect(await scenesSnapshot()).toEqual(snapshot);
		expect((await addDraftAsScene(db, ownerId, draftId)).ok).toBe(true);
		expect(await addDraftAsScene(db, ownerId, draftId)).toMatchObject({ ok: false });
		expect(await storyScenes()).toHaveLength(4);
	});
});

describe('Discard', () => {
	it('throws the draft away and changes nothing else', async () => {
		const draftId = await readyDraft();
		const snapshot = await scenesSnapshot();
		expect(await discardSceneDraft(db, ownerId, draftId)).toEqual({ ok: true, stopJobId: null });
		expect((await draftRow(draftId)).status).toBe('discarded');
		expect(await sceneDraftFor(db, ownerId, target)).toBeNull();
		expect(await scenesSnapshot()).toEqual(snapshot);
		expect(await fillSceneFromDraft(db, ownerId, draftId)).toMatchObject({ ok: false });
	});

	it('names the job to stop for a draft still being written', async () => {
		const { draftId, jobId } = await request();
		expect(await discardSceneDraft(db, ownerId, draftId)).toEqual({ ok: true, stopJobId: jobId });
	});

	it("is refused for another user's draft", async () => {
		const draftId = await readyDraft();
		expect(await discardSceneDraft(db, strangerId, draftId)).toMatchObject({
			ok: false,
			code: 'not_found'
		});
		expect((await draftRow(draftId)).status).toBe('ready');
	});
});

describe('the assistant_drafts table', () => {
	it('lets a scene, a story and an account be deleted, taking their drafts along', async () => {
		const draftId = await readyDraft();
		await trashScene(db, ownerId, target);
		expect(await destroyScene(db, ownerId, target)).toBe(true);
		expect(await draftRow(draftId)).toBeUndefined();

		// A draft on another scene goes with the story.
		const result = await requestSceneDraft(
			db,
			{ ...input(), sceneId: before },
			{ queue: jobs.queueAssistantDraft }
		);
		expect(result.ok).toBe(true);
		await purgeStory(db, storyId);
		expect(await db.select().from(assistantDrafts)).toEqual([]);
	});

	it('goes with its user', async () => {
		await readyDraft();
		await pool.query('truncate table users cascade');
		expect(await db.select().from(assistantDrafts)).toEqual([]);
	});

	it('cascades from every row it points at', async () => {
		const { rows } = await pool.query<{ column: string; rule: string }>(`
			select kcu.column_name as column, rc.delete_rule as rule
			from information_schema.referential_constraints rc
			join information_schema.key_column_usage kcu on kcu.constraint_name = rc.constraint_name
			where kcu.table_name = 'assistant_drafts'
			order by kcu.column_name
		`);
		expect(rows).toEqual([
			// A deleted chapter leaves its scenes, so it leaves their drafts.
			{ column: 'chapter_id', rule: 'SET NULL' },
			{ column: 'scene_id', rule: 'CASCADE' },
			{ column: 'story_id', rule: 'CASCADE' },
			{ column: 'user_id', rule: 'CASCADE' }
		]);
	});

	it('allows a new draft for a scene once the last one is decided', async () => {
		const first = await readyDraft();
		await discardSceneDraft(db, ownerId, first);
		const second = await readyDraft();
		await addDraftAsScene(db, ownerId, second);
		expect((await request()).draftId).toBeTruthy();
		const statuses = (await db.select().from(assistantDrafts)).map((d) => d.status).sort();
		expect(statuses).toEqual(['accepted', 'discarded', 'pending']);
	});
});
