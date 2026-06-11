import { eq, sql } from 'drizzle-orm';
import type { Database } from './auth';
import { stories, users } from './db/schema.ts';
import { mergePageSetup, type PageSetup } from '../page-setup.ts';
import { jsonbMergePatch } from './jsonb-patch.ts';

// Loading and saving print/PDF page setup. The worker reaches this when it
// generates edition artifacts, so relative value imports carry explicit
// .ts extensions and no $lib alias.

// The story's effective setup: the owner's account defaults with the
// story's overrides on top.
export async function storyPageSetup(db: Database, storyId: string): Promise<PageSetup> {
	const [row] = await db
		.select({ user: users.pageSetup, story: stories.pageSetup })
		.from(stories)
		.innerJoin(users, eq(stories.ownerId, users.id))
		.where(eq(stories.id, storyId));
	return mergePageSetup(
		(row?.user ?? {}) as Record<string, unknown>,
		(row?.story ?? {}) as Record<string, unknown>
	);
}

export async function userPageSetup(db: Database, userId: string): Promise<PageSetup> {
	const [row] = await db
		.select({ pageSetup: users.pageSetup })
		.from(users)
		.where(eq(users.id, userId));
	return mergePageSetup((row?.pageSetup ?? {}) as Record<string, unknown>, {});
}

// The story's raw overrides, for the settings form; an absent key means
// "use the account setting".
export async function storyPageSetupOverrides(
	db: Database,
	storyId: string
): Promise<Record<string, unknown>> {
	const [row] = await db
		.select({ pageSetup: stories.pageSetup })
		.from(stories)
		.where(eq(stories.id, storyId));
	return (row?.pageSetup ?? {}) as Record<string, unknown>;
}

export async function saveUserPageSetup(db: Database, userId: string, setup: Partial<PageSetup>) {
	await db
		.update(users)
		.set({ pageSetup: sql`${users.pageSetup} || ${JSON.stringify(setup)}::jsonb` })
		.where(eq(users.id, userId));
}

// Sets or clears a story's overrides: a value writes the key, null removes
// it so the story falls back to the account setting again.
export async function saveStoryPageSetup(
	db: Database,
	storyId: string,
	patch: Partial<Record<keyof PageSetup, string | number | boolean | null>>
) {
	await db
		.update(stories)
		.set({ pageSetup: jsonbMergePatch(stories.pageSetup, patch) })
		.where(eq(stories.id, storyId));
}
