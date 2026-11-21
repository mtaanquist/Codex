import { eq } from 'drizzle-orm';
import type { Database } from '../auth.ts';
import { users } from '../db/schema.ts';
import { readSetting, writeSetting } from '../settings.ts';
import { revokeAllGrants } from './oauth.ts';

// The two switches for external access. The instance one is the admin's and
// is on unless turned off: with it off, the MCP endpoint and every OAuth route
// answer 404 and the account switch is hidden. The account one is each
// writer's own and starts off.

const INSTANCE_KEY = 'mcp';

export async function mcpInstanceEnabled(db: Database): Promise<boolean> {
	const stored = await readSetting<{ enabled?: boolean }>(db, INSTANCE_KEY);
	return stored?.enabled !== false;
}

export async function saveMcpInstanceEnabled(db: Database, enabled: boolean): Promise<void> {
	await writeSetting(db, INSTANCE_KEY, { enabled });
}

export async function mcpAccountEnabled(db: Database, userId: string): Promise<boolean> {
	const [row] = await db
		.select({ enabled: users.mcpEnabled })
		.from(users)
		.where(eq(users.id, userId));
	return row?.enabled === true;
}

// Turning the account switch off disconnects every app, so nothing is left
// waiting to work again by surprise when it is turned back on.
export async function setMcpAccountEnabled(
	db: Database,
	userId: string,
	enabled: boolean
): Promise<void> {
	await db.transaction(async (tx) => {
		await tx.update(users).set({ mcpEnabled: enabled }).where(eq(users.id, userId));
		if (!enabled) await revokeAllGrants(tx, userId);
	});
}
