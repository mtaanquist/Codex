import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

// Migration 0080 turns each stored conversation (one per scope and user) into
// that scope's first chat. Runs on a database of its own, migrated up to 0079,
// seeded the old way, then taken through 0080.

const url = new URL(TEST_DATABASE_URL);
url.pathname = `${url.pathname}_chats_mig`;
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
	// The migrations folder as it stood before 0080.
	oldFolder = mkdtempSync(join(tmpdir(), 'codex-mig-'));
	cpSync('drizzle', oldFolder, { recursive: true });
	const journalPath = join(oldFolder, 'meta', '_journal.json');
	const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
	journal.entries = journal.entries.filter((e: { idx: number }) => e.idx < 80);
	writeFileSync(journalPath, JSON.stringify(journal));
	await migrate(drizzle(pool), { migrationsFolder: oldFolder });
	// A fresh database takes every migration from the start.
}, 60_000);

afterAll(async () => {
	await pool?.end();
	if (oldFolder) rmSync(oldFolder, { recursive: true, force: true });
});

describe('migration 0080 (assistant chats)', () => {
	it('backfills one chat per scope and user, titled from the first user turn', async () => {
		const q = (text: string, values: unknown[] = []) => pool.query(text, values);
		const user = (
			await q(
				`insert into users (email, display_name, password_hash, role)
				 values ('w@example.com', 'Wren', 'x', 'user') returning id`
			)
		).rows[0].id;
		const universe = (
			await q(`insert into universes (owner_id, name) values ($1, 'U') returning id`, [user])
		).rows[0].id;
		const story = (
			await q(
				`insert into stories (universe_id, owner_id, title) values ($1, $2, 'S') returning id`,
				[universe, user]
			)
		).rows[0].id;
		const turn = (scope: string, id: string, role: string, content: string, at: string) =>
			q(
				`insert into assistant_chat_messages (${scope}, user_id, role, content, created_at)
				 values ($1, $2, $3, $4, $5)`,
				[id, user, role, content, at]
			);
		await turn('story_id', story, 'assistant', 'Recap first.', '2026-11-01T10:00:00Z');
		await turn('story_id', story, 'user', 'Who  is\nMarra?', '2026-11-01T10:01:00Z');
		await turn('story_id', story, 'assistant', 'A sailor.', '2026-11-01T10:02:00Z');
		await turn('universe_id', universe, 'user', 'x'.repeat(80), '2026-11-02T09:00:00Z');
		await q(
			`insert into assistant_chat_summaries (story_id, user_id, summary, covered_digest)
			 values ($1, $2, 'sum', 'd')`,
			[story, user]
		);
		// A summary left behind by a cleared conversation has no turns to join.
		const otherStory = (
			await q(
				`insert into stories (universe_id, owner_id, title) values ($1, $2, 'T') returning id`,
				[universe, user]
			)
		).rows[0].id;
		await q(
			`insert into assistant_chat_summaries (story_id, user_id, summary, covered_digest)
			 values ($1, $2, 'orphan', 'd')`,
			[otherStory, user]
		);

		await migrate(drizzle(pool), { migrationsFolder: 'drizzle' });

		const chats = (
			await q(
				`select id, story_id, universe_id, title, created_at, updated_at
				 from assistant_chats order by title`
			)
		).rows;
		expect(chats).toHaveLength(2);
		const storyChat = chats.find((c) => c.story_id === story)!;
		const universeChat = chats.find((c) => c.universe_id === universe)!;
		expect(storyChat.title).toBe('Who is Marra?');
		expect(storyChat.created_at.toISOString()).toBe('2026-11-01T10:00:00.000Z');
		expect(storyChat.updated_at.toISOString()).toBe('2026-11-01T10:02:00.000Z');
		expect(universeChat.title).toBe('x'.repeat(57) + '...');

		const unlinked = await q(`select 1 from assistant_chat_messages where chat_id is null`);
		expect(unlinked.rowCount).toBe(0);
		const storyTurns = await q(`select 1 from assistant_chat_messages where chat_id = $1`, [
			storyChat.id
		]);
		expect(storyTurns.rowCount).toBe(3);
		const summaries = (await q(`select chat_id, summary from assistant_chat_summaries`)).rows;
		expect(summaries).toEqual([{ chat_id: storyChat.id, summary: 'sum' }]);
	}, 60_000);
});
