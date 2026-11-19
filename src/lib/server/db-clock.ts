import { sql } from 'drizzle-orm';
import type { Database } from './auth.ts';

// Stored timestamps that are later compared with each other (updated_at,
// watermarks, generated-at and reviewed-at stamps) all come from the database
// clock, so a gap between the app server's and the database's clock can never
// order two writes the wrong way round. The app clock is for display, logs,
// and expiry windows only. See "One clock" in design.md.

/** The database's transaction time, at JS millisecond precision. */
export async function dbNow(db: Pick<Database, 'execute'>): Promise<Date> {
	const { rows } = await db.execute<{ now: Date | string }>(sql`select now() as now`);
	return new Date(rows[0].now);
}

/** The database's current time as text, at full microsecond precision: for a
 * stamp that is later compared in SQL (cast it back with ::timestamptz). */
export async function dbNowText(db: Pick<Database, 'execute'>): Promise<string> {
	const { rows } = await db.execute<{ now: string }>(sql`select clock_timestamp()::text as now`);
	return rows[0].now;
}
