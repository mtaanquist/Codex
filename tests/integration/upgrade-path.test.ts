import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import * as schema from '../../src/lib/server/db/schema';
import { chapters, characters, scenes } from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/auth';
import type { GatewayDeps } from '../../src/lib/server/llm/gateway';
import type { HttpRequest, Provider } from '../../src/lib/server/llm/providers/types';
import type { ReviewCategory } from '../../src/lib/review-shape';
import { LEGACY_ASSISTANT_REVIEW_QUEUE } from '../../src/lib/server/queues';
import { textHash } from '../../src/lib/text-hash';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

// The previous release's data, upgraded. A database of its own is migrated to
// where the last release left it (upgrade/previous-release.json), seeded with
// that release's row shapes (upgrade/seed.sql), migrated to head, and then put
// through what a writer does first after an upgrade: open, summarise, enrich,
// continue a capped review, export, save, restore from the trash. Nothing may
// be lost, asked of the model twice or started over. The fingerprints in the
// seed are the ones that release stored; a change to the wording of an arc or
// enrich prompt puts every stored one out of date, and fails this test. Refresh both fixture
// files when a release ships (see CLAUDE.md, Branches and releases).

process.env.APP_SECRET = process.env.APP_SECRET || 'upgrade-path-test-secret';

const { saveAccountLlmConfig } = await import('../../src/lib/server/llm/config');
const { summariseStory } = await import('../../src/lib/server/llm/summaries');
const { enrichUniverse } = await import('../../src/lib/server/llm/enrich');
const { planArc } = await import('../../src/lib/server/llm/arc-summary');
const { storySkeleton } = await import('../../src/lib/server/llm/context/sources');
const { adoptCappedRun, legacyReviewScopeKey, reviewScopeKey } =
	await import('../../src/lib/server/review-runs');
const { gatherStory } = await import('../../src/lib/server/export');
const { saveSceneBody } = await import('../../src/lib/server/scene-save');
const { restoreUniverse } = await import('../../src/lib/server/universe-lifecycle');
const { legacyJobCategories } = await import('../../src/worker/handlers');

const id = (suffix: string) => `00000000-0000-4000-8000-0000000000${suffix}`;
const USER = id('a1');
const HARBOUR = id('b1');
const OLD_WORLD = id('b2');
const TIDE = id('c1');
const BEFORE = id('c2');
const [QUAY, SALE, WAIT, LONG_AGO] = ['e1', 'e2', 'e3', 'e4'].map(id);
const MARA = id('f1');
const TAM = id('f2');
const NETS = id('d2');
const STORM = id('d3');
const LEGACY_JOB = id('aa');

const url = new URL(TEST_DATABASE_URL);
url.pathname = `${url.pathname}_upgrade`;
const DATABASE_URL = url.toString();

let pool: pg.Pool;
let db: Database;
let releaseFolder: string;
let calls: string[] = [];

const stub: Provider = {
	async *chatStream() {
		yield { type: 'done' };
	},
	async respond(req) {
		calls.push(req.messages.map((m) => m.content ?? '').join('\n'));
		return { content: `SUMMARY-${calls.length}`, toolCalls: [] };
	},
	async listModels() {
		return [];
	}
};
const noHttp: HttpRequest = async () => {
	throw new Error('the injected provider should not call the transport');
};
const deps: GatewayDeps = { provider: stub, http: noHttp };

// Every piece of the writer's text, by row.
async function writing(): Promise<Record<string, unknown>> {
	const { rows } = await pool.query(`
		select 'scene ' || id as row, title, body_md, summary_md from scenes
		union all select 'chapter ' || id, title, null, null from chapters
		union all select 'story ' || id, title, null, null from stories
		union all select 'universe ' || id, name, null, null from universes
		union all select 'character ' || id, name, body_md, arc_summary_md from characters
		order by row`);
	return Object.fromEntries(rows.map(({ row, ...rest }) => [row, rest]));
}

async function resetDatabase() {
	const admin = new URL(DATABASE_URL);
	const name = admin.pathname.slice(1);
	admin.pathname = '/postgres';
	const client = new pg.Client({ connectionString: admin.toString() });
	await client.connect();
	try {
		await client.query(`drop database if exists "${name}" with (force)`);
	} finally {
		await client.end();
	}
	await ensureTestDatabase(DATABASE_URL);
}

