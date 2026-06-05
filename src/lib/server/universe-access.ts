import { error } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import { db } from './db';
import { universes } from './db/schema';
import { isUuid } from '../slug';

// Loads a universe by id or slug, 404ing unless the user owns it. Shared by
// the universe routes. Slugs are unique per owner, so the session scopes the
// lookup; ids stay valid forever.
export async function ownedUniverse(ref: string, userId: string) {
	const byRef = isUuid(ref) ? eq(universes.id, ref) : eq(universes.slug, ref);
	const [universe] = await db
		.select()
		.from(universes)
		.where(and(byRef, eq(universes.ownerId, userId)));
	if (!universe) error(404, 'Universe not found');
	return universe;
}
