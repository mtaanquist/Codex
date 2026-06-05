import { and, eq, like } from 'drizzle-orm';
import type { Database } from './auth';
import { stories, universes } from './db/schema';
import { isUuid, isValidSlug, slugify } from '../slug';

// Suffix room: a deduped slug must still fit the column conventions.
const BASE_MAX = 55;

const NOUN = { universes: 'universe', stories: 'story' } as const;

/** The user-facing message when a slug is already in use. */
export function slugTakenMessage(table: 'universes' | 'stories'): string {
	return `Another ${NOUN[table]} already uses that slug.`;
}

/**
 * A slug for a new universe or story, unique within the owner's account:
 * the slugified name, with -2, -3, ... appended when taken. The unique
 * index is the real guard; this just picks a free name.
 */
export async function uniqueSlug(
	db: Database,
	table: 'universes' | 'stories',
	ownerId: string,
	name: string,
	fallback: string
): Promise<string> {
	const base = slugify(name, fallback).slice(0, BASE_MAX).replace(/-+$/, '') || fallback;
	const target = table === 'universes' ? universes : stories;
	const rows = await db
		.select({ slug: target.slug })
		.from(target)
		.where(and(eq(target.ownerId, ownerId), like(target.slug, `${base}%`)));
	const taken = new Set(rows.map((row) => row.slug));
	// A uuid-shaped base would be looked up as an id and never resolve, so it
	// always takes a suffix.
	if (!taken.has(base) && !isUuid(base)) return base;
	let n = 2;
	while (taken.has(`${base}-${n}`)) n++;
	return `${base}-${n}`;
}

/** Whether the owner already uses this slug on another row of the table. */
export async function slugTaken(
	db: Database,
	table: 'universes' | 'stories',
	ownerId: string,
	slug: string,
	excludeId: string
): Promise<boolean> {
	const target = table === 'universes' ? universes : stories;
	const rows = await db
		.select({ id: target.id })
		.from(target)
		.where(and(eq(target.ownerId, ownerId), eq(target.slug, slug)));
	return rows.some((row) => row.id !== excludeId);
}

/**
 * Validates a slug edit from a settings form. Returns the message to show
 * the user, or null when the slug is fine to save.
 */
export async function slugChangeError(
	db: Database,
	table: 'universes' | 'stories',
	ownerId: string,
	slug: string,
	current: string,
	excludeId: string
): Promise<string | null> {
	if (!isValidSlug(slug)) {
		return 'The slug can only use lowercase letters, numbers, and hyphens.';
	}
	if (slug !== current && (await slugTaken(db, table, ownerId, slug, excludeId))) {
		return slugTakenMessage(table);
	}
	return null;
}
