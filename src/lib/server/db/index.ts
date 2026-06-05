import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env } from '$env/dynamic/private';
import * as schema from './schema';

const pool = new pg.Pool({ connectionString: env.DATABASE_URL });

export const db = drizzle(pool, { schema });

/** Whether a thrown database error is a unique-constraint violation. */
export function isUniqueViolation(err: unknown): boolean {
	return (err as { cause?: { code?: string } })?.cause?.code === '23505';
}
