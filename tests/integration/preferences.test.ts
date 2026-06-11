import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import { stories, universes, users } from '../../src/lib/server/db/schema';
import {
	savePreferences,
	saveStoryPreferences,
	storyPreferenceOverrides,
	storyPreferences,
	userPreferences
} from '../../src/lib/server/preferences';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

let pool: pg.Pool;
let db: Database;
let userId: string;
let storyId: string;

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await pool.query('truncate table users cascade');
	const [user] = await db
		.insert(users)
		.values({ email: 'prefs@example.com', displayName: 'P', passwordHash: 'x', role: 'user' })
		.returning({ id: users.id });
	userId = user.id;
	const [universe] = await db
		.insert(universes)
		.values({ ownerId: userId, name: 'U' })
		.returning({ id: universes.id });
	const [story] = await db
		.insert(stories)
		.values({ universeId: universe.id, ownerId: userId, title: 'S' })
		.returning({ id: stories.id });
	storyId = story.id;
});

afterAll(async () => {
	await pool.end();
});

describe('appearance preferences', () => {
	it('defaults to the system theme and the default accent', async () => {
		const prefs = await userPreferences(db, userId);
		expect(prefs.theme).toBe('system');
		expect(prefs.accent).toBe('#5b8cff');
		// The editor defaults are untouched.
		expect(prefs.entityAutocomplete).toBe('popup');
		expect(prefs.continuousSceneMarks).toBe('shown');
	});

	it('defaults the editor view toggles and round-trips a change', async () => {
		let prefs = await userPreferences(db, userId);
		// Both marks start hidden; the writer clicks to show them.
		expect(prefs.nonPrintingMarks).toBe('hidden');
		expect(prefs.commandMarkers).toBe('hidden');

		await savePreferences(db, userId, { nonPrintingMarks: 'shown', commandMarkers: 'shown' });
		prefs = await userPreferences(db, userId);
		expect(prefs.nonPrintingMarks).toBe('shown');
		expect(prefs.commandMarkers).toBe('shown');
	});

	it('round-trips theme and accent without disturbing other keys', async () => {
		await savePreferences(db, userId, { entityAutocomplete: 'ghost' });
		await savePreferences(db, userId, { theme: 'dark', accent: '#2fae8c' });
		const prefs = await userPreferences(db, userId);
		expect(prefs.theme).toBe('dark');
		expect(prefs.accent).toBe('#2fae8c');
		// The jsonb merge kept the earlier autocomplete choice.
		expect(prefs.entityAutocomplete).toBe('ghost');
	});

	it('falls back when a stored value is unrecognised', async () => {
		await db
			.update(users)
			.set({ preferences: { theme: 'neon', accent: 'chartreuse' } })
			.where(eq(users.id, userId));
		const prefs = await userPreferences(db, userId);
		expect(prefs.theme).toBe('system');
		expect(prefs.accent).toBe('#5b8cff');
	});
});

describe('editor appearance preferences', () => {
	it('defaults the writing font and line spacing', async () => {
		const prefs = await userPreferences(db, userId);
		expect(prefs.editorFont).toBe('default');
		expect(prefs.editorFontCustom).toBe('');
		expect(prefs.editorLineSpacing).toBe('normal');
		expect(prefs.editorLineSpacingCm).toBe(0.7);
	});

	it('round-trips a custom writing font and line spacing, sanitising and clamping', async () => {
		await savePreferences(db, userId, {
			editorFont: 'custom',
			editorFontCustom: '  EB Garamond  ',
			editorLineSpacing: 'custom',
			editorLineSpacingCm: 5
		});
		const prefs = await userPreferences(db, userId);
		expect(prefs.editorFont).toBe('custom');
		expect(prefs.editorFontCustom).toBe('EB Garamond');
		expect(prefs.editorLineSpacing).toBe('custom');
		// Out-of-range centimetres clamp to the allowed maximum.
		expect(prefs.editorLineSpacingCm).toBe(2);
	});

	it('falls back when a stored writing font is unrecognised', async () => {
		await db
			.update(users)
			.set({ preferences: { editorFont: 'wingdings', editorLineSpacing: 'triple' } })
			.where(eq(users.id, userId));
		const prefs = await userPreferences(db, userId);
		expect(prefs.editorFont).toBe('default');
		expect(prefs.editorLineSpacing).toBe('normal');
	});
});

