import { eq, sql } from 'drizzle-orm';
import type { Database } from './auth';
import { users } from './db/schema';
import type { AutocompleteMode } from '$lib/editor-autocomplete';

export type UserPreferences = {
	entityAutocomplete: AutocompleteMode;
};

// The user's preferences with defaults applied; unknown values fall back
// rather than break old sessions when an option is renamed.
export async function userPreferences(db: Database, userId: string): Promise<UserPreferences> {
	const [row] = await db
		.select({ preferences: users.preferences })
		.from(users)
		.where(eq(users.id, userId));
	const raw = (row?.preferences ?? {}) as Record<string, unknown>;
	const mode = raw.entityAutocomplete;
	return { entityAutocomplete: mode === 'ghost' || mode === 'off' ? mode : 'popup' };
}

export async function saveEntityAutocomplete(db: Database, userId: string, mode: AutocompleteMode) {
	// A jsonb merge, so other preference keys survive.
	await db
		.update(users)
		.set({
			preferences: sql`${users.preferences} || ${JSON.stringify({ entityAutocomplete: mode })}::jsonb`
		})
		.where(eq(users.id, userId));
}
