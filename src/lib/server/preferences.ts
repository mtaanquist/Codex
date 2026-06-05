import { eq, sql, type SQL } from 'drizzle-orm';
import type { Database } from './auth';
import { stories, users } from './db/schema';
import type { AutocompleteMode } from '$lib/editor-autocomplete';
import {
	DEFAULT_ACCENT,
	DEFAULT_THEME,
	isTheme,
	normaliseAccent,
	type Theme
} from '$lib/appearance';

export type UserPreferences = {
	entityAutocomplete: AutocompleteMode;
	// Whether scene marks render inside the continuous story view's flow;
	// some authors treat scenes as atomic splits, not part of the reading.
	continuousSceneMarks: 'shown' | 'hidden';
	// Markdown shows the syntax as typed; rich hides it away from the
	// cursor, reading like formatted text. The stored document is markdown
	// either way.
	editingMode: 'markdown' | 'rich';
	// Browser-native spell-check squiggles in the prose editors.
	spellCheck: 'on' | 'off';
	// The language the prose is written in, as a BCP 47 tag, driving the
	// spell-check dictionary. Blank follows the browser's language.
	writingLanguage: string;
	// The colour theme and accent applied across the app.
	theme: Theme;
	accent: string;
};

// The editor-behaviour keys a story may override. Theme and accent stay
// account-wide: they style the whole app, not one story's editor.
export const STORY_PREFERENCE_KEYS = [
	'entityAutocomplete',
	'continuousSceneMarks',
	'editingMode',
	'spellCheck',
	'writingLanguage'
] as const;
export type StoryPreferenceKey = (typeof STORY_PREFERENCE_KEYS)[number];
// The raw per-story overrides, for the settings form; an absent key means
// "use the account setting".
export type StoryPreferenceOverrides = Partial<Pick<UserPreferences, StoryPreferenceKey>>;

// Defaults applied to whatever is stored; unknown values fall back rather
// than break old sessions when an option is renamed.
// A plausible BCP 47 tag ("da", "en-GB", "pt-BR"); anything else falls
// back to following the browser.
const LANGUAGE_TAG = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/;

function normalise(raw: Record<string, unknown>): UserPreferences {
	const mode = raw.entityAutocomplete;
	const marks = raw.continuousSceneMarks;
	return {
		entityAutocomplete: mode === 'ghost' || mode === 'off' ? mode : 'popup',
		continuousSceneMarks: marks === 'hidden' ? 'hidden' : 'shown',
		editingMode: raw.editingMode === 'rich' ? 'rich' : 'markdown',
		spellCheck: raw.spellCheck === 'off' ? 'off' : 'on',
		writingLanguage:
			typeof raw.writingLanguage === 'string' && LANGUAGE_TAG.test(raw.writingLanguage)
				? raw.writingLanguage
				: '',
		theme: isTheme(raw.theme) ? raw.theme : DEFAULT_THEME,
		accent: raw.accent === undefined ? DEFAULT_ACCENT : normaliseAccent(raw.accent)
	};
}

export async function userPreferences(db: Database, userId: string): Promise<UserPreferences> {
	const [row] = await db
		.select({ preferences: users.preferences })
		.from(users)
		.where(eq(users.id, userId));
	return normalise((row?.preferences ?? {}) as Record<string, unknown>);
}

// The story's raw overrides, restricted to the overridable keys so stray
// data in the column cannot leak into other preferences.
export async function storyPreferenceOverrides(
	db: Database,
	storyId: string
): Promise<Record<string, unknown>> {
	const [row] = await db
		.select({ preferences: stories.preferences })
		.from(stories)
		.where(eq(stories.id, storyId));
	const raw = (row?.preferences ?? {}) as Record<string, unknown>;
	return Object.fromEntries(
		STORY_PREFERENCE_KEYS.filter((key) => key in raw).map((key) => [key, raw[key]])
	);
}

// The effective preferences while working in a story: the user's, with the
// story's overrides on top.
export async function storyPreferences(
	db: Database,
	userId: string,
	storyId: string
): Promise<UserPreferences> {
	const [row] = await db
		.select({ preferences: users.preferences })
		.from(users)
		.where(eq(users.id, userId));
	const userRaw = (row?.preferences ?? {}) as Record<string, unknown>;
	const overrides = await storyPreferenceOverrides(db, storyId);
	return normalise({ ...userRaw, ...overrides });
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

// Sets or clears a story's overrides: a value writes the key, null removes
// it so the story falls back to the account setting again.
export async function saveStoryPreferences(
	db: Database,
	storyId: string,
	patch: Partial<Record<StoryPreferenceKey, string | null>>
) {
	const set: Record<string, string> = {};
	const clear: string[] = [];
	for (const key of STORY_PREFERENCE_KEYS) {
		const value = patch[key];
		if (value === undefined) continue;
		if (value === null) clear.push(key);
		else set[key] = value;
	}
	let expression: SQL = sql`${stories.preferences} || ${JSON.stringify(set)}::jsonb`;
	for (const key of clear) {
		expression = sql`(${expression}) - ${key}::text`;
	}
	await db.update(stories).set({ preferences: expression }).where(eq(stories.id, storyId));
}
