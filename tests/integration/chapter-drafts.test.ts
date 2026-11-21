import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { asc, eq, inArray } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { isHttpError } from '@sveltejs/kit';
import type pg from 'pg';
import {
	assistantDrafts,
	chapters,
	scenes,
	stories,
	universes,
	users
} from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/auth';
import { textHash } from '../../src/lib/text-hash';
import type { GatewayDeps } from '../../src/lib/server/llm/gateway';
import {
	WriterStopError,
	type HttpRequest,
	type Provider
} from '../../src/lib/server/llm/providers/types';
import { ensureTestDatabase } from './test-db';

// Chapter drafts (#1168, step 2): one background job drafts a chapter's scenes
// in order, each into its own staged scene draft. These tests hold what the
// run promises: it stops at a scene boundary and keeps what it wrote, nothing
// half-written is staged, no scene is ever changed by the job, and each
// drafted scene is kept or discarded on its own by its writer only.

process.env.APP_SECRET = process.env.APP_SECRET || 'chapter-drafts-test-secret';

vi.mock('#lib/server/db', async () => {
	const { default: pgModule } = await import('pg');
	const { drizzle } = await import('drizzle-orm/node-postgres');
	const schemaModule = await import('../../src/lib/server/db/schema');
	const { TEST_DATABASE_URL } = await import('./test-db');
	const testPool = new pgModule.Pool({ connectionString: TEST_DATABASE_URL });
	return { db: drizzle(testPool, { schema: schemaModule }), pool: testPool };
});

// Queueing would start pg-boss. The queue hands back a job id; the job itself
// is run by hand through runChapterDraft.
const jobs = vi.hoisted(() => ({
	queueAssistantDraft: vi.fn<(job: { jobId: string }) => Promise<string | 'coalesced' | null>>(),
	queueAssistantChapterDraft:
		vi.fn<(job: { jobId: string }) => Promise<string | 'coalesced' | null>>(),
	assistantDraftJobState:
		vi.fn<(id: string) => Promise<'running' | 'stopped' | 'done' | 'failed' | 'missing'>>(),
	getAssistantJobState: vi.fn(async () => 'running'),
	reviewJobState: vi.fn(),
	queueSceneMentions: vi.fn(async () => undefined),
	stopRunningAssistantJob: vi.fn(async () => true)
}));
vi.mock('#lib/server/jobs', () => jobs);

const { db, pool } = (await import('#lib/server/db')) as unknown as {
	db: Database;
	pool: pg.Pool;
};
const { withBilledUsage } = await import('../../src/lib/server/llm/providers/types');
const { resetRateLimits } = await import('#lib/server/rate-limit');
const { saveAccountLlmConfig, saveModelPricing, saveStoryLlmOverride } =
	await import('../../src/lib/server/llm/config');
const {
	runChapterDraft,
	failChapterDraft,
	estimateSceneDraft,
	CHAPTER_DRAFT_ENDED_NOTE,
	emptyDraftCutOffNote
} = await import('../../src/lib/server/llm/scene-draft');
const {
	addDraftAsScene,
	chapterDraftDefaults,
	chapterDraftEstimate,
	chapterDraftFor,
	chapterDraftProgress,
	discardSceneDraft,
	fillSceneFromDraft,
	requestChapterDraft,
	requestSceneDraft,
	sceneDraftFor,
	CHAPTER_HAS_NO_SCENES
} = await import('../../src/lib/server/scene-drafts');
const { saveSceneBody } = await import('../../src/lib/server/scene-save');
const { deleteChapter, trashScene } = await import('../../src/lib/server/scene-lifecycle');
const { mergeScenes } = await import('../../src/lib/server/scene-split-merge');
const chapterRoute = await import('../../src/routes/api/assistant/draft/chapter/+server');
const decideRoute = await import('../../src/routes/api/assistant/draft/[id=uuid]/+server');
const statusRoute = await import('../../src/routes/api/assistant/job-status/+server');

