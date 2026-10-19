import { drizzle } from 'drizzle-orm/node-postgres';
import { env } from '$env/dynamic/private';
import * as schema from './schema';
import { createPool } from './pool';

const pool = createPool(env.DATABASE_URL);

export const db = drizzle(pool, { schema });
