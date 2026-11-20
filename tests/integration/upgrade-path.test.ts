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
import { characters, scenes } from '../../src/lib/server/db/schema';
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
// be lost, asked of the model twice or started over. Refresh both fixture
// files when a release ships (see CLAUDE.md, Branches and releases).

process.env.APP_SECRET = process.env.APP_SECRET || 'upgrade-path-test-secret';

const { saveAccountLlmConfig } = await import('../../src/lib/server/llm/config');
const { summariseStory } = await import('../../src/lib/server/llm/summaries');
const { enrichUniverse } = await import('../../src/lib/server/llm/enrich');
const { planArc } = await import('../../src/lib/server/llm/arc-summary');
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

	it('summarises only what has no summary, and keeps the writer summary', async () => {
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
		// The scene without a summary, then its chapter.
		expect(calls).toHaveLength(2);
	});

	it('re-reads what was out of date before the upgrade, and nothing else', async () => {
		const stamps = async () => {
			const rows = await db
				.select({
					id: characters.id,
					arcSummaryAt: characters.arcSummaryAt,
					enrichedAt: characters.assistantEnrichedAt
				})
				.from(characters);
			return Object.fromEntries(rows.map((row) => [row.id, row]));
		};
		const upgraded = await stamps();
		// Arcs from before fingerprints were stored read as out of date until the
		// writer refreshes them; the upgrade itself asks the model nothing.
		for (const characterId of [MARA, TAM]) {
			const [entity] = await db.select().from(characters).where(eq(characters.id, characterId));
			expect((await planArc(db, { kind: 'character', entity }))!.stale).toBe(true);
		}

		calls = [];
		await enrichUniverse(db, { userId: USER, universeId: HARBOUR }, deps);
		expect(calls.length).toBeGreaterThan(0);
		const after = await stamps();
		expect(after[MARA].enrichedAt).toEqual(upgraded[MARA].enrichedAt);
		expect(after[TAM].enrichedAt!.getTime()).toBeGreaterThan(upgraded[TAM].enrichedAt!.getTime());
		expect(after[TAM].enrichedAt!.getFullYear()).toBeGreaterThan(2000);
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
		expect(content.scenes).toHaveLength(3);
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
