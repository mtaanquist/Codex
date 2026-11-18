import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

// Migration 0083 marks what the old watermark rule found stale (a live
// mentioning scene changed after the arc was written or the entity read), so
// the re-reads pending at upgrade are not dropped. Runs on a database of its
// own, migrated up to 0082, seeded, then taken through 0083.

const url = new URL(TEST_DATABASE_URL);
url.pathname = `${url.pathname}_stale_mig`;
const DATABASE_URL = url.toString();

let pool: pg.Pool;
let oldFolder: string;

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

beforeAll(async () => {
	await resetDatabase();
	pool = new pg.Pool({ connectionString: DATABASE_URL });
	oldFolder = mkdtempSync(join(tmpdir(), 'codex-mig-'));
	cpSync('drizzle', oldFolder, { recursive: true });
	const journalPath = join(oldFolder, 'meta', '_journal.json');
	const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
	journal.entries = journal.entries.filter((e: { idx: number }) => e.idx < 83);
	writeFileSync(journalPath, JSON.stringify(journal));
	await migrate(drizzle(pool), { migrationsFolder: oldFolder });
}, 60_000);

afterAll(async () => {
	await pool?.end();
	if (oldFolder) rmSync(oldFolder, { recursive: true, force: true });
});

const WATERMARK = '2026-11-10T12:00:00Z';
const BEFORE = '2026-11-09T12:00:00Z';
const AFTER = '2026-11-11T12:00:00Z';

describe('migration 0083 (stale marks backfill)', () => {
	it('marks arcs and reads a changed live scene made stale, and nothing else', async () => {
		const q = async (text: string, values: unknown[] = []) => (await pool.query(text, values)).rows;
		const [{ id: user }] = await q(
			`insert into users (email, display_name, password_hash, role)
			 values ('w@example.com', 'Wren', 'x', 'user') returning id`
		);
		const universe = async (deleted = false) =>
			(
				await q(
					`insert into universes (owner_id, name, deleted_at) values ($1, 'U', $2) returning id`,
					[user, deleted ? AFTER : null]
				)
			)[0].id as string;
		const story = async (
			universeId: string,
			opts: { muted?: boolean; deleted?: boolean } = {}
		): Promise<string> =>
			(
				await q(
					`insert into stories (universe_id, owner_id, title, llm_config, deleted_at)
					 values ($1, $2, 'S', $3, $4) returning id`,
					[universeId, user, opts.muted ? { enabled: false } : {}, opts.deleted ? AFTER : null]
				)
			)[0].id;
		let position = 0;
		const scene = async (
			storyId: string,
			updatedAt: string,
			opts: { deleted?: boolean } = {}
		): Promise<string> =>
			(
				await q(
					`insert into scenes (story_id, global_position, body_md, updated_at, deleted_at)
					 values ($1, $2, 'Body.', $3, $4) returning id`,
					[storyId, ++position, updatedAt, opts.deleted ? AFTER : null]
				)
			)[0].id;
		const character = async (universeId: string, at: string | null = WATERMARK) =>
			(
				await q(
					`insert into characters (universe_id, owner_id, name, arc_summary_md, arc_summary_at, assistant_enriched_at)
					 values ($1, $2, 'C', 'Arc.', $3, $3) returning id`,
					[universeId, user, at]
				)
			)[0].id as string;
		const place = async (universeId: string) =>
			(
				await q(
					`insert into places (universe_id, owner_id, name, assistant_enriched_at)
					 values ($1, $2, 'P', $3) returning id`,
					[universeId, user, WATERMARK]
				)
			)[0].id as string;
		const lore = async (universeId: string) => {
			const [{ id: categoryId }] = await q(
				`insert into entity_categories (universe_id, owner_id, name, sort_order)
				 values ($1, $2, 'Lore', 0) returning id`,
				[universeId, user]
			);
			return (
				await q(
					`insert into lore_entries (universe_id, owner_id, category_id, title, assistant_enriched_at)
					 values ($1, $2, $3, 'L', $4) returning id`,
					[universeId, user, categoryId, WATERMARK]
				)
			)[0].id as string;
		};
		const mention = (sceneId: string, type: string, targetId: string) =>
			q(
				`insert into entity_mentions (source_type, source_id, target_type, target_id, position, surrounding_text)
				 values ('scene', $1, $2, $3, 0, 'x')`,
				[sceneId, type, targetId]
			);

		const live = await universe();
		const liveStory = await story(live);
		const changed = await scene(liveStory, AFTER);
		const unchanged = await scene(liveStory, BEFORE);

		// Stale under the old rule: a live mentioning scene changed after.
		const staleChar = await character(live);
		await mention(changed, 'character', staleChar);
		const stalePlace = await place(live);
		await mention(changed, 'place', stalePlace);
		const staleLore = await lore(live);
		await mention(changed, 'lore_entry', staleLore);

		// Not stale: the scene changed before the watermark.
		const freshChar = await character(live);
		await mention(unchanged, 'character', freshChar);
		const freshPlace = await place(live);
		await mention(unchanged, 'place', freshPlace);

		// Not stale: the changed scene is deleted, or in a muted or deleted story.
		const trashed = await scene(liveStory, AFTER, { deleted: true });
		const inTrashedScene = await character(live);
		await mention(trashed, 'character', inTrashedScene);
		const mutedScene = await scene(await story(live, { muted: true }), AFTER);
		const inMuted = await character(live);
		await mention(mutedScene, 'character', inMuted);
		const deletedStoryScene = await scene(await story(live, { deleted: true }), AFTER);
		const inDeletedStory = await character(live);
		await mention(deletedStoryScene, 'character', inDeletedStory);

		// Never written or read: nothing to mark.
		const never = await character(live, null);
		await mention(changed, 'character', never);

		// A universe in the trash: the old enrich pass skipped it, the arc did not.
		const trashedUniverse = await universe(true);
		const trashedStoryScene = await scene(await story(trashedUniverse), AFTER);
		const inTrashedUniverse = await character(trashedUniverse);
		await mention(trashedStoryScene, 'character', inTrashedUniverse);

		await migrate(drizzle(pool), { migrationsFolder: 'drizzle' });

		const marked = async (table: string, column: string, id: string) => {
			const [row] = await q(
				`select ${column} is not null and ${column} < '2000-01-01T00:00:00Z' as marked from ${table} where id = $1`,
				[id]
			);
			return row.marked as boolean;
		};
		expect(await marked('characters', 'arc_summary_at', staleChar)).toBe(true);
		expect(await marked('characters', 'assistant_enriched_at', staleChar)).toBe(true);
		expect(await marked('places', 'assistant_enriched_at', stalePlace)).toBe(true);
		expect(await marked('lore_entries', 'assistant_enriched_at', staleLore)).toBe(true);

		for (const id of [freshChar, inTrashedScene, inMuted, inDeletedStory, never]) {
			expect(await marked('characters', 'arc_summary_at', id)).toBe(false);
			expect(await marked('characters', 'assistant_enriched_at', id)).toBe(false);
		}
		expect(await marked('places', 'assistant_enriched_at', freshPlace)).toBe(false);
		expect(await marked('characters', 'arc_summary_at', inTrashedUniverse)).toBe(true);
		expect(await marked('characters', 'assistant_enriched_at', inTrashedUniverse)).toBe(false);

		// Nothing the writer sees as an edit: updated_at is left alone.
		const [{ n }] = await q(
			`select count(*)::int as n from characters where updated_at > now() - interval '1 minute' and id = $1 and updated_at <> created_at`,
			[staleChar]
		);
		expect(n).toBe(0);
	});
});
