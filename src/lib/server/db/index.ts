import { drizzle } from 'drizzle-orm/node-postgres';
import { DATABASE_URL } from '$app/env/private';
import * as schema from './schema';
import { createPool } from './pool';

const pool = createPool(DATABASE_URL);

export const db = drizzle(pool, { schema });
