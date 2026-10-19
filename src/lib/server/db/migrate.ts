import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

// Imported by scripts/migrate.ts under plain Node, so relative imports only.

type JournalEntry = { tag: string; when: number };

// Drizzle applies only migrations whose `when` is newer than the last applied
// one, so an entry that does not sort after its predecessor (a branch generated
// before another one merged) would be skipped without a word in production.
export function outOfOrderMigrations(entries: JournalEntry[]): string[] {
	const bad: string[] = [];
	for (let i = 1; i < entries.length; i++) {
		if (entries[i].when <= entries[i - 1].when) bad.push(entries[i].tag);
	}
	return bad;
}

export function readJournal(migrationsFolder: string): JournalEntry[] {
	const raw = readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8');
	return (JSON.parse(raw) as { entries: JournalEntry[] }).entries;
}

// Applies pending migrations while holding a session advisory lock, so the app
// and worker (or several replicas) starting together apply each migration once:
// drizzle reads the last applied row outside its transaction and takes no lock.
export async function runMigrations(connectionString: string, migrationsFolder = 'drizzle') {
	const bad = outOfOrderMigrations(readJournal(migrationsFolder));
	if (bad.length > 0) {
		throw new Error(
			`Migrations out of order in the journal (their "when" is not after the previous entry): ${bad.join(', ')}. Regenerate them so they sort last.`
		);
	}
	const client = new pg.Client({ connectionString });
	await client.connect();
	try {
		await client.query(`select pg_advisory_lock(hashtext('codex:migrations'))`);
		await migrate(drizzle(client), { migrationsFolder });
	} finally {
		// Ending the session releases the lock, also when migrate threw.
		await client.end();
	}
}
