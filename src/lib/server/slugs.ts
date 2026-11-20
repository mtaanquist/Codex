import { and, eq, isNull, like } from 'drizzle-orm';
import type { Database } from './auth.ts';
import { isUniqueViolation } from './db-errors.ts';
import { stories, universes } from './db/schema.ts';
import { isUuid, slugify } from '../slug.ts';

// Suffix room: a deduped slug must still fit the column conventions.
const BASE_MAX = 55;

/**
 * A slug for a new universe or story, unique within the owner's account:
 * the slugified name, with -2, -3, ... appended when taken. Only live rows
 * hold a slug; one in the trash has freed it. The unique index is the real
 * guard; this just picks a free name.
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
		.where(
			and(eq(target.ownerId, ownerId), like(target.slug, `${base}%`), isNull(target.deletedAt))
		);
	const taken = new Set(rows.map((row) => row.slug));
	// A uuid-shaped base would be looked up as an id and never resolve, so it
	// always takes a suffix.
	if (!taken.has(base) && !isUuid(base)) return base;
	let n = 2;
	while (taken.has(`${base}-${n}`)) n++;
	return `${base}-${n}`;
}

/**
 * Takes a universe or story out of the trash. A live row may have claimed its
 * slug meanwhile; it then comes back under a fresh one picked from its name,
 * the same as a rename. Retries once if a concurrent write takes that pick.
 *
 * A restored story's scenes are older than the arcs and enrich marks written
 * while it was in the trash, so what they mention is marked for a fresh look
 * in the same transaction: restored content never looks current to the
 * Assistant. A universe needs no mark: nothing in it was read while it was in
 * the trash, and mention rebuilds kept marking what changed meanwhile. Each
 * attempt is its own transaction, since a unique violation aborts the one it
 * hits. The row is locked before the entities, as everywhere else.
 */
export async function untrash(db: Database, table: 'universes' | 'stories', id: string) {
	const [row] =
		table === 'universes'
			? await db
					.select({ ownerId: universes.ownerId, name: universes.name })
					.from(universes)
					.where(eq(universes.id, id))
			: await db
					.select({ ownerId: stories.ownerId, name: stories.title })
					.from(stories)
					.where(eq(stories.id, id));
	if (!row) return;
	const revive = (slug?: string) => {
		const values = slug ? { deletedAt: null, slug } : { deletedAt: null };
		return table === 'universes'
			? db.update(universes).set(values).where(eq(universes.id, id))
			: db.update(stories).set(values).where(eq(stories.id, id));
	};
	const fallback = table === 'universes' ? 'universe' : 'story';
	const fresh = () => uniqueSlug(db, table, row.ownerId, row.name, fallback);
	const attempts = [undefined, fresh, fresh];
	for (const [i, pick] of attempts.entries()) {
		try {
			const slug = pick && (await pick());
			await revive(slug);
			return;
		} catch (err) {
			if (!isUniqueViolation(err) || i === attempts.length - 1) throw err;
		}
	}
}
