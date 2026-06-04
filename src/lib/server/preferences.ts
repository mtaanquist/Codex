import { eq, sql } from 'drizzle-orm';
import type { Database } from './auth';
import { users } from './db/schema';
import type { AutocompleteMode } from '$lib/editor-autocomplete';

export type UserPreferences = {
	entityAutocomplete: AutocompleteMode;
	// Whether scene marks render inside the continuous story view's flow;
	// some authors treat scenes as atomic splits, not part of the reading.
	continuousSceneMarks: 'shown' | 'hidden';
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
	const marks = raw.continuousSceneMarks;
	return {
		entityAutocomplete: mode === 'ghost' || mode === 'off' ? mode : 'popup',
		continuousSceneMarks: marks === 'hidden' ? 'hidden' : 'shown'
	};
}

export async function savePreferences(
	db: Database,
	userId: string,
	patch: Partial<UserPreferences>
) {
	// A jsonb merge, so unknown preference keys survive.
	await db
		.update(users)
		.set({
			preferences: sql`${users.preferences} || ${JSON.stringify(patch)}::jsonb`
		})
		.where(eq(users.id, userId));
}
