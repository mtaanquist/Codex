import { eq, sql } from 'drizzle-orm';
import { jsonbMergePatch } from './jsonb-patch.ts';
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
import { NOTIFICATION_KINDS, type NotificationMatrix } from '$lib/notifications';

export type UserPreferences = {
	entityAutocomplete: AutocompleteMode;
	// Whether scene marks render inside the continuous story view's flow;
	// some authors treat scenes as atomic splits, not part of the reading.
	continuousSceneMarks: 'shown' | 'hidden';
	// Markdown shows the syntax as typed; rich hides it away from the
	// cursor, reading like formatted text. The stored document is markdown
	// either way.
	editingMode: 'markdown' | 'rich';
	// Spaces, paragraph breaks, and soft line breaks shown as faint glyphs in
	// the prose editors. Toggled from the formatting toolbar.
	nonPrintingMarks: 'shown' | 'hidden';
	// The command markers that ride in the prose (\center, \right, \justify,
	// \indent): hidden (the default) tucks them away except on the line being
	// edited, so the page reads as the finished formatting; shown dims them in
	// place. Click to show, like the non-printing marks.
	commandMarkers: 'shown' | 'hidden';
	// Browser-native spell-check squiggles in the prose editors.
	spellCheck: 'on' | 'off';
	// The language the prose is written in, as a BCP 47 tag, driving the
	// spell-check dictionary. Blank follows the browser's language.
	writingLanguage: string;
	// The Session pane's streak card; not everyone wants the scorekeeping.
	sessionStreak: 'shown' | 'hidden';
	// A daily word target. 0 means no goal; the Session pane and Insights show
	// progress toward it when set.
	dailyWordGoal: number;
	// Per-kind notification channels (the bell and the email digest), both
	// on unless turned off.
	notifications: NotificationMatrix;
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
		// Rich is the default: markdown renders formatted with the syntax
		// hidden away from the cursor, which is what most writers expect.
		editingMode: raw.editingMode === 'markdown' ? 'markdown' : 'rich',
		// Off by default; the writer turns these on when they want to see them.
		nonPrintingMarks: raw.nonPrintingMarks === 'shown' ? 'shown' : 'hidden',
		// Hidden by default; the writer clicks to reveal the markers.
		commandMarkers: raw.commandMarkers === 'shown' ? 'shown' : 'hidden',
		spellCheck: raw.spellCheck === 'off' ? 'off' : 'on',
		writingLanguage:
			typeof raw.writingLanguage === 'string' && LANGUAGE_TAG.test(raw.writingLanguage)
				? raw.writingLanguage
				: '',
		sessionStreak: raw.sessionStreak === 'hidden' ? 'hidden' : 'shown',
		dailyWordGoal: normaliseWordGoal(raw.dailyWordGoal),
		notifications: normaliseNotifications(raw.notifications),
		theme: isTheme(raw.theme) ? raw.theme : DEFAULT_THEME,
		accent: raw.accent === undefined ? DEFAULT_ACCENT : normaliseAccent(raw.accent)
	};
}

// A non-negative whole number of words, capped at a sane ceiling; anything
// else means no goal (0).
const MAX_WORD_GOAL = 100_000;
function normaliseWordGoal(raw: unknown): number {
	if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return 0;
	return Math.min(Math.floor(raw), MAX_WORD_GOAL);
}

// Both channels default on; only a stored false turns one off. Exported
// for the fan-out, which reads many users' raw preferences in one query.
export function normaliseNotifications(raw: unknown): NotificationMatrix {
	const stored = (raw ?? {}) as Record<string, { inApp?: unknown; email?: unknown }>;
	return Object.fromEntries(
		NOTIFICATION_KINDS.map((kind) => [
			kind,
			{ inApp: stored[kind]?.inApp !== false, email: stored[kind]?.email !== false }
		])
	) as NotificationMatrix;
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
	// Only the known override keys reach the jsonb patch.
	const filtered = Object.fromEntries(
		STORY_PREFERENCE_KEYS.filter((key) => patch[key] !== undefined).map((key) => [key, patch[key]])
	);
	await db
		.update(stories)
		.set({ preferences: jsonbMergePatch(stories.preferences, filtered) })
		.where(eq(stories.id, storyId));
}