// Every prompt the stub was sent. Each request is answered "Draft N."; a hook
// runs while request N is being written, and may throw.
let prompts: string[] = [];
let maxTokensSent: (number | undefined)[] = [];
let calls = 0;
let whileWriting: ((call: number) => Promise<void>) | null = null;
let cutOff = false;
// The request, counted from 1, that is answered with no text.
let emptyCall = 0;
const stubProvider: Provider = {
	async *chatStream() {
		yield { type: 'done' };
	},
	async respond(req) {
		prompts.push(req.messages.map((m) => m.content).join('\n'));
		maxTokensSent.push(req.maxTokens);
		const call = ++calls;
		await whileWriting?.(call);
		return {
			content: call === emptyCall ? '' : `Draft ${call}. The river ran on.`,
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
let storyId: string;
let chapterId: string;
let emptyChapterId: string;
// Three empty scenes in the chapter, and a written one in the chapter after.
let quay: string;
let crossing: string;
let bank: string;
let later: string;

async function configure(
	extra: {
		spendCapUsd?: number;
		enabled?: boolean;
		tuning?: { coauthor: { maxTokens: number } };
	} = {}
) {
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
	calls = 0;
	emptyCall = 0;
	whileWriting = null;
	cutOff = false;
	vi.clearAllMocks();
	// The queue takes the id the drafts' rows already carry.
	jobs.queueAssistantChapterDraft.mockImplementation(async (job) => job.jobId);
	jobs.queueAssistantDraft.mockImplementation(async (job) => job.jobId);
	jobs.assistantDraftJobState.mockResolvedValue('running');
	resetRateLimits();
	await pool.query('truncate table users cascade');
	const person = async (email: string, displayName: string) =>
		(
			await db
				.insert(users)
				.values({ email, displayName, passwordHash: 'x', role: 'user' })
				.returning({ id: users.id })
		)[0].id;
	ownerId = await person('o@example.com', 'Olwen');
	strangerId = await person('s@example.com', 'Sam');
	const [universe] = await db
		.insert(universes)
		.values({ ownerId, name: 'Aldermoor' })
		.returning({ id: universes.id });
	const [story] = await db
		.insert(stories)
		.values({ universeId: universe.id, ownerId, title: 'The Tide Below' })
		.returning({ id: stories.id });
	storyId = story.id;
	const chapter = async (position: number, title: string) =>
		(
			await db.insert(chapters).values({ storyId, position, title }).returning({ id: chapters.id })
		)[0].id;
	chapterId = await chapter(1, 'The River');
	const nextChapter = await chapter(2, 'After');
	emptyChapterId = await chapter(3, 'Unplanned');
	const make = async (
		inChapter: string,
		position: number,
		title: string,
		bodyMd: string,
		summaryMd?: string
	) =>
		(
			await db
				.insert(scenes)
				.values({
					storyId,
					chapterId: inChapter,
					positionInChapter: position,
					globalPosition: position,
					title,
					bodyMd,
					summaryMd,
					status: bodyMd ? 'draft' : 'outline',
					wordCount: bodyMd ? bodyMd.split(/\s+/).length : 0
				})
				.returning({ id: scenes.id })
		)[0].id;
	quay = await make(chapterId, 1, 'The Quay', '', 'Ilse reaches the quay at dusk.');
	crossing = await make(chapterId, 2, 'The Crossing', '', 'Ilse crosses and hides the ledger.');
	bank = await make(chapterId, 3, 'The Far Bank', '');
	later = await make(nextChapter, 4, 'Later', 'On the far bank the reeds were black with frost.');
	await configure();
});

afterAll(async () => {
	await pool.end();
});

const CHAPTER_BRIEF = 'Ilse flees across the river with the ledger.';

const input = (
	extra: Partial<{
		brief: string;
		targetWords: number;
		scenes: { sceneId: string; brief: string }[];
		chapterId: string;
	}> = {}
) => ({
	userId: ownerId,
	storyId,
	chapterId,
	brief: CHAPTER_BRIEF,
	targetWords: 1000,
	pov: null,
	scenes: [
		{ sceneId: quay, brief: 'Ilse reaches the quay at dusk.' },
		{ sceneId: crossing, brief: 'Ilse crosses and hides the ledger.' },
		{ sceneId: bank, brief: '' }
	],
	...extra
});

const queueDeps = () => ({
	queue: jobs.queueAssistantChapterDraft,
	jobState: jobs.assistantDraftJobState
});

async function request(extra: Parameters<typeof input>[0] = {}) {
	const result = await requestChapterDraft(db, input(extra), queueDeps());
	if (!result.ok) throw new Error(result.reason);
	return result;
}

it('keeps new chapter drafts whose run has failed by the time it is queued', async () => {
	const result = await requestChapterDraft(db, input(), {
		queue: async (job) => {
			await db
				.update(assistantDrafts)
				.set({ status: 'failed', note: 'The endpoint was down.' })
				.where(inArray(assistantDrafts.id, job.draftIds));
			return job.jobId;
		}
	});
	if (!result.ok) throw new Error(result.reason);
	const rows = await db
		.select({ status: assistantDrafts.status })
		.from(assistantDrafts)
		.where(inArray(assistantDrafts.id, result.draftIds));
	expect(rows.map((row) => row.status)).toEqual(['failed', 'failed', 'failed']);
});

const run = (
	started: { draftIds: string[]; jobId: string },
	extra: { signal?: AbortSignal; userId?: string } = {}
) =>
	runChapterDraft(
		db,
		{
			userId: ownerId,
			storyId,
			brief: CHAPTER_BRIEF,
			draftIds: started.draftIds,
			jobId: started.jobId,
			...extra
		},
		deps
	);

// The fingerprint of a draft's stored text, as the panel sends it back.
const baseFor = async (id: string) => {
	const [row] = await db.select().from(assistantDrafts).where(eq(assistantDrafts.id, id));
	return [textHash(row.textMd)];
};
const draftRows = () =>
	db
		.select()
		.from(assistantDrafts)
		.where(eq(assistantDrafts.chapterId, chapterId))
		.orderBy(asc(assistantDrafts.position));
const statuses = async (started?: { draftIds: string[] }) => {
	if (!started) return (await draftRows()).map((row) => row.status);
	const rows = await db.select().from(assistantDrafts);
	return started.draftIds.map((id) => rows.find((row) => row.id === id)?.status);
};
const sceneRow = async (id: string) => (await db.select().from(scenes).where(eq(scenes.id, id)))[0];
const storyScenes = () =>
	db.select().from(scenes).where(eq(scenes.storyId, storyId)).orderBy(asc(scenes.globalPosition));
// Everything about the story's scenes that a draft run must not disturb.
const scenesSnapshot = async () =>
	(await storyScenes()).map((s) => ({
		id: s.id,
		bodyMd: s.bodyMd,
		title: s.title,
		status: s.status,
		updatedAt: s.updatedAt.getTime(),
		globalPosition: s.globalPosition
	}));

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

describe('the chapter brief form', () => {
	const scope = () => ({ userId: ownerId, storyId, chapterId });

	it("lists the chapter's scenes in order, each with its summary as its brief", async () => {
		const defaults = await chapterDraftDefaults(db, scope());
		expect(defaults).toMatchObject({ chapterTitle: 'The River', targetWords: 300 });
		expect(defaults!.scenes).toEqual([
			{
				sceneId: quay,
				title: 'The Quay',
				brief: 'Ilse reaches the quay at dusk.',
				hasText: false,
				hasDraft: false
			},
			{
				sceneId: crossing,
				title: 'The Crossing',
				brief: 'Ilse crosses and hides the ledger.',
				hasText: false,
				hasDraft: false
			},
			{ sceneId: bank, title: 'The Far Bank', brief: '', hasText: false, hasDraft: false }
		]);
	});

	it('does not offer a summary the Assistant wrote before the scene last changed', async () => {
		await pool.query(
			`update scenes set summary_generated_at = updated_at - interval '1 hour' where id = $1`,
			[crossing]
		);
		const defaults = await chapterDraftDefaults(db, scope());
		expect(defaults!.scenes.map((scene) => scene.brief)).toEqual([
			'Ilse reaches the quay at dusk.',
			'',
			''
		]);
	});

	it('marks a scene that has text, one with a draft waiting, and leaves out one in the trash', async () => {
		await db.update(scenes).set({ bodyMd: 'The quay was empty.' }).where(eq(scenes.id, quay));
		await requestSceneDraft(
			db,
			{ userId: ownerId, storyId, sceneId: crossing, brief: 'b', targetWords: 500 },
			{ queue: jobs.queueAssistantDraft }
		);
		await trashScene(db, ownerId, bank);
		const defaults = await chapterDraftDefaults(db, scope());
		expect(defaults!.scenes).toMatchObject([
			{ sceneId: quay, hasText: true, hasDraft: false },
			{ sceneId: crossing, hasText: false, hasDraft: true }
		]);
		expect(defaults!.scenes).toHaveLength(2);
	});

	it("is not there for another user's chapter, or a chapter of another story", async () => {
		expect(await chapterDraftDefaults(db, { ...scope(), userId: strangerId })).toBeNull();
		const [other] = await db
			.insert(stories)
			.values({
				universeId: (await db.select().from(universes))[0].id,
				ownerId,
				title: 'Another'
			})
			.returning({ id: stories.id });
		expect(await chapterDraftDefaults(db, { ...scope(), storyId: other.id })).toBeNull();
	});
});

describe('the chapter estimate', () => {
	it('sums the scenes, counting the scene drafted before each later one', async () => {
		const single = async (sceneId: string, brief: string) =>
			(await estimateSceneDraft(db, {
				userId: ownerId,
				storyId,
				sceneId,
				brief,
				targetWords: 1000
			}))!.estTokens;
		const result = await chapterDraftEstimate(db, input());
		if (!result.ok) throw new Error(result.reason);
		expect(result.estimate).toMatchObject({
			model: 'write-model',
			scenes: 3,
			estCompletionTokens: 3 * 1800,
			overCap: false,
			skipped: []
		});
		// More than three stand-alone drafts: the chapter brief rides with each,
		// and the two later scenes carry the one before, counted as long as it
		// can be (6000 characters of it ride along) with the lines around it.
		const alone =
			(await single(quay, 'Ilse reaches the quay at dusk.')) +
			(await single(crossing, 'Ilse crosses and hides the ledger.')) +
			(await single(bank, CHAPTER_BRIEF));
		expect(result.estimate.estTokens).toBeGreaterThan(alone + 2 * 1500);
		expect(await db.select().from(assistantDrafts)).toEqual([]);
	});

	it('counts every scene at the limit sent when the model may think', async () => {
		await saveAccountLlmConfig(db, ownerId, {
			enabled: true,
			assistantName: '',
			persona: 'balanced',
			provider: 'anthropic',
			endpoint: 'https://api.example.com/v1',
			apiKey: 'sk',
			models: { coauthor: 'write-model' }
		});
		const result = await chapterDraftEstimate(db, input());
		expect(result.ok && result.estimate).toMatchObject({
			scenes: 3,
			estCompletionTokens: 3 * 16_384,
			mayThink: true
		});
		const started = await request();
		await run(started);
		expect(maxTokensSent).toEqual([16_384, 16_384, 16_384]);
	});

	it('counts the mark on a carried draft too long to ride along whole', async () => {
		// At 1500 tokens a draft is counted as 6000 characters, all of which
		// ride along. One token more and it is cut to its last 6000, with a
		// mark in front that it was shortened.
		const tokensAt = async (maxTokens: number) => {
			await configure({ tuning: { coauthor: { maxTokens } } });
			const result = await chapterDraftEstimate(db, input());
			if (!result.ok) throw new Error(result.reason);
			return result.estimate.estTokens;
		};
		expect(await tokensAt(1501)).toBeGreaterThan(await tokensAt(1500));
	});

	it('prices the whole run and holds it against the cap', async () => {
		await configure({ spendCapUsd: 20 });
		// Up to 1800 tokens out a scene at $0.01 is $18 a scene.
		await saveModelPricing(db, ownerId, { 'write-model': { prompt: 0, completion: 0.01 } });
		const one = await chapterDraftEstimate(db, input({ scenes: [{ sceneId: quay, brief: 'b' }] }));
		expect(one.ok && one.estimate).toMatchObject({ scenes: 1, overCap: false });
		const all = await chapterDraftEstimate(db, input());
		expect(all.ok && all.estimate).toMatchObject({ scenes: 3, overCap: true, capUsd: 20 });
		expect(all.ok && all.estimate.estCostUsd).toBeCloseTo(54, 6);
	});
});

describe('asking for a chapter draft', () => {
	it('stages a pending draft per scene in chapter order and queues one job', async () => {
		const snapshot = await scenesSnapshot();
		// Asked for out of order: the chapter's order is what counts.
		const result = await request({
			scenes: [
				{ sceneId: bank, brief: '' },
				{ sceneId: quay, brief: 'Quay brief.' },
				{ sceneId: crossing, brief: 'Crossing brief.' }
			]
		});
		const rows = await draftRows();
		expect(
			rows.map((row) => [row.sceneId, row.position, row.brief, row.status, row.jobId])
		).toEqual([
			[quay, 0, 'Quay brief.', 'pending', result.jobId],
			[crossing, 1, 'Crossing brief.', 'pending', result.jobId],
			[bank, 2, '', 'pending', result.jobId]
		]);
		expect(result).toMatchObject({ jobId: expect.any(String), skipped: [] });
		expect(result.draftIds).toEqual(rows.map((row) => row.id));
		expect(jobs.queueAssistantChapterDraft).toHaveBeenCalledTimes(1);
		expect(jobs.queueAssistantChapterDraft).toHaveBeenCalledWith({
			jobId: result.jobId,
			userId: ownerId,
			storyId,
			chapterId,
			draftIds: result.draftIds,
			brief: CHAPTER_BRIEF
		});
		expect(prompts).toEqual([]);
		expect(await scenesSnapshot()).toEqual(snapshot);
	});

	it('drafts only the scenes chosen', async () => {
		await request({ scenes: [{ sceneId: crossing, brief: 'Only this.' }] });
		expect((await draftRows()).map((row) => row.sceneId)).toEqual([crossing]);
	});

	it('refuses a chapter with no scenes, and says what to do first', async () => {
		const result = await requestChapterDraft(
			db,
			input({ chapterId: emptyChapterId, scenes: [] }),
			queueDeps()
		);
		expect(result).toEqual({ ok: false, code: 'invalid', reason: CHAPTER_HAS_NO_SCENES });
		expect(jobs.queueAssistantChapterDraft).not.toHaveBeenCalled();
	});

	it('refuses when no scene of the chapter is chosen', async () => {
		// A scene of another chapter does not count.
		const result = await requestChapterDraft(
			db,
			input({ scenes: [{ sceneId: later, brief: 'x' }] }),
			queueDeps()
		);
		expect(result).toMatchObject({ ok: false, code: 'invalid' });
		expect(await db.select().from(assistantDrafts)).toEqual([]);
	});

	it('needs a chapter brief, or a brief for every scene chosen', async () => {
		const missing = await requestChapterDraft(db, input({ brief: '  ' }), queueDeps());
		expect(missing).toMatchObject({ ok: false, code: 'invalid' });
		const each = await requestChapterDraft(
			db,
			input({
				brief: '',
				scenes: [
					{ sceneId: quay, brief: 'a' },
					{ sceneId: crossing, brief: 'b' }
				]
			}),
			queueDeps()
		);
		expect(each.ok).toBe(true);
	});

	it('leaves out a scene that already has an undecided draft, and says so', async () => {
		const single = await requestSceneDraft(
			db,
			{ userId: ownerId, storyId, sceneId: crossing, brief: 'Mine.', targetWords: 500 },
			{ queue: jobs.queueAssistantDraft }
		);
		if (!single.ok) throw new Error(single.reason);
		const estimate = await chapterDraftEstimate(db, input(), jobs.assistantDraftJobState);
		expect(estimate.ok && estimate.estimate).toMatchObject({
			scenes: 2,
			skipped: [{ sceneId: crossing, title: 'The Crossing' }]
		});

		const result = await request();
		expect(result.skipped).toEqual([{ sceneId: crossing, title: 'The Crossing' }]);
		expect((await draftRows()).map((row) => row.sceneId)).toEqual([quay, bank]);
		// The scene's own draft is untouched.
		const [mine] = await db
			.select()
			.from(assistantDrafts)
			.where(eq(assistantDrafts.id, single.draftId));
		expect(mine).toMatchObject({ status: 'pending', brief: 'Mine.', chapterId: null });
	});

	it('refuses when every scene chosen already has a draft', async () => {
		await request();
		const again = await requestChapterDraft(db, input(), queueDeps());
		expect(again).toMatchObject({ ok: false, code: 'conflict' });
		expect(!again.ok && again.reason).toMatch(/already has a draft/);
		expect(await draftRows()).toHaveLength(3);
	});

	it('refuses a summed estimate over the spend cap and stages nothing', async () => {
		await configure({ spendCapUsd: 20 });
		await saveModelPricing(db, ownerId, { 'write-model': { prompt: 0, completion: 0.01 } });
		const result = await requestChapterDraft(db, input(), queueDeps());
		expect(result).toMatchObject({ ok: false, code: 'conflict' });
		expect(!result.ok && result.reason).toMatch(/\$54\.00, over your spend cap of \$20\.00/);
		expect(jobs.queueAssistantChapterDraft).not.toHaveBeenCalled();
		expect(await db.select().from(assistantDrafts)).toEqual([]);
	});

	it('stages nothing when the job could not be queued, or the chapter is already queued', async () => {
		jobs.queueAssistantChapterDraft.mockResolvedValueOnce(null);
		expect(await requestChapterDraft(db, input(), queueDeps())).toMatchObject({ ok: false });
		expect(await db.select().from(assistantDrafts)).toEqual([]);
		jobs.queueAssistantChapterDraft.mockResolvedValueOnce('coalesced');
		const result = await requestChapterDraft(db, input(), queueDeps());
		expect(!result.ok && result.reason).toMatch(/already being drafted/);
		expect(await db.select().from(assistantDrafts)).toEqual([]);
	});

	it("is refused for another user's chapter", async () => {
		const result = await requestChapterDraft(db, { ...input(), userId: strangerId }, queueDeps());
		expect(result).toMatchObject({ ok: false, code: 'not_found' });
		expect(await db.select().from(assistantDrafts)).toEqual([]);
	});
});

describe('the endpoint', () => {
	const body = () => ({
		storyId,
		chapterId,
		brief: CHAPTER_BRIEF,
		targetWords: 900,
		scenes: [
			{ sceneId: quay, brief: 'Quay.' },
			{ sceneId: crossing, brief: '' }
		]
	});
	const read = (user: TestUser, chapter = chapterId) =>
		call(
			chapterRoute.GET,
			event(user, { method: 'GET', path: `/?storyId=${storyId}&chapterId=${chapter}` })
		);

	it('refuses a null character in a brief or the point of view', async () => {
		const owner = { id: ownerId };
		for (const odd of [
			{ brief: 'Ilse\u0000flees.' },
			{ pov: 'Il\u0000se' },
			{ scenes: [{ sceneId: quay, brief: 'Qu\u0000ay.' }] }
		]) {
			const answer = await call(chapterRoute.POST, event(owner, { body: { ...body(), ...odd } }));
			expect(answer.status).toBe(400);
		}
		expect(await db.select().from(assistantDrafts)).toEqual([]);
	});

	it('answers the defaults, the estimate and the request for the owner', async () => {
		const owner = { id: ownerId };
		const defaults = await call(
			chapterRoute.POST,
			event(owner, { body: { storyId, chapterId, defaults: true } })
		);
		expect(defaults).toMatchObject({ status: 200, body: { chapterTitle: 'The River' } });
		const estimate = await call(
			chapterRoute.POST,
			event(owner, { body: { ...body(), estimate: true } })
		);
		expect(estimate).toMatchObject({
			status: 200,
			body: { scenes: 2, estCompletionTokens: 2 * 1660 }
		});
		expect(await db.select().from(assistantDrafts)).toEqual([]);
		expect((await read(owner)).body.run).toBeNull();

		const started = await call(chapterRoute.POST, event(owner, { body: body() }));
		expect(started).toMatchObject({
			status: 200,
			body: { ok: true, jobId: expect.any(String), skipped: [] }
		});
		expect((await read(owner)).body.run).toMatchObject({
			chapterId,
			jobId: started.body.jobId,
			scenes: [
				{ sceneId: quay, status: 'pending' },
				{ sceneId: crossing, status: 'pending' }
			]
		});
	});

	it('says what to do first for a chapter with no scenes', async () => {
		for (const extra of [{ defaults: true }, { estimate: true }, {}]) {
			const result = await call(
				chapterRoute.POST,
				event({ id: ownerId }, { body: { ...body(), chapterId: emptyChapterId, ...extra } })
			);
			expect(result).toEqual({ status: 400, body: { message: CHAPTER_HAS_NO_SCENES } });
		}
	});

	it('refuses when the Assistant is off for the account or the story', async () => {
		await saveStoryLlmOverride(db, storyId, { enabled: false });
		for (const extra of [{}, { estimate: true }, { defaults: true }]) {
			const result = await call(
				chapterRoute.POST,
				event({ id: ownerId }, { body: { ...body(), ...extra } })
			);
			expect(result.status).toBe(403);
		}
		// Reading staged drafts back sends nothing, so it is not gated.
		expect(await read({ id: ownerId })).toEqual({ status: 200, body: { run: null } });

		await saveStoryLlmOverride(db, storyId, {});
		await configure({ enabled: false });
		expect((await call(chapterRoute.POST, event({ id: ownerId }, { body: body() }))).status).toBe(
			403
		);
		expect(jobs.queueAssistantChapterDraft).not.toHaveBeenCalled();
		expect(await db.select().from(assistantDrafts)).toEqual([]);
	});

	it('still lists drafts written before the story was muted', async () => {
		const started = await request();
		await run(started);
		await saveStoryLlmOverride(db, storyId, { enabled: false });
		const listed = await read({ id: ownerId });
		expect(listed.status).toBe(200);
		expect(listed.body.run).toMatchObject({
			scenes: [{ status: 'ready' }, { status: 'ready' }, { status: 'ready' }]
		});
		const kept = await call(
			decideRoute.POST,
			event(
				{ id: ownerId },
				{
					params: { id: started.draftIds[0] },
					body: { action: 'fill', baseHashes: await baseFor(started.draftIds[0]) }
				}
			)
		);
		expect(kept.status).toBe(200);
	});

	it('refuses an estimate over the cap with the reason', async () => {
		await configure({ spendCapUsd: 1 });
		await saveModelPricing(db, ownerId, { 'write-model': { prompt: 0, completion: 0.01 } });
		const result = await call(chapterRoute.POST, event({ id: ownerId }, { body: body() }));
		expect(result.status).toBe(409);
		expect(String(result.body.message)).toMatch(/spend cap/);
		expect(jobs.queueAssistantChapterDraft).not.toHaveBeenCalled();
	});

	it('gives another user nothing: not the form, the estimate, the run or a decision', async () => {
		const started = await request();
		await run(started);
		const stranger = { id: strangerId };
		for (const extra of [{ defaults: true }, { estimate: true }, {}]) {
			const result = await call(
				chapterRoute.POST,
				event(stranger, { body: { ...body(), ...extra } })
			);
			expect([403, 404]).toContain(result.status);
		}
		expect([403, 404]).toContain((await read(stranger)).status);
		for (const action of ['fill', 'add', 'discard']) {
			const result = await call(
				decideRoute.POST,
				event(stranger, {
					params: { id: started.draftIds[0] },
					body: { action, baseHashes: await baseFor(started.draftIds[0]) }
				})
			);
			expect(result.status).toBe(404);
		}
		expect(await statuses()).toEqual(['ready', 'ready', 'ready']);
		expect(jobs.queueAssistantChapterDraft).toHaveBeenCalledTimes(1);
	});

	it('reports how many scenes are settled while the job runs', async () => {
		const started = await request();
		const status = (user: TestUser) =>
			call(
				statusRoute.GET,
				event(user, { method: 'GET', path: `/?kind=draft&id=${started.jobId}` })
			);
		expect((await status({ id: ownerId })).body).toEqual({
			state: 'running',
			phase: 'scenes',
			completed: 0,
			total: 3
		});
		whileWriting = async (n) => {
			if (n === 2) {
				expect(await chapterDraftProgress(db, ownerId, started.jobId)).toEqual({
					completed: 1,
					total: 3
				});
			}
		};
		await run(started);
		expect((await status({ id: ownerId })).body).toMatchObject({ completed: 3, total: 3 });
		// Another user learns only the job's state.
		expect((await status({ id: strangerId })).body).toEqual({ state: 'running' });
	});
});

describe('the job', () => {
	it('drafts each scene in order and never changes a scene', async () => {
		const snapshot = await scenesSnapshot();
		const started = await request();
		const result = await run(started);
		expect(result).toMatchObject({
			outcome: 'done',
			drafted: 3,
			total: 3,
			cutOff: 0,
			gone: 0
		});
		expect(result.outcome === 'done' && result.ended).toBeUndefined();
		expect((await draftRows()).map((row) => [row.status, row.textMd])).toEqual([
			['ready', 'Draft 1. The river ran on.'],
			['ready', 'Draft 2. The river ran on.'],
			['ready', 'Draft 3. The river ran on.']
		]);
		expect(prompts).toHaveLength(3);
		expect(await scenesSnapshot()).toEqual(snapshot);
	});

	it('gives each scene the chapter brief, the scene drafted before it, and the plan for the next', async () => {
		await run(await request());
		const [first, second, third] = prompts;
		for (const prompt of prompts) expect(prompt).toContain(`"${CHAPTER_BRIEF}"`);

		expect(first).toContain('"Ilse reaches the quay at dusk."');
		expect(first).not.toContain('was just drafted');
		expect(first).toContain('("The Crossing") is planned as:');
		expect(first).toContain('Ilse crosses and hides the ledger.');

		expect(second).toContain('The scene before this one was just drafted, and reads:');
		expect(second).toContain('Draft 1. The river ran on.');
		expect(second).toContain('"Ilse crosses and hides the ledger."');
		// The next scene has no brief of its own and no text, so nothing is said of it.
		expect(second).not.toContain('is planned as');

		expect(third).toContain('Draft 2. The river ran on.');
		expect(third).not.toContain('Draft 1.');
		expect(third).toContain('as its part of the chapter described above');
		// The written scene after the chapter is how this one must end.
		expect(third).toContain('("Later") opens with:');
	});

	it('stops at a scene boundary when the spend cap is reached, keeping what was drafted', async () => {
		// Each request costs $0.50 (500 tokens out) and could cost $0.54 (its
		// limit). The run is asked for under a cap that allows it, and the cap
		// is lowered while it waits: after two scenes a third could pass it.
		await configure({ spendCapUsd: 5 });
		await saveModelPricing(db, ownerId, { 'write-model': { prompt: 0, completion: 0.001 } });
		const snapshot = await scenesSnapshot();
		const started = await request({ targetWords: 100 });
		await configure({ spendCapUsd: 1.5 });
		const result = await run(started);
		expect(result).toMatchObject({
			outcome: 'done',
			drafted: 2,
			total: 3,
			ended: 'capped'
		});
		expect(result.outcome === 'done' && result.spentUsd).toBeCloseTo(1, 6);
		expect(prompts).toHaveLength(2);
		const rows = await draftRows();
		expect(rows.map((row) => [row.status, row.textMd])).toEqual([
			['ready', 'Draft 1. The river ran on.'],
			['ready', 'Draft 2. The river ran on.'],
			['discarded', '']
		]);
		expect(rows[2].note).toBe(CHAPTER_DRAFT_ENDED_NOTE);
		expect(await scenesSnapshot()).toEqual(snapshot);
		// The scene left over can be asked for again.
		await configure({ spendCapUsd: 5 });
		const again = await request({ targetWords: 100, scenes: [{ sceneId: bank, brief: '' }] });
		expect(again.draftIds).toHaveLength(1);
	});

	it('does not send a scene that could take the run past the cap', async () => {
		// $1.80 a scene at most; three fit under $6.00.
		await configure({ spendCapUsd: 6 });
		await saveModelPricing(db, ownerId, { 'write-model': { prompt: 0, completion: 0.001 } });
		const started = await request();
		// Earlier attempts of the job spent $5.90: under the cap, with no room
		// for one more scene.
		await pool.query(
			`insert into assistant_job_spend (job_id, user_id, spent_usd) values ($1, $2, 5.9)`,
			[started.jobId, ownerId]
		);
		const result = await run(started);
		expect(result).toMatchObject({
			drafted: 0,
			total: 3,
			ended: 'capped',
			cappedNote:
				'The next request could cost up to $1.80. This job has spent about $5.90 and your spend cap is $6.00, so it was not sent. Choose fewer scenes or a shorter length, or raise the cap under Account, Assistant.'
		});
		expect(result.outcome === 'done' && result.spentUsd).toBeCloseTo(5.9, 6);
		expect(prompts).toEqual([]);
		// Nothing was drafted: the first scene's card says why.
		expect(await statuses()).toEqual(['failed', 'discarded', 'discarded']);
		expect((await draftRows())[0].note).toBe(result.outcome === 'done' && result.cappedNote);
	});

	it('ends as capped, keeping the scenes before, when a billed attempt leaves no room to resend', async () => {
		await configure({ spendCapUsd: 3.9 });
		await saveModelPricing(db, ownerId, { 'write-model': { prompt: 0, completion: 0.001 } });
		const started = await request({
			scenes: [
				{ sceneId: quay, brief: 'a' },
				{ sceneId: crossing, brief: 'b' }
			]
		});
		// The second scene's stream drops after 1700 tokens, which are charged:
		// $0.50 + $1.70, and another $1.80 would pass $3.90.
		whileWriting = async (n) => {
			if (n === 2) {
				throw withBilledUsage(new Error('Endpoint returned 502: the stream dropped'), {
					promptTokens: 1000,
					completionTokens: 1700,
					// Counted from what had streamed, so the figure is marked.
					estimated: true
				});
			}
		};
		const result = await run(started);
		expect(result).toMatchObject({
			outcome: 'done',
			drafted: 1,
			total: 2,
			ended: 'capped',
			cappedNote:
				'The next request could cost up to $1.80. This job has spent about $2.20 (estimated) and your spend cap is $3.90, so it was not sent. Choose fewer scenes or a shorter length, or raise the cap under Account, Assistant.'
		});
		expect(result.outcome === 'done' && result.spentUsd).toBeCloseTo(2.2, 6);
		expect(prompts).toHaveLength(2);
		expect(await statuses()).toEqual(['ready', 'discarded']);
	});

	it('asks nothing once earlier attempts of the job spent the cap', async () => {
		await configure({ spendCapUsd: 5 });
		await saveModelPricing(db, ownerId, { 'write-model': { prompt: 0, completion: 0.0001 } });
		const started = await request({ targetWords: 100 });
		await pool.query(
			`insert into assistant_job_spend (job_id, user_id, spent_usd) values ($1, $2, 5)`,
			[started.jobId, ownerId]
		);
		const result = await run(started);
		expect(result).toMatchObject({ drafted: 0, total: 3, ended: 'capped', spentUsd: 5 });
		expect(prompts).toEqual([]);
		expect(await statuses()).toEqual(['failed', 'discarded', 'discarded']);
	});

	it('holds what the run spent before a cap was set against it', async () => {
		// $0.50 a scene written, and up to $1.80 held for each before it is sent.
		await saveModelPricing(db, ownerId, { 'write-model': { prompt: 0, completion: 0.001 } });
		const started = await request();
		// No cap when the run starts; the writer sets one during the first scene.
		whileWriting = async (n) => {
			if (n === 1) await configure({ spendCapUsd: 2 });
		};
		const result = await run(started);
		// $0.50 spent and $1.80 more would pass $2.
		expect(result).toMatchObject({ drafted: 1, total: 3, ended: 'capped' });
		expect(result.outcome === 'done' && result.spentUsd).toBeCloseTo(0.5, 6);
		expect(result.outcome === 'done' && result.cappedNote).toMatch(/spent about \$0\.50 /);
		expect(prompts).toHaveLength(1);
	});

	it('goes on under a cap raised while it runs', async () => {
		// $1 a scene for the prompt as billed, less as counted beforehand.
		await saveModelPricing(db, ownerId, { 'write-model': { prompt: 0.001, completion: 0 } });
		const started = await request();
		await configure({ spendCapUsd: 0.9 });
		// The first scene is sent under $0.90 and bills $1; meanwhile the cap
		// is raised.
		whileWriting = async (n) => {
			if (n === 1) await configure({ spendCapUsd: 10 });
		};
		const result = await run(started);
		expect(result).toMatchObject({ drafted: 3, total: 3 });
		expect(result.outcome === 'done' && result.ended).toBeUndefined();
	});

	it('keeps the scenes already drafted when the writer stops it, and nothing half-written', async () => {
		const snapshot = await scenesSnapshot();
		const started = await request();
		const controller = new AbortController();
		// The writer selects Stop while the second scene is being written.
		whileWriting = async (n) => {
			if (n === 2) {
				controller.abort(new WriterStopError());
				throw new WriterStopError();
			}
		};
		const result = await run(started, { signal: controller.signal });
		expect(result).toMatchObject({ outcome: 'done', drafted: 1, total: 3, ended: 'stopped' });
		expect((await draftRows()).map((row) => [row.status, row.textMd])).toEqual([
			['ready', 'Draft 1. The river ran on.'],
			['discarded', ''],
			['discarded', '']
		]);
		expect(prompts).toHaveLength(2);
		expect(await scenesSnapshot()).toEqual(snapshot);
	});

	it('stops before the next scene when Stop lands between two', async () => {
		const started = await request();
		const controller = new AbortController();
		// The stop arrives just as the first scene's reply does.
		whileWriting = async (n) => {
			if (n === 1) controller.abort(new WriterStopError());
		};
		const result = await run(started, { signal: controller.signal });
		expect(result).toMatchObject({ drafted: 1, ended: 'stopped' });
		expect(prompts).toHaveLength(1);
		expect(await statuses()).toEqual(['ready', 'discarded', 'discarded']);
	});

	it('stops at the boundary when the story is muted during the run', async () => {
		const started = await request();
		whileWriting = async (n) => {
			if (n === 1) await saveStoryLlmOverride(db, storyId, { enabled: false });
		};
		const result = await run(started);
		expect(result).toMatchObject({ outcome: 'done', drafted: 1, total: 3, ended: 'off' });
		expect(prompts).toHaveLength(1);
		expect(await statuses()).toEqual(['ready', 'discarded', 'discarded']);
	});

	it('asks nothing when the Assistant was switched off after the request', async () => {
		const started = await request();
		await configure({ enabled: false });
		const result = await run(started);
		expect(result).toMatchObject({ drafted: 0, ended: 'off' });
		expect(prompts).toEqual([]);
		expect(await statuses()).toEqual(['discarded', 'discarded', 'discarded']);
	});

	it('leaves out a scene moved to the trash during the run, and carries on', async () => {
		const started = await request();
		whileWriting = async (n) => {
			if (n === 1) await trashScene(db, ownerId, crossing);
		};
		const result = await run(started);
		expect(result).toMatchObject({ outcome: 'done', drafted: 2, total: 3, gone: 1 });
		expect(result.outcome === 'done' && result.ended).toBeUndefined();
		const rows = await draftRows();
		expect(rows.map((row) => row.status)).toEqual(['ready', 'discarded', 'ready']);
		expect(rows[1]).toMatchObject({ textMd: '', note: expect.stringMatching(/no longer there/) });
		// The scene after the gap is not told to carry on from a draft two back.
		expect(prompts).toHaveLength(2);
		expect(prompts[1]).not.toContain('was just drafted');
		expect((await sceneRow(crossing)).bodyMd).toBe('');
	});

	it('leaves out a scene deleted for good during the run', async () => {
		const started = await request();
		whileWriting = async (n) => {
			if (n === 1) await db.delete(scenes).where(eq(scenes.id, crossing));
		};
		const result = await run(started);
		// Its draft went with the scene.
		expect(result).toMatchObject({ outcome: 'done', drafted: 2, total: 3 });
		expect(await statuses()).toEqual(['ready', 'ready']);
	});

	it('passes over a scene whose draft the writer discarded while it waited', async () => {
		const started = await request();
		whileWriting = async (n) => {
			if (n === 1) {
				const result = await discardSceneDraft(db, ownerId, started.draftIds[1]);
				// The job has other scenes to write, so it is not stopped.
				expect(result).toEqual({ ok: true, stopJobId: null });
			}
		};
		const result = await run(started);
		expect(result).toMatchObject({ drafted: 2, total: 3 });
		expect(await statuses()).toEqual(['ready', 'discarded', 'ready']);
		expect(prompts).toHaveLength(2);
	});

	it('does not bring back a draft discarded while it was being written', async () => {
		const started = await request();
		whileWriting = async (n) => {
			if (n === 2) await discardSceneDraft(db, ownerId, started.draftIds[1]);
		};
		const result = await run(started);
		expect(result).toMatchObject({ drafted: 2, total: 3 });
		expect((await draftRows()).map((row) => [row.status, row.textMd])).toEqual([
			['ready', 'Draft 1. The river ran on.'],
			['discarded', ''],
			['ready', 'Draft 3. The river ran on.']
		]);
	});

	it('carries on from the scene that failed when the job is retried', async () => {
		const started = await request();
		whileWriting = async (n) => {
			if (n >= 2) throw new Error('endpoint down');
		};
		await expect(run(started)).rejects.toThrow('endpoint down');
		// The first scene is kept; the rest wait for the retry.
		expect(await statuses()).toEqual(['ready', 'running', 'pending']);

		whileWriting = null;
		prompts = [];
		const result = await run(started);
		expect(result).toMatchObject({ outcome: 'done', drafted: 3, total: 3 });
		// Two more requests, not three, and the second scene still follows the first.
		expect(prompts).toHaveLength(2);
		expect(prompts[0]).toContain('Draft 1. The river ran on.');
		const rows = await draftRows();
		expect(rows.map((row) => row.status)).toEqual(['ready', 'ready', 'ready']);
		expect(rows[0].textMd).toBe('Draft 1. The river ran on.');
		expect(prompts[1]).toContain(rows[1].textMd);
	});

	it('ends a run that cannot be finished: the failed scene says why, the rest are dropped', async () => {
		const started = await request();
		whileWriting = async (n) => {
			if (n >= 2) throw new Error('endpoint down');
		};
		await expect(run(started)).rejects.toThrow();
		const left = await failChapterDraft(db, ownerId, started.draftIds, 'The endpoint is down.');
		expect(left).toEqual({ drafted: 1, total: 3 });
		const rows = await draftRows();
		expect(rows.map((row) => [row.status, row.note])).toEqual([
			['ready', null],
			['failed', 'The endpoint is down.'],
			['discarded', CHAPTER_DRAFT_ENDED_NOTE]
		]);
		// Another user's call changes nothing.
		expect(await failChapterDraft(db, strangerId, started.draftIds, 'x')).toEqual({
			drafted: 0,
			total: 3
		});
		expect(await statuses()).toEqual(['ready', 'failed', 'discarded']);
	});

	it('carries on when the chapter is deleted during the run, and keeps every draft', async () => {
		const started = await request();
		whileWriting = async (n) => {
			if (n === 2) {
				// The chapter heading goes; its scenes stay, unfiled.
				expect(await deleteChapter(db, ownerId, chapterId)).toBe(true);
				// The first scene's draft, already written, is still there.
				expect(await statuses(started)).toEqual(['ready', 'running', 'pending']);
				expect(await chapterDraftProgress(db, ownerId, started.jobId)).toEqual({
					completed: 1,
					total: 3
				});
			}
		};
		const result = await run(started);
		expect(result).toMatchObject({ outcome: 'done', drafted: 3, total: 3, gone: 0 });
		expect(result.outcome === 'done' && result.ended).toBeUndefined();
		expect(await statuses(started)).toEqual(['ready', 'ready', 'ready']);

		// Each is reached from its scene and kept like any scene draft.
		expect(await sceneDraftFor(db, ownerId, crossing)).toMatchObject({
			id: started.draftIds[1],
			status: 'ready',
			sceneEmpty: true
		});
		expect(await fillSceneFromDraft(db, ownerId, started.draftIds[1])).toEqual({
			ok: true,
			sceneId: crossing
		});
		expect(await discardSceneDraft(db, ownerId, started.draftIds[2])).toEqual({
			ok: true,
			stopJobId: null
		});
	});

	it('keeps the ready drafts of a chapter deleted after the run', async () => {
		const started = await request();
		await run(started);
		await deleteChapter(db, ownerId, chapterId);
		expect(await statuses(started)).toEqual(['ready', 'ready', 'ready']);
		expect((await sceneDraftFor(db, ownerId, quay))?.textMd).toBe('Draft 1. The river ran on.');
	});

	it('still drafts a scene moved to another chapter during the run', async () => {
		const started = await request();
		whileWriting = async (n) => {
			if (n === 1) {
				await db.update(scenes).set({ chapterId: emptyChapterId }).where(eq(scenes.id, crossing));
			}
		};
		const result = await run(started);
		expect(result).toMatchObject({ outcome: 'done', drafted: 3, total: 3 });
		// It is found from its scene, and no longer in the first chapter's list.
		expect((await sceneDraftFor(db, ownerId, crossing))?.status).toBe('ready');
		const listed = await chapterDraftFor(db, { userId: ownerId, storyId, chapterId });
		expect(listed!.scenes.map((scene) => scene.sceneId)).toEqual([quay, bank]);
	});

	it('ends cleanly when two of its scenes are merged during the run', async () => {
		const started = await request();
		whileWriting = async (n) => {
			if (n === 1) {
				const merged = await mergeScenes(db, ownerId, storyId, [crossing, bank]);
				expect(merged.ok).toBe(true);
			}
		};
		const result = await run(started);
		expect(result.outcome).toBe('done');
		// Nothing is left waiting, and no draft is ready for a scene that is gone.
		const live = new Set((await storyScenes()).filter((s) => !s.deletedAt).map((s) => s.id));
		for (const row of await db.select().from(assistantDrafts)) {
			expect(['ready', 'discarded']).toContain(row.status);
			if (row.status === 'ready') expect(live.has(row.sceneId!)).toBe(true);
		}
	});

	it('counts drafts that stopped at the length limit', async () => {
		cutOff = true;
		const result = await run(await request());
		expect(result).toMatchObject({ drafted: 3, cutOff: 3 });
		expect((await draftRows())[0].note).toMatch(/length limit/);
	});

	it("does nothing for a run that is not the user's, or is already settled", async () => {
		const started = await request();
		expect(await run(started, { userId: strangerId })).toEqual({ outcome: 'missing' });
		expect(prompts).toEqual([]);
		expect(await statuses()).toEqual(['pending', 'pending', 'pending']);
		await run(started);
		prompts = [];
		expect(await run(started)).toEqual({ outcome: 'missing' });
		expect(prompts).toEqual([]);
	});
});

describe('what a scene is told came before it', () => {
	const CARRIED = 'The scene before this one was just drafted';

	it('carries the draft of the scene directly before, and only that', async () => {
		// The first and third scenes are chosen; the second lies between them.
		const started = await request({
			scenes: [
				{ sceneId: quay, brief: 'Ilse reaches the quay at dusk.' },
				{ sceneId: bank, brief: 'Ilse wakes on the far bank.' }
			]
		});
		await run(started);
		expect(prompts).toHaveLength(2);
		// The third scene does not follow the first, so it is not told it does.
		expect(prompts[1]).not.toContain(CARRIED);
		expect(prompts[1]).not.toContain('Draft 1. The river ran on.');
	});

	it('does not repeat a draft the writer already kept, on a retry', async () => {
		const started = await request();
		whileWriting = async (n) => {
			if (n >= 2) throw new Error('endpoint down');
		};
		await expect(run(started)).rejects.toThrow('endpoint down');
		// The first draft is kept before the retry: it is in the manuscript now,
		// which the context already shows.
		const [first] = await draftRows();
		expect((await fillSceneFromDraft(db, ownerId, first.id)).ok).toBe(true);
		whileWriting = null;
		prompts = [];
		await run(started);
		expect(prompts).toHaveLength(2);
		expect(prompts[0]).not.toContain(CARRIED);
		expect(prompts[0].split('Draft 1. The river ran on.').length - 1).toBe(1);
	});

	it('counts the estimate the same way', async () => {
		const adjacent = await chapterDraftEstimate(
			db,
			input({
				scenes: [
					{ sceneId: quay, brief: 'a' },
					{ sceneId: crossing, brief: 'b' }
				]
			})
		);
		const apart = await chapterDraftEstimate(
			db,
			input({
				scenes: [
					{ sceneId: quay, brief: 'a' },
					{ sceneId: bank, brief: 'b' }
				]
			})
		);
		if (!adjacent.ok || !apart.ok) throw new Error('no estimate');
		// 6000 characters of the scene before ride with the adjacent pair only.
		expect(adjacent.estimate.estTokens - apart.estimate.estTokens).toBeGreaterThan(1200);
	});
});

describe('a failed draft when the chapter is asked for again', () => {
	async function failedFirst() {
		const started = await request();
		await failChapterDraft(db, ownerId, started.draftIds, 'The endpoint was down.');
		return started.draftIds[0];
	}
	const rowOf = async (id: string) =>
		(await db.select().from(assistantDrafts).where(eq(assistantDrafts.id, id)))[0];

	it('gives way once the new run stands', async () => {
		const failed = await failedFirst();
		await request();
		expect((await rowOf(failed)).status).toBe('discarded');
	});

	it('keeps its reason when the new run does not go through', async () => {
		const failed = await failedFirst();
		jobs.queueAssistantChapterDraft.mockResolvedValueOnce(null);
		const refused = await requestChapterDraft(db, input(), queueDeps());
		expect(refused.ok).toBe(false);
		expect(await rowOf(failed)).toMatchObject({
			status: 'failed',
			note: 'The endpoint was down.'
		});
	});
});

describe("another user's drafts on scenes the caller owns", () => {
	it('are not listed for the chapter', async () => {
		await db.insert(assistantDrafts).values({
			userId: strangerId,
			storyId,
			chapterId,
			sceneId: quay,
			position: 0,
			brief: 'Not yours.',
			targetWords: 500,
			textMd: 'Written for someone else.',
			status: 'ready'
		});
		expect(
			await chapterDraftFor(
				db,
				{ userId: ownerId, storyId, chapterId },
				jobs.assistantDraftJobState
			)
		).toBeNull();
		// And the scene is free for the owner's own run.
		const started = await request();
		expect(started.draftIds).toHaveLength(3);
		expect(started.skipped).toEqual([]);
	});
});

describe('a scene that comes back with no text', () => {
	it('ends the run there with one request for it, keeping the scenes before', async () => {
		emptyCall = 2;
		cutOff = true;
		const started = await request();
		const result = await run(started);
		expect(result).toMatchObject({
			outcome: 'done',
			drafted: 1,
			total: 3,
			ended: 'empty',
			emptyNote: emptyDraftCutOffNote('draft')
		});
		// Scene one, and scene two once: not sent again, and scene three not at all.
		expect(prompts).toHaveLength(2);
		const rows = await draftRows();
		expect(rows.map((row) => row.status)).toEqual(['ready', 'failed', 'discarded']);
		expect(rows[1].note).toBe(emptyDraftCutOffNote('draft'));
		// A second run of the job has nothing left to ask.
		expect(await run(started)).toEqual({ outcome: 'missing' });
		expect(prompts).toHaveLength(2);
	});
});

describe('a Stop the worker has not seen yet', () => {
	it('ends the run as stopped when a read of the drafts settled them first', async () => {
		const started = await request();
		// While the first scene is written the panel reads the chapter's drafts,
		// and the queue says the job was stopped.
		whileWriting = async (n) => {
			if (n !== 1) return;
			jobs.assistantDraftJobState.mockResolvedValue('stopped');
			await chapterDraftFor(
				db,
				{ userId: ownerId, storyId, chapterId },
				jobs.assistantDraftJobState
			);
		};
		const result = await run(started);
		expect(result).toMatchObject({ outcome: 'done', drafted: 0, ended: 'stopped' });
		expect(prompts).toHaveLength(1);
	});

	it('is reported as stopped even when nothing was left for the job to write', async () => {
		const started = await request();
		jobs.assistantDraftJobState.mockResolvedValue('stopped');
		await chapterDraftFor(db, { userId: ownerId, storyId, chapterId }, jobs.assistantDraftJobState);
		const result = await run(started);
		expect(result).toMatchObject({ outcome: 'done', drafted: 0, ended: 'stopped' });
		expect(prompts).toEqual([]);
	});
});

describe('deciding each drafted scene', () => {
	it('keeps or discards each scene on its own, with the scene draft actions', async () => {
		const started = await request();
		await run(started);
		const [first, second, third] = started.draftIds;

		const view = await sceneDraftFor(db, ownerId, quay);
		expect(view).toMatchObject({
			id: first,
			status: 'ready',
			sceneEmpty: true,
			inChapterRun: true
		});

		expect(await fillSceneFromDraft(db, ownerId, first)).toEqual({ ok: true, sceneId: quay });
		expect((await sceneRow(quay)).bodyMd).toBe('Draft 1. The river ran on.');
		// The others are untouched by that.
		expect(await statuses()).toEqual(['accepted', 'ready', 'ready']);
		expect((await sceneRow(crossing)).bodyMd).toBe('');

		const added = await addDraftAsScene(db, ownerId, second);
		if (!added.ok) throw new Error(added.reason);
		const order = (await storyScenes()).map((scene) => scene.id);
		expect(order).toEqual([quay, crossing, added.newSceneId, bank, later]);
		expect(await sceneRow(added.newSceneId)).toMatchObject({
			bodyMd: 'Draft 2. The river ran on.',
			status: 'draft',
			chapterId
		});
		expect((await sceneRow(crossing)).bodyMd).toBe('');

		expect(await discardSceneDraft(db, ownerId, third)).toEqual({ ok: true, stopJobId: null });
		expect(await statuses()).toEqual(['accepted', 'accepted', 'discarded']);
		expect((await sceneRow(bank)).bodyMd).toBe('');
	});

	it('refuses Fill when the scene gained prose since, and leaves that prose alone', async () => {
		const started = await request();
		await run(started);
		const saved = await saveSceneBody(db, crossing, {
			title: 'The Crossing',
			bodyMd: 'The writer got here first.',
			anchors: null,
			baseHashes: null,
			overwrite: true
		});
		expect(saved.ok).toBe(true);
		const result = await fillSceneFromDraft(db, ownerId, started.draftIds[1]);
		expect(result).toMatchObject({ ok: false, code: 'conflict' });
		expect((await sceneRow(crossing)).bodyMd).toBe('The writer got here first.');
		expect((await draftRows())[1].status).toBe('ready');
	});

	it("does nothing with another user's drafts", async () => {
		const started = await request();
		await run(started);
		const snapshot = await scenesSnapshot();
		for (const draftId of started.draftIds) {
			expect(await fillSceneFromDraft(db, strangerId, draftId)).toMatchObject({ ok: false });
			expect(await addDraftAsScene(db, strangerId, draftId)).toMatchObject({ ok: false });
			expect(await discardSceneDraft(db, strangerId, draftId)).toMatchObject({ ok: false });
		}
		expect(await sceneDraftFor(db, strangerId, quay)).toBeNull();
		expect(await statuses()).toEqual(['ready', 'ready', 'ready']);
		expect(await scenesSnapshot()).toEqual(snapshot);
	});

	it('does not offer a scene still waiting its turn to be kept', async () => {
		const started = await request();
		expect(await fillSceneFromDraft(db, ownerId, started.draftIds[2])).toMatchObject({
			ok: false,
			code: 'conflict'
		});
		expect(await addDraftAsScene(db, ownerId, started.draftIds[2])).toMatchObject({ ok: false });
	});
});

describe("reading a chapter's drafts back", () => {
	const scope = () => ({ userId: ownerId, storyId, chapterId });

	it('lists them in chapter order with the job while it runs, to their owner only', async () => {
		expect(await chapterDraftFor(db, scope())).toBeNull();
		const started = await request();
		expect(await chapterDraftFor(db, scope(), jobs.assistantDraftJobState)).toEqual({
			chapterId,
			chapterTitle: 'The River',
			jobId: started.jobId,
			scenes: [
				{
					draftId: started.draftIds[0],
					sceneId: quay,
					sceneTitle: 'The Quay',
					status: 'pending',
					note: null
				},
				{
					draftId: started.draftIds[1],
					sceneId: crossing,
					sceneTitle: 'The Crossing',
					status: 'pending',
					note: null
				},
				{
					draftId: started.draftIds[2],
					sceneId: bank,
					sceneTitle: 'The Far Bank',
					status: 'pending',
					note: null
				}
			]
		});
		expect(await chapterDraftFor(db, { ...scope(), userId: strangerId })).toBeNull();

		await run(started);
		const done = await chapterDraftFor(db, scope(), jobs.assistantDraftJobState);
		expect(done).toMatchObject({ jobId: null });
		expect(done!.scenes.map((scene) => scene.status)).toEqual(['ready', 'ready', 'ready']);
	});

	it('drops each scene as it is decided, and is gone when all are', async () => {
		const started = await request();
		await run(started);
		await fillSceneFromDraft(db, ownerId, started.draftIds[0]);
		await discardSceneDraft(db, ownerId, started.draftIds[1]);
		expect((await chapterDraftFor(db, scope()))!.scenes.map((scene) => scene.sceneId)).toEqual([
			bank
		]);
		await discardSceneDraft(db, ownerId, started.draftIds[2]);
		expect(await chapterDraftFor(db, scope())).toBeNull();
	});

	it('does not list a draft asked for one scene at a time', async () => {
		await requestSceneDraft(
			db,
			{ userId: ownerId, storyId, sceneId: quay, brief: 'b', targetWords: 500 },
			{ queue: jobs.queueAssistantDraft }
		);
		expect(await chapterDraftFor(db, scope())).toBeNull();
	});

	it('settles what a stopped job left before the worker noticed', async () => {
		const started = await request();
		await db
			.update(assistantDrafts)
			.set({ status: 'ready', textMd: 'Kept.' })
			.where(eq(assistantDrafts.id, started.draftIds[0]));
		jobs.assistantDraftJobState.mockResolvedValue('stopped');
		const view = await chapterDraftFor(db, scope(), jobs.assistantDraftJobState);
		expect(view).toMatchObject({ jobId: null, scenes: [{ sceneId: quay, status: 'ready' }] });
		expect(view!.scenes).toHaveLength(1);
		expect(await statuses()).toEqual(['ready', 'discarded', 'discarded']);
		// The queue was asked once for the job, not once a scene.
		expect(jobs.assistantDraftJobState).toHaveBeenCalledTimes(1);
	});
});