let before: Record<string, unknown>;

beforeAll(async () => {
	await resetDatabase();
	pool = new pg.Pool({ connectionString: DATABASE_URL });
	db = drizzle(pool, { schema });

	const release = JSON.parse(
		readFileSync(join(import.meta.dirname, 'upgrade', 'previous-release.json'), 'utf8')
	) as { version: string; migrations: number };
	releaseFolder = mkdtempSync(join(tmpdir(), 'codex-release-'));
	cpSync('drizzle', releaseFolder, { recursive: true });
	const journalPath = join(releaseFolder, 'meta', '_journal.json');
	const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
	journal.entries = journal.entries.slice(0, release.migrations);
	writeFileSync(journalPath, JSON.stringify(journal));
	await migrate(db, { migrationsFolder: releaseFolder });

	await pool.query(readFileSync(join(import.meta.dirname, 'upgrade', 'seed.sql'), 'utf8'));
	before = await writing();
	await migrate(db, { migrationsFolder: 'drizzle' });

	await saveAccountLlmConfig(db, USER, {
		enabled: true,
		assistantName: '',
		persona: 'balanced',
		endpoint: 'https://api.example.com/v1',
		apiKey: 'sk',
		models: { chat: 'chat-model' },
		toolCallBudget: 8
	});
}, 120_000);

afterAll(async () => {
	await pool?.end();
	if (releaseFolder) rmSync(releaseFolder, { recursive: true, force: true });
});