describe('story preference overrides', () => {
	it('a story override wins over the account setting', async () => {
		await savePreferences(db, userId, { entityAutocomplete: 'ghost' });
		await saveStoryPreferences(db, storyId, { entityAutocomplete: 'off' });
		const prefs = await storyPreferences(db, userId, storyId);
		expect(prefs.entityAutocomplete).toBe('off');
		// Keys without an override fall through to the account.
		expect(prefs.continuousSceneMarks).toBe('shown');
	});

	it('clearing an override falls back to the account setting again', async () => {
		await savePreferences(db, userId, { continuousSceneMarks: 'hidden' });
		await saveStoryPreferences(db, storyId, { continuousSceneMarks: 'shown' });
		expect((await storyPreferences(db, userId, storyId)).continuousSceneMarks).toBe('shown');

		await saveStoryPreferences(db, storyId, { continuousSceneMarks: null });
		expect((await storyPreferences(db, userId, storyId)).continuousSceneMarks).toBe('hidden');
		expect(await storyPreferenceOverrides(db, storyId)).toEqual({});
	});

	it('a partial save leaves the other override alone', async () => {
		await saveStoryPreferences(db, storyId, {
			entityAutocomplete: 'ghost',
			continuousSceneMarks: 'hidden'
		});
		await saveStoryPreferences(db, storyId, { entityAutocomplete: null });
		expect(await storyPreferenceOverrides(db, storyId)).toEqual({
			continuousSceneMarks: 'hidden'
		});
	});

	it('only editor-behaviour keys can override; theme in story data is ignored', async () => {
		await db
			.update(stories)
			.set({ preferences: { theme: 'dark', entityAutocomplete: 'off' } })
			.where(eq(stories.id, storyId));
		const prefs = await storyPreferences(db, userId, storyId);
		expect(prefs.entityAutocomplete).toBe('off');
		// The account theme stands; the story column cannot restyle the app.
		expect(prefs.theme).toBe('system');
		expect(await storyPreferenceOverrides(db, storyId)).toEqual({ entityAutocomplete: 'off' });
	});

	it('the editing mode layers like the other editor keys', async () => {
		// Rich is the default; raw markdown is the opt-in.
		expect((await userPreferences(db, userId)).editingMode).toBe('rich');
		await savePreferences(db, userId, { editingMode: 'markdown' });
		expect((await storyPreferences(db, userId, storyId)).editingMode).toBe('markdown');
		await saveStoryPreferences(db, storyId, { editingMode: 'rich' });
		expect((await storyPreferences(db, userId, storyId)).editingMode).toBe('rich');
		await saveStoryPreferences(db, storyId, { editingMode: null });
		expect((await storyPreferences(db, userId, storyId)).editingMode).toBe('markdown');
	});

	it('spell-check and writing language layer, with browser-follow as a real override', async () => {
		const defaults = await userPreferences(db, userId);
		expect(defaults.spellCheck).toBe('on');
		expect(defaults.writingLanguage).toBe('');

		await savePreferences(db, userId, { spellCheck: 'off', writingLanguage: 'da' });
		expect((await storyPreferences(db, userId, storyId)).writingLanguage).toBe('da');

		// One story written in English with squiggles back on.
		await saveStoryPreferences(db, storyId, { spellCheck: 'on', writingLanguage: 'en-GB' });
		const merged = await storyPreferences(db, userId, storyId);
		expect(merged.spellCheck).toBe('on');
		expect(merged.writingLanguage).toBe('en-GB');

		// An explicit follow-the-browser override beats the account language.
		await saveStoryPreferences(db, storyId, { writingLanguage: '' });
		expect((await storyPreferences(db, userId, storyId)).writingLanguage).toBe('');
		// Clearing the override falls back to the account language.
		await saveStoryPreferences(db, storyId, { writingLanguage: null });
		expect((await storyPreferences(db, userId, storyId)).writingLanguage).toBe('da');
	});

	it('a malformed language tag falls back to following the browser', async () => {
		await savePreferences(db, userId, { writingLanguage: 'not a tag' });
		expect((await userPreferences(db, userId)).writingLanguage).toBe('');
	});

	it('defaults the daily word goal to none and clamps a saved one', async () => {
		expect((await userPreferences(db, userId)).dailyWordGoal).toBe(0);
		await savePreferences(db, userId, { dailyWordGoal: 750 });
		expect((await userPreferences(db, userId)).dailyWordGoal).toBe(750);
		// A negative or absurd value falls back to no goal / the ceiling.
		await savePreferences(db, userId, { dailyWordGoal: -5 });
		expect((await userPreferences(db, userId)).dailyWordGoal).toBe(0);
		await savePreferences(db, userId, { dailyWordGoal: 9_999_999 });
		expect((await userPreferences(db, userId)).dailyWordGoal).toBe(100_000);
	});

	it('an unrecognised override value falls back to a sane default', async () => {
		await db
			.update(stories)
			.set({ preferences: { entityAutocomplete: 'telepathy' } })
			.where(eq(stories.id, storyId));
		expect((await storyPreferences(db, userId, storyId)).entityAutocomplete).toBe('popup');
	});
});