// One sequence, in the order a writer meets these after an upgrade: each step
// reads the state the one before it left.
describe('upgrading from the previous release', () => {
	it('keeps every piece of the writer text through the migrations', async () => {
		expect(await writing()).toEqual(before);
	});

	it('continues the capped review without reviewing its scenes again', async () => {
		// The job the capped run belonged to, as pg-boss holds it once done. The
		// worker reads what it checked from there.
		const boss = new PgBoss({ connectionString: DATABASE_URL, supervise: false, schedule: false });
		boss.on('error', (error) => console.error(error));
		await boss.start();
		try {
			await boss.createQueue(LEGACY_ASSISTANT_REVIEW_QUEUE);
			await boss.send(
				LEGACY_ASSISTANT_REVIEW_QUEUE,
				{ userId: USER, storyId: TIDE, categories: ['prose', 'mechanics'] },
				{ id: LEGACY_JOB }
			);
			await boss.fetch(LEGACY_ASSISTANT_REVIEW_QUEUE);
			await boss.complete(LEGACY_ASSISTANT_REVIEW_QUEUE, LEGACY_JOB);

			const scope = { storyId: TIDE, categories: ['mechanics', 'prose'] as ReviewCategory[] };
			const adopt = (categories: ReviewCategory[]) =>
				adoptCappedRun(db, {
					userId: USER,
					scope: reviewScopeKey({ ...scope, categories }),
					legacy: {
						scope: legacyReviewScopeKey(scope)!,
						categories,
						jobCategories: (jobId) => legacyJobCategories(boss, jobId)
					}
				});
			// A review of other categories does not take over the old run.
			expect(await adopt(['lore'])).toBeNull();
			const adopted = await adopt(scope.categories);
			expect(adopted?.completed).toEqual([QUAY, SALE]);
			expect(adopted?.notes).toBe(4);
		} finally {
			await boss.stop({ graceful: false });
		}
	});

	it('summarises only what has no summary or an out-of-date one, and keeps the writer summary', async () => {
		const chapterRows = async () =>
			Object.fromEntries(
				(
					await db
						.select({
							id: chapters.id,
							summaryMd: chapters.summaryMd,
							summaryInput: chapters.summaryInput
						})
						.from(chapters)
						.where(eq(chapters.storyId, TIDE))
				).map((row) => [row.id, row])
			);
		// Before any pass: the chapter summary that was current in the release
		// (under the stand-in fingerprint of migration 0094) is still read, the
		// one that was out of date is not.
		const outline = Object.fromEntries(
			(await storySkeleton(db, TIDE)).chapters.map((chapter) => [chapter.id, chapter.summaryMd])
		);
		expect(outline[NETS]).toBe('The nets are mended.');
		expect(outline[STORM]).toBeNull();

		calls = [];
		await summariseStory(db, { userId: USER, storyId: TIDE }, deps);
		const rows = await db
			.select({ id: scenes.id, summaryMd: scenes.summaryMd })
			.from(scenes)
			.where(eq(scenes.storyId, TIDE));
		const summary = Object.fromEntries(rows.map((row) => [row.id, row.summaryMd]));
		expect(summary[QUAY]).toBe('Mara arrives at low tide.');
		expect(summary[SALE]).toBe('My own summary.');
		expect(summary[WAIT]).toMatch(/^SUMMARY-/);
		const after = await chapterRows();
		// Kept as it was, now under a fingerprint of its request.
		expect(after[NETS].summaryMd).toBe('The nets are mended.');
		expect(after[NETS].summaryInput).toMatch(/^[0-9a-f]{64}$/);
		expect(after[STORM].summaryMd).toMatch(/^SUMMARY-/);
		// The scene without a summary, its chapter, and the chapter whose
		// summary was out of date.
		expect(calls).toHaveLength(3);

		calls = [];
		await summariseStory(db, { userId: USER, storyId: TIDE }, deps);
		expect(calls).toHaveLength(0);
	});

	it('keeps what the Assistant read and wrote of the entries, and re-reads only what was out of date', async () => {
		const row = async (characterId: string) =>
			(await db.select().from(characters).where(eq(characters.id, characterId)))[0];
		// An arc that was current is current, one that was out of date still is.
		// The upgrade itself asks the model nothing.
		expect((await planArc(db, { kind: 'character', entity: await row(MARA) }))!.stale).toBe(false);
		expect((await planArc(db, { kind: 'character', entity: await row(TAM) }))!.stale).toBe(true);
		// The stories each arc read come through as the release stored them.
		for (const characterId of [MARA, TAM])
			expect((await row(characterId)).arcSummaryStories).toEqual([TIDE]);

		const upgraded = { mara: await row(MARA), tam: await row(TAM) };
		calls = [];
		const result = await enrichUniverse(db, { userId: USER, universeId: HARBOUR }, deps);
		// Tam's read was out of date. Mara's was stored under the release's
		// fingerprint and the Quay's before fingerprints; neither is sent again.
		expect(calls).toHaveLength(1);
		expect(calls[0]).toContain('Enrich the character "Tam"');
		expect(result).toMatchObject({ entities: 1, unchanged: 2 });
		const mara = await row(MARA);
		expect(mara.assistantEnrichedAt).toEqual(upgraded.mara.assistantEnrichedAt);
		expect(mara.assistantEnrichedInput).not.toBe(upgraded.mara.assistantEnrichedInput);
		expect((await row(TAM)).assistantEnrichedAt!.getFullYear()).toBeGreaterThan(2000);

		calls = [];
		await enrichUniverse(db, { userId: USER, universeId: HARBOUR }, deps);
		expect(calls).toHaveLength(0);
	});

	it('exports every scene, including the one with the old line endings', async () => {
		const content = await gatherStory(db, {
			id: TIDE,
			title: 'The Long Tide',
			author: null,
			brief: null,
			descriptionMd: null
		});
		const text = content.scenes.map((scene) => scene.bodyMd).join('\n');
		for (const line of [
			'Mara reached the quay.',
			'The tide was out.',
			'Mara sold the boat to Tam.'
		])
			expect(text).toContain(line);
		expect(content.scenes).toHaveLength(5);
	});

	it('saves an edit to a scene with the old line endings', async () => {
		const [quay] = await db
			.select({ bodyMd: scenes.bodyMd })
			.from(scenes)
			.where(eq(scenes.id, QUAY));
		const result = await saveSceneBody(db, QUAY, {
			title: 'Quay',
			bodyMd: 'Mara reached the quay.\n\nThe tide was out. Gulls.',
			anchors: null,
			baseHashes: [textHash(quay.bodyMd)],
			overwrite: false
		});
		expect(result.ok).toBe(true);
	});

	it('restores the universe trashed before the upgrade, whole', async () => {
		expect(await restoreUniverse(db, USER, OLD_WORLD)).toBe(true);
		const { rows } = await pool.query(
			`select s.title, sc.id, sc.body_md from stories s join scenes sc on sc.story_id = s.id
			 where s.id = $1 and s.deleted_at is null`,
			[BEFORE]
		);
		expect(rows).toEqual([{ title: 'Before', id: LONG_AGO, body_md: 'An older story.' }]);
	});
});
